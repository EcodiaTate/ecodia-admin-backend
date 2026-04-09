const env = require('../config/env')
const logger = require('../config/logger')

// ═══════════════════════════════════════════════════════════════════════
// KG-AWARE LLM LAYER  (formerly "deepseekService" — name kept for import compat)
//
// Every LLM call goes through callDeepSeek(). It automatically:
//   1. RETRIEVES — pulls relevant KG context via semantic search + trace
//   2. INJECTS   — adds context as a system message prefix
//   3. EXECUTES  — calls claudeService (Anthropic API, sonnet-4-6 default)
//   4. LOGS      — ingests the exchange back into the KG
//
// Callers pass `contextQuery` (what to search the graph for) and the
// graph enriches every call. The graph grows with every call.
//
// Provider: Claude via ANTHROPIC_API_KEY (claudeService handles retries + tracking).
// DeepSeek is fully decommissioned — this file is the KG wrapper only.
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

// ─── Core: KG-aware LLM call ─────────────────────────────────────────

async function callDeepSeek(messages, {
  module = 'general',
  model = 'claude-sonnet-4-6',
  contextQuery = null,      // what to search the KG for (string)
  skipRetrieval = false,    // skip KG retrieval (for KG ingestion calls — avoids loops)
  skipLogging = false,      // skip KG logging
  sourceId = null,          // source entity ID for KG logging
  temperature = null,       // null = provider default
  maxTokens = null,         // null = claudeService default (4096)
} = {}) {
  const { kg } = getKG()

  // ─── 1. RETRIEVE: Pull KG context ────────────────────────────────
  let kgContext = null
  if (!skipRetrieval && contextQuery && kg && env.NEO4J_URI) {
    try {
      const ctx = await kg.getContext(contextQuery, {
        maxSeeds:     parseInt(env.DEEPSEEK_KG_MAX_SEEDS   || env.KG_CONTEXT_MAX_SEEDS    || '15'),
        maxDepth:     parseInt(env.DEEPSEEK_KG_MAX_DEPTH   || env.KG_CONTEXT_MAX_DEPTH    || '5'),
        minSimilarity: parseFloat(env.DEEPSEEK_KG_MIN_SIMILARITY || env.KG_CONTEXT_MIN_SIMILARITY || '0.4'),
      })
      if (ctx.summary) kgContext = ctx.summary
    } catch (err) {
      logger.debug('KG retrieval failed (non-blocking)', { error: err.message })
    }
  }

  // ─── 2. INJECT: Prepend KG context as system message ─────────────
  let enrichedMessages = [...messages]
  if (kgContext) {
    const systemContext = `--- KNOWLEDGE GRAPH CONTEXT ---\n${kgContext}\n--- END KNOWLEDGE GRAPH ---`
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

  // ─── 3. EXECUTE: Call Claude ──────────────────────────────────────
  const { callClaude } = require('./claudeService')
  const opts = { module, model, temperature }
  if (maxTokens) opts.maxTokens = maxTokens
  const content = await callClaude(enrichedMessages, opts)

  // ─── 4. LOG: Ingest exchange back into KG ─────────────────────────
  if (!skipLogging && kg && env.NEO4J_URI) {
    const userMessage = messages.filter(m => m.role === 'user').pop()?.content || ''
    kg.ingestFromLLM(
      `LLM interaction (${module}):\nInput: ${userMessage.slice(0, 500)}\nOutput: ${content.slice(0, 1000)}`,
      {
        sourceModule: `llm_${module}`,
        sourceId,
        context: `AI ${module} operation result. Extract entities, facts, decisions, relationships.`,
      }
    ).catch(err => logger.debug('KG logging failed (non-blocking)', { error: err.message }))
  }

  return content
}

// ─── JSON parse helper ────────────────────────────────────────────────

function parseJSON(content) {
  const cleaned = content.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim()
  try {
    return JSON.parse(cleaned)
  } catch {
    const match = cleaned.match(/\{[\s\S]*\}|\[[\s\S]*\]/)
    if (match) {
      try { return JSON.parse(match[0]) } catch {}
    }
    throw new Error(`Failed to parse LLM response as JSON: ${content.slice(0, 200)}`)
  }
}

// ═══════════════════════════════════════════════════════════════════════
// Domain-specific helpers — all KG-aware via callDeepSeek
// ═══════════════════════════════════════════════════════════════════════

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
  const hasExternalContext = !!kgContext

  const contextBlock = kgContext
    ? `\n--- KNOWLEDGE GRAPH ---\n${kgContext}\n--- END ---\n`
    : clientContext
      ? `Known client: ${clientContext.name} (Status: ${clientContext.status})`
      : 'Unknown sender'

  const pendingBlock    = pendingActionsContext    ? `\n--- ALREADY PENDING ---\n${pendingActionsContext}\n--- END ---\n`               : ''
  const channelsBlock   = activeChannelsContext    ? `\n--- OTHER CHANNELS ---\n${activeChannelsContext}\n--- END ---\n`               : ''
  const codebaseBlock   = projectCodebaseContext   ? `\n--- CLIENT PROJECTS & CODEBASES ---\n${projectCodebaseContext}\n--- END ---\n` : ''
  const decisionBlock   = decisionContext          ? `\n--- DECISION HISTORY (this sender) ---\n${decisionContext}\n--- END ---\n`     : ''

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
    skipRetrieval: hasExternalContext, // already have context — don't double-fetch
  })

  let parsed
  try {
    parsed = parseJSON(raw)
  } catch (parseErr) {
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

  // Validate critical fields — fill safe defaults for anything missing
  if (!parsed.priority || typeof parsed.priority !== 'string') parsed.priority = 'medium'
  if (!parsed.summary  || typeof parsed.summary  !== 'string') parsed.summary  = subject || 'No summary'
  if (typeof parsed.confidence      !== 'number'  || isNaN(parsed.confidence))      parsed.confidence      = 0.5
  if (typeof parsed.surfaceToHuman  !== 'boolean')                                   parsed.surfaceToHuman  = false
  if (typeof parsed.isCodeWorkRequest !== 'boolean')                                 parsed.isCodeWorkRequest = false
  if (typeof parsed.shouldCreateTask  !== 'boolean')                                 parsed.shouldCreateTask  = false

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

module.exports = { callDeepSeek, categorize, triageEmail, draftEmailReply }
