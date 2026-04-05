const axios = require('axios')
const env = require('../config/env')
const logger = require('../config/logger')
const db = require('../config/db')

const DEEPSEEK_API_URL = 'https://api.deepseek.com/v1/chat/completions'
const DEEPSEEK_TIMEOUT_MS = parseInt(env.DEEPSEEK_TIMEOUT_MS || '120000') || 120000
const DEEPSEEK_MAX_RETRIES = parseInt(env.DEEPSEEK_MAX_RETRIES || '3') || 3
const DEEPSEEK_RETRY_BASE_MS = parseInt(env.DEEPSEEK_RETRY_BASE_MS || '1000') || 1000

// Provider routing: models starting with 'claude-' go to Anthropic Bedrock, else DeepSeek
function _isAnthropicModel(model) { return model.startsWith('claude-') }

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
        FROM deepseek_usage
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
  model = 'deepseek-chat',
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

  // ─── 3. EXECUTE: Call provider with retry + timeout ─────────────────
  const isAnthropic = _isAnthropicModel(model)
  let content, usage, durationMs

  if (isAnthropic) {
    // ─── Anthropic via AWS Bedrock ──────────────────────────────────
    if (!env.AWS_ACCESS_KEY_ID || !env.AWS_SECRET_ACCESS_KEY) {
      throw new Error('AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY not set but claude model requested')
    }

    const client = _getBedrockClient()

    // Convert OpenAI-style messages to Anthropic format
    const systemParts = enrichedMessages.filter(m => m.role === 'system').map(m => m.content)
    const systemPrompt = systemParts.length > 0 ? systemParts.join('\n\n') : undefined
    const nonSystemMessages = enrichedMessages.filter(m => m.role !== 'system')

    let response
    for (let attempt = 0; attempt < DEEPSEEK_MAX_RETRIES; attempt++) {
      try {
        response = await client.messages.create({
          model,
          max_tokens: parseInt(env.ANTHROPIC_MAX_TOKENS || '4096'),
          ...(systemPrompt && { system: systemPrompt }),
          messages: nonSystemMessages,
          ...(temperature !== null && { temperature }),
        })
        break
      } catch (err) {
        const status = err.status || err.response?.status
        const retryable = !status || status === 429 || status >= 500
        if (!retryable || attempt === DEEPSEEK_MAX_RETRIES - 1) throw err
        const delayMs = DEEPSEEK_RETRY_BASE_MS * Math.pow(2, attempt) + Math.random() * 500
        logger.debug(`Bedrock retry ${attempt + 1}/${DEEPSEEK_MAX_RETRIES} after ${status || 'error'} (${Math.round(delayMs)}ms)`, { module })
        await new Promise(r => setTimeout(r, delayMs))
      }
    }

    durationMs = Date.now() - start
    const textBlocks = (response.content || []).filter(b => b.type === 'text')
    if (!textBlocks.length) throw new Error(`Bedrock returned empty response (module: ${module})`)
    content = textBlocks.map(b => b.text).join('\n').replace(/\u2014/g, '-')
    usage = {
      prompt_tokens: response.usage?.input_tokens || 0,
      completion_tokens: response.usage?.output_tokens || 0,
    }

    // Track usage — Bedrock Sonnet pricing: $3/1M input, $15/1M output
    const costUsd = (usage.prompt_tokens * parseFloat(env.ANTHROPIC_COST_INPUT_PER_1M || '3') + usage.completion_tokens * parseFloat(env.ANTHROPIC_COST_OUTPUT_PER_1M || '15')) / 1_000_000
    await db`
      INSERT INTO deepseek_usage (model, prompt_tokens, completion_tokens, cost_usd, module, duration_ms)
      VALUES (${model}, ${usage.prompt_tokens}, ${usage.completion_tokens}, ${costUsd}, ${module}, ${durationMs})
    `.catch(err => logger.warn('Failed to track Bedrock usage', { error: err.message }))

  } else {
    // ─── DeepSeek API (existing path) ───────────────────────────────
    let response
    for (let attempt = 0; attempt < DEEPSEEK_MAX_RETRIES; attempt++) {
      try {
        response = await axios.post(
          DEEPSEEK_API_URL,
          { model, messages: enrichedMessages, ...(temperature !== null && { temperature }) },
          {
            headers: { Authorization: `Bearer ${env.DEEPSEEK_API_KEY}`, 'Content-Type': 'application/json' },
            timeout: DEEPSEEK_TIMEOUT_MS,
          }
        )
        break  // success
      } catch (err) {
        const status = err.response?.status
        const retryable = !status || status === 429 || status >= 500
        if (!retryable || attempt === DEEPSEEK_MAX_RETRIES - 1) throw err
        const delayMs = DEEPSEEK_RETRY_BASE_MS * Math.pow(2, attempt) + Math.random() * 500
        logger.debug(`DeepSeek retry ${attempt + 1}/${DEEPSEEK_MAX_RETRIES} after ${status || 'timeout'} (${Math.round(delayMs)}ms)`, { module })
        await new Promise(r => setTimeout(r, delayMs))
      }
    }

    durationMs = Date.now() - start
    usage = response.data.usage
    const choices = response.data.choices
    if (!choices?.length || !choices[0]?.message?.content) {
      throw new Error(`DeepSeek returned empty response (module: ${module})`)
    }
    content = choices[0].message.content.replace(/\u2014/g, '-')

    // Track usage
    await db`
      INSERT INTO deepseek_usage (model, prompt_tokens, completion_tokens, cost_usd, module, duration_ms)
      VALUES (${model}, ${usage.prompt_tokens}, ${usage.completion_tokens},
              ${(usage.prompt_tokens * parseFloat(env.DEEPSEEK_COST_PROMPT_PER_1M || '0.14') + usage.completion_tokens * parseFloat(env.DEEPSEEK_COST_COMPLETION_PER_1M || '0.28')) / 1_000_000},
              ${module}, ${durationMs})
    `.catch(err => logger.warn('Failed to track DeepSeek usage', { error: err.message }))
  }

  // ─── 4. LOG: Ingest the exchange back into the KG ──────────────────
  if (!skipLogging && kg && env.NEO4J_URI && env.DEEPSEEK_API_KEY) {
    // Fire-and-forget — extract entities/relationships from the LLM's response
    // Use the user's last message + the response as content
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

async function triageEmail({ subject, from, body, snippet, inbox, clientContext, kgContext, pendingActionsContext, activeChannelsContext, receivedAt }) {
  // kgContext may already be provided by gmailService — if so, skip retrieval
  const hasExternalContext = !!kgContext

  const contextBlock = kgContext
    ? `\n--- KNOWLEDGE GRAPH ---\n${kgContext}\n--- END ---\n`
    : clientContext
      ? `Known client: ${clientContext.name} (Stage: ${clientContext.stage})`
      : 'Unknown sender'

  const pendingBlock = pendingActionsContext
    ? `\n--- ALREADY PENDING ---\n${pendingActionsContext}\n--- END ---\n`
    : ''

  const channelsBlock = activeChannelsContext
    ? `\n--- OTHER CHANNELS ---\n${activeChannelsContext}\n--- END ---\n`
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
${contextBlock}${pendingBlock}${channelsBlock}
Body:
${(body || snippet || '').slice(0, 3000)}

Read this email and decide what to do. You have full autonomy — reply, archive, create a task, snooze, ignore, or anything else appropriate. Draft a reply if warranted; leave draftReply null if not. Decide if this needs human attention and why.

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
  "surfaceReason": "..."
}`

  return parseJSON(await callDeepSeek([{ role: 'user', content: prompt }], {
    module: 'gmail',
    contextQuery: hasExternalContext ? null : `${from} ${subject}`,
    skipRetrieval: hasExternalContext, // already have context, don't double-fetch
  }))
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
