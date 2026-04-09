const axios = require('axios')
const env = require('../config/env')
const logger = require('../config/logger')
const db = require('../config/db')

const DEEPSEEK_API_URL = 'https://api.deepseek.com/v1/chat/completions'
const DEEPSEEK_TIMEOUT_MS = parseInt(env.DEEPSEEK_TIMEOUT_MS || '120000') || 120000
const DEEPSEEK_MAX_RETRIES = parseInt(env.DEEPSEEK_MAX_RETRIES || '3') || 3
const DEEPSEEK_RETRY_BASE_MS = parseInt(env.DEEPSEEK_RETRY_BASE_MS || '1000') || 1000

// Provider routing: claude models go to Anthropic Bedrock, else DeepSeek
function _isAnthropicModel(model) { return model.startsWith('claude-') || model.includes('anthropic.claude') }

// Lazy-init Bedrock client — only created when first needed
let _bedrockClient = null
function _getBedrockClient() {
  if (!_bedrockClient) {
    const { AnthropicBedrock } = require('@anthropic-ai/bedrock-sdk')
    _bedrockClient = new AnthropicBedrock({
      awsAccessKey: env.AWS_ACCESS_KEY_ID,
      awsSecretKey: env.AWS_SECRET_ACCESS_KEY,
      awsRegion: env.AWS_REGION || 'us-east-1',
    })
  }
  return _bedrockClient
}

// ─── Budget circuit breaker ───────────────────────────────────────────
// DEEPSEEK_MONTHLY_BUDGET_AUD in env (0 = unlimited, which is the default).
// Tracks spend in-memory + DB. Rejects calls once the monthly ceiling is hit.
// Cost formula: deepseek-chat prompt=$0.14/1M tokens, completion=$0.28/1M tokens.
// AUD conversion: ~1.55× USD at time of writing — hardcoded conservatively.

const MONTHLY_BUDGET_AUD = parseFloat(env.DEEPSEEK_MONTHLY_BUDGET_AUD || '0') || 0
const USD_TO_AUD = parseFloat(env.USD_TO_AUD || '1.55') || 1.55

let _budgetCache = null  // { month: 'YYYY-MM', spentUSD: number, checkedAt: number }
let _budgetCheckInFlight = null  // dedup concurrent budget checks

async function checkBudget() {
  if (MONTHLY_BUDGET_AUD <= 0) return  // unlimited

  const now = new Date()
  const month = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`

  // Re-query at most once per minute — dedup concurrent checks
  if (!_budgetCache || _budgetCache.month !== month || Date.now() - _budgetCache.checkedAt > 60_000) {
    if (!_budgetCheckInFlight) {
      _budgetCheckInFlight = db`
        SELECT COALESCE(SUM(cost_usd), 0)::float AS spent
        FROM claude_usage
        WHERE date_trunc('month', created_at) = date_trunc('month', now())
      `.then(([row]) => {
        _budgetCache = { month, spentUSD: row?.spent ?? 0, checkedAt: Date.now() }
      }).catch(err => {
        logger.debug('Budget check DB query failed', { error: err.message })
      }).finally(() => {
        _budgetCheckInFlight = null
      })
    }
    await _budgetCheckInFlight
    if (!_budgetCache) return  // DB failed, don't block
  }

  if (!_budgetCache) return  // DB check failed, don't block

  const spentAUD = _budgetCache.spentUSD * USD_TO_AUD
  if (spentAUD >= MONTHLY_BUDGET_AUD) {
    logger.warn(`DeepSeek budget exhausted — ${spentAUD.toFixed(2)} AUD spent of ${MONTHLY_BUDGET_AUD} AUD monthly limit`)
    throw new Error(`DeepSeek monthly budget exhausted (${spentAUD.toFixed(2)} / ${MONTHLY_BUDGET_AUD} AUD). Set DEEPSEEK_MONTHLY_BUDGET_AUD=0 to disable or increase the limit.`)
  }

  const warningFraction = parseFloat(env.DEEPSEEK_BUDGET_WARNING_FRACTION || '0.8') || 0.8
  if (warningFraction > 0 && spentAUD >= MONTHLY_BUDGET_AUD * warningFraction) {
    logger.warn(`DeepSeek budget warning — ${spentAUD.toFixed(2)} AUD of ${MONTHLY_BUDGET_AUD} AUD used (${Math.round(spentAUD / MONTHLY_BUDGET_AUD * 100)}%)`)
  }
}

// ═══════════════════════════════════════════════════════════════════════
// UNIVERSAL KG-AWARE LLM LAYER
//
// Every LLM call goes through this function. It automatically:
//   1. RETRIEVES — pulls relevant KG context via semantic search + trace
//   2. INJECTS — adds context as a system message
//   3. EXECUTES — calls DeepSeek
//   4. LOGS — ingests the input + output back into the KG
//
// Callers just pass contextQuery (what to search the graph for) and
// the system handles the rest. The graph grows with every call.
// ═══════════════════════════════════════════════════════════════════════

let _kgService = null
let _kgHooks = null

function getKG() {
  if (!_kgService) {
    try {
      _kgService = require('./knowledgeGraphService')
      _kgHooks = require('./kgIngestionHooks')
    } catch {
      _kgService = null
      _kgHooks = null
    }
  }
  return { kg: _kgService, hooks: _kgHooks }
}

async function callDeepSeek(messages, {
  module = 'general',
  model = 'claude-haiku-4-5-20251001',
  contextQuery = null,       // what to search the KG for (string)
  skipRetrieval = false,     // skip KG retrieval (for KG ingestion calls to avoid loops)
  skipLogging = false,       // skip KG logging (for KG ingestion calls)
  sourceId = null,           // source entity ID for KG logging
  temperature = null,        // null = provider default (no override)
} = {}) {
  // ─── 0. BUDGET: Reject if monthly ceiling hit ─────────────────────
  await checkBudget()

  const start = Date.now()
  const { kg } = getKG()

  // ─── 1. RETRIEVE: Pull KG context ──────────────────────────────────
  let kgContext = null
  if (!skipRetrieval && contextQuery && kg && env.NEO4J_URI && env.OPENAI_API_KEY) {
    try {
      const ctx = await kg.getContext(contextQuery, {
        maxSeeds: parseInt(env.DEEPSEEK_KG_MAX_SEEDS || '15'),
        maxDepth: parseInt(env.DEEPSEEK_KG_MAX_DEPTH || '5'),
        minSimilarity: parseFloat(env.DEEPSEEK_KG_MIN_SIMILARITY || '0.4'),
      })
      if (ctx.summary) {
        kgContext = ctx.summary
      }
    } catch (err) {
      logger.debug('KG retrieval failed (non-blocking)', { error: err.message })
    }
  }

  // ─── 2. INJECT: Add context as system message ──────────────────────
  let enrichedMessages = [...messages]
  if (kgContext) {
    const systemContext = `--- KNOWLEDGE GRAPH ---
${kgContext}
--- END KNOWLEDGE GRAPH ---`

    // Prepend as system message, or append to existing system message
    const existingSystem = enrichedMessages.findIndex(m => m.role === 'system')
    if (existingSystem >= 0) {
      enrichedMessages[existingSystem] = {
        ...enrichedMessages[existingSystem],
        content: enrichedMessages[existingSystem].content + '\n\n' + systemContext,
      }
    } else {
      enrichedMessages = [{ role: 'system', content: systemContext }, ...enrichedMessages]
    }

    logger.debug(`KG context injected for ${module} (${kgContext.length} chars)`)
  }

  // ─── 3. EXECUTE: Delegate to claudeService (Anthropic API) ─────────
  const { callClaude } = require('./claudeService')
  const content = await callClaude(enrichedMessages, { module, model, temperature })

  // ─── 4. LOG: Ingest the exchange back into the KG ──────────────────
  if (!skipLogging && kg && env.NEO4J_URI && env.OPENAI_API_KEY) {
    const userMessage = messages.filter(m => m.role === 'user').pop()?.content || ''
    const logContent = `LLM interaction (${module}):
Input: ${userMessage.slice(0, 500)}
Output: ${content.slice(0, 1000)}`

    kg.ingestFromLLM(logContent, {
      sourceModule: `llm_${module}`,
      sourceId,
      context: `This is the result of an AI ${module} operation. Extract any new entities, facts, decisions, or relationships mentioned.`,
    }).catch(err => logger.debug('KG logging failed (non-blocking)', { error: err.message }))
  }

  return content
}

// ═══════════════════════════════════════════════════════════════════════
// Module-Specific Functions
// (now all automatically KG-aware via callDeepSeek)
// ═══════════════════════════════════════════════════════════════════════

function parseJSON(content) {
  try {
    return JSON.parse(content)
  } catch {
    const match = content.match(/```(?:json)?\s*([\s\S]*?)```/)
    if (match) return JSON.parse(match[1].trim())
    throw new Error(`Failed to parse DeepSeek response as JSON: ${content.slice(0, 200)}`)
  }
}

async function categorize({ description, amount, type, date }) {
  const prompt = `Categorize this transaction for ${env.OWNER_CONTEXT}.

${description} — AUD ${Math.abs(amount)} (${type}) on ${date}

Decide the most accurate category, Xero account code if you know it, and your confidence. Use whatever category name best describes this — don't constrain yourself to a predefined list.

Respond as JSON:
{
  "category": "...",
  "confidence": 0.0-1.0,
  "xeroAccountCode": "if known, null otherwise",
  "notes": "rationale"
}`

  return parseJSON(await callDeepSeek([{ role: 'user', content: prompt }], {
    module: 'finance',
    contextQuery: `${description} transaction payment`,
  }))
}

async function triageEmail({ subject, from, body, snippet, inbox, clientContext, kgContext, pendingActionsContext, activeChannelsContext, projectCodebaseContext, decisionContext, receivedAt }) {
  // kgContext may already be provided by gmailService — if so, skip retrieval
  const hasExternalContext = !!kgContext

  const contextBlock = kgContext
    ? `\n--- KNOWLEDGE GRAPH ---\n${kgContext}\n--- END ---\n`
    : clientContext
      ? `Known client: ${clientContext.name} (Status: ${clientContext.status})`
      : 'Unknown sender'

  const pendingBlock = pendingActionsContext
    ? `\n--- ALREADY PENDING ---\n${pendingActionsContext}\n--- END ---\n`
    : ''

  const channelsBlock = activeChannelsContext
    ? `\n--- OTHER CHANNELS ---\n${activeChannelsContext}\n--- END ---\n`
    : ''

  const codebaseBlock = projectCodebaseContext
    ? `\n--- CLIENT PROJECTS & CODEBASES ---\n${projectCodebaseContext}\n--- END ---\n`
    : ''

  const decisionBlock = decisionContext
    ? `\n--- DECISION HISTORY (this sender) ---\n${decisionContext}\n--- END ---\n`
    : ''

  const now = new Date()
  const emailAge = receivedAt
    ? (() => {
        const ageMs = now - new Date(receivedAt)
        const ageMins = Math.round(ageMs / 60000)
        if (ageMins < 60) return `${ageMins} minutes ago`
        if (ageMins < 1440) return `${Math.round(ageMins / 60)} hours ago`
        return `${Math.round(ageMins / 1440)} days ago`
      })()
    : null

  const prompt = `Email for ${env.OWNER_CONTEXT}.

Now: ${now.toISOString()}
Inbox: ${inbox || env.GOOGLE_PRIMARY_ACCOUNT}
From: ${from}
Subject: ${subject}${emailAge ? `\nReceived: ${emailAge}` : ''}
${contextBlock}${pendingBlock}${channelsBlock}${codebaseBlock}${decisionBlock}
Body:
${(body || snippet || '').slice(0, 3000)}

Read this email and decide what to do. You have full autonomy — reply, archive, create a task, snooze, ignore, or anything else appropriate. Draft a reply if warranted; leave draftReply null if not. Decide if this needs human attention and why.

If this email is requesting code work (a feature, bug fix, update, deployment, or technical task), set isCodeWorkRequest=true, specify codeWorkType, and write a factoryPrompt. The factoryPrompt must be a precise, self-contained instruction for a coding session. Reference the specific codebase by name if you can determine which one from the project/codebase context above. Include the tech stack, relevant areas of the codebase to look at, acceptance criteria, and any constraints from the email. The factoryPrompt should be detailed enough that a developer unfamiliar with the project could execute it. Leave these null if the email is not about code work.

If the sender has multiple codebases and you can't determine which one applies, set suggestedCodebase to your best guess and surfaceToHuman=true with the reason.

Respond as JSON:
{
  "priority": "...",
  "summary": "...",
  "autonomousAction": "...",
  "reasoning": "...",
  "draftReply": "...",
  "shouldCreateTask": true/false,
  "taskTitle": "...",
  "taskDescription": "...",
  "taskPriority": "...",
  "confidence": 0.0-1.0,
  "surfaceToHuman": true/false,
  "surfaceReason": "...",
  "isCodeWorkRequest": true/false,
  "codeWorkType": "feature|bugfix|update|investigation|null",
  "factoryPrompt": "precise, codebase-aware prompt for a coding session, or null",
  "suggestedCodebase": "name of the target codebase, or null"
}`

  const raw = await callDeepSeek([{ role: 'user', content: prompt }], {
    module: 'gmail',
    contextQuery: hasExternalContext ? null : `${from} ${subject}`,
    skipRetrieval: hasExternalContext, // already have context, don't double-fetch
  })

  let parsed
  try {
    parsed = parseJSON(raw)
  } catch (parseErr) {
    // Parse failure must not kill the triage pipeline — return safe defaults
    // so the email at least gets archived/surfaced rather than stuck in 'pending' forever
    logger.warn('triageEmail: JSON parse failed, using safe defaults', {
      error: parseErr.message, rawSlice: (raw || '').slice(0, 200),
    })
    return {
      priority: 'medium',
      summary: `Parse error — manual review needed. Subject: ${subject || 'unknown'}`,
      autonomousAction: 'archive',
      reasoning: 'AI response was not valid JSON — surfacing for human review',
      draftReply: null,
      shouldCreateTask: false,
      taskTitle: null,
      taskDescription: null,
      taskPriority: null,
      confidence: 0.3,
      surfaceToHuman: true,
      surfaceReason: 'AI triage response was malformed — could not parse as JSON',
      isCodeWorkRequest: false,
      codeWorkType: null,
      factoryPrompt: null,
      suggestedCodebase: null,
    }
  }

  // Validate critical fields — fill in safe defaults for anything missing
  if (!parsed.priority || typeof parsed.priority !== 'string') parsed.priority = 'medium'
  if (!parsed.summary || typeof parsed.summary !== 'string') parsed.summary = subject || 'No summary'
  if (typeof parsed.confidence !== 'number' || isNaN(parsed.confidence)) parsed.confidence = 0.5
  if (typeof parsed.surfaceToHuman !== 'boolean') parsed.surfaceToHuman = false
  if (typeof parsed.isCodeWorkRequest !== 'boolean') parsed.isCodeWorkRequest = false
  if (typeof parsed.shouldCreateTask !== 'boolean') parsed.shouldCreateTask = false

  return parsed
}

async function draftEmailReply(thread) {
  const prompt = `Draft a reply for ${env.OWNER_CONTEXT}.

From: ${thread.from_name || thread.from_email}
Subject: ${thread.subject}
Body: ${(thread.full_body || thread.snippet || '').slice(0, 3000)}`

  return callDeepSeek([{ role: 'user', content: prompt }], {
    module: 'gmail',
    contextQuery: `${thread.from_name || thread.from_email} ${thread.subject}`,
    sourceId: thread.id,
  })
}

async function draftLinkedInReply(dm) {
  const messages = dm.messages || []
  const lastMessages = messages.slice(-5)

  const prompt = `LinkedIn DM reply for ${env.OWNER_CONTEXT}.

Conversation with ${dm.participant_name}:
${lastMessages.map(m => `${m.sender}: ${m.text}`).join('\n')}`

  return callDeepSeek([{ role: 'user', content: prompt }], {
    module: 'linkedin',
    contextQuery: `${dm.participant_name} LinkedIn conversation`,
    sourceId: dm.id,
  })
}

module.exports = { callDeepSeek, parseJSON, categorize, triageEmail, draftEmailReply, draftLinkedInReply }
