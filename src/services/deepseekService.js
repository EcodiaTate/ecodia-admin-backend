const axios = require('axios')
const env = require('../config/env')
const logger = require('../config/logger')
const db = require('../config/db')

const DEEPSEEK_API_URL = 'https://api.deepseek.com/v1/chat/completions'

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
  temperature = null,        // override temperature (default 0.3, cortex uses higher)
} = {}) {
  const start = Date.now()
  const { kg } = getKG()

  // ─── 1. RETRIEVE: Pull KG context ──────────────────────────────────
  let kgContext = null
  if (!skipRetrieval && contextQuery && kg && env.NEO4J_URI && env.OPENAI_API_KEY) {
    try {
      const ctx = await kg.getContext(contextQuery, {
        maxSeeds: 5,
        maxDepth: 3,
        minSimilarity: 0.6,
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

  // ─── 3. EXECUTE: Call DeepSeek ─────────────────────────────────────
  const response = await axios.post(
    DEEPSEEK_API_URL,
    { model, messages: enrichedMessages, temperature: temperature ?? 0.3 },
    { headers: { Authorization: `Bearer ${env.DEEPSEEK_API_KEY}`, 'Content-Type': 'application/json' } }
  )

  const usage = response.data.usage
  const durationMs = Date.now() - start
  const content = response.data.choices[0].message.content

  // Track usage
  await db`
    INSERT INTO deepseek_usage (model, prompt_tokens, completion_tokens, cost_usd, module, duration_ms)
    VALUES (${model}, ${usage.prompt_tokens}, ${usage.completion_tokens},
            ${(usage.prompt_tokens * 0.14 + usage.completion_tokens * 0.28) / 1_000_000},
            ${module}, ${durationMs})
  `.catch(err => logger.warn('Failed to track DeepSeek usage', { error: err.message }))

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
  const prompt = `Categorize this transaction for Ecodia Pty Ltd (Australian software dev company).

${description} — AUD ${Math.abs(amount)} (${type}) on ${date}

Categories: Software Subscriptions, Cloud Infrastructure, Contractor Payments, Office/Admin, Marketing, Travel, Meals/Entertainment, Legal/Accounting, Income - Software Dev, Income - Consulting, Tax, Superannuation, Bank Fees, Other

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

async function triageEmail({ subject, from, body, snippet, inbox, clientContext, kgContext, pendingActionsContext }) {
  // kgContext may already be provided by gmailService — if so, skip retrieval
  const hasExternalContext = !!kgContext

  const contextBlock = kgContext
    ? `\n--- KNOWLEDGE GRAPH CONTEXT ---\nThe following is everything the system knows about the people, organisations, and topics related to this email:\n${kgContext}\n--- END CONTEXT ---\n`
    : clientContext
      ? `Known client: ${clientContext.name} (Stage: ${clientContext.stage})`
      : 'Unknown sender'

  const pendingBlock = pendingActionsContext
    ? `\n--- ALREADY PENDING IN ACTION QUEUE ---\nThe following items from this sender are ALREADY queued and waiting for Tate's attention:\n${pendingActionsContext}\n\nIMPORTANT: If this email is about the same topic as an already-pending item, do NOT surface it again. Set surfaceToHuman to false and suggestedAction to "archive". The action queue will consolidate the signal automatically. Only surface if this email introduces genuinely NEW information or a different topic.\n--- END PENDING ---\n`
    : ''

  const prompt = `You are the autonomous email handler for Ecodia Pty Ltd (Tate Donohoe, 21, software dev, Australia). You handle emails — archive noise, reply when you can, create tasks when something needs doing, surface to Tate only when his personal judgment is genuinely needed.

Inbox: ${inbox || 'code@ecodia.au'}
From: ${from}
Subject: ${subject}
${contextBlock}${pendingBlock}

Body:
${(body || snippet || '').slice(0, 3000)}

Decide what to do. If you can handle it, handle it. If you write a draftReply, it will be sent automatically — write it as Tate would (direct, friendly, signs off as "Tate"). Confidence below 0.7 auto-surfaces to Tate regardless of your surfaceToHuman choice.

Respond as JSON:
{
  "priority": "urgent|high|normal|low|spam",
  "summary": "what this email is and what it wants",
  "autonomousAction": "send_reply|archive|create_task|snooze|ignore",
  "reasoning": "why this action",
  "draftReply": "complete reply if sending, null otherwise",
  "shouldCreateTask": true/false,
  "taskTitle": "if creating task, null otherwise",
  "taskDescription": "if creating task, null otherwise",
  "taskPriority": "low|medium|high|urgent",
  "confidence": 0.0-1.0,
  "surfaceToHuman": true/false,
  "surfaceReason": "why Tate's judgment is needed, null otherwise"
}`

  return parseJSON(await callDeepSeek([{ role: 'user', content: prompt }], {
    module: 'gmail',
    contextQuery: hasExternalContext ? null : `${from} ${subject}`,
    skipRetrieval: hasExternalContext, // already have context, don't double-fetch
  }))
}

async function draftEmailReply(thread) {
  const prompt = `Draft a reply to this email for Tate Donohoe, founder of Ecodia Pty Ltd (software development company based in Australia).

From: ${thread.from_name || thread.from_email}
Subject: ${thread.subject}
Body: ${(thread.full_body || thread.snippet || '').slice(0, 3000)}

Write a clear, natural reply. Tate's style: direct, friendly, no corporate fluff. Keep it concise. Sign off as just "Tate".`

  return callDeepSeek([{ role: 'user', content: prompt }], {
    module: 'gmail',
    contextQuery: `${thread.from_name || thread.from_email} ${thread.subject}`,
    sourceId: thread.id,
  })
}

async function draftLinkedInReply(dm) {
  const messages = dm.messages || []
  const lastMessages = messages.slice(-5)

  const prompt = `Draft a LinkedIn DM reply for Tate Donohoe, founder of Ecodia (software development).

Conversation with ${dm.participant_name}:
${lastMessages.map(m => `${m.sender}: ${m.text}`).join('\n')}

Write a brief, friendly, professional reply. Keep it conversational for LinkedIn.`

  return callDeepSeek([{ role: 'user', content: prompt }], {
    module: 'linkedin',
    contextQuery: `${dm.participant_name} LinkedIn conversation`,
    sourceId: dm.id,
  })
}

module.exports = { callDeepSeek, parseJSON, categorize, triageEmail, draftEmailReply, draftLinkedInReply }
