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
    const systemContext = `--- ECODIA KNOWLEDGE GRAPH ---
The following is contextual knowledge from Ecodia's world model. This represents what the system knows about relevant people, organisations, projects, events, and topics. Use this to inform your response — understand relationships, history, and context.

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
    { model, messages: enrichedMessages, temperature: 0.3 },
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
  const prompt = `You are an Australian business bookkeeper. Categorize this transaction for Ecodia Pty Ltd, a software development company.

Transaction:
- Description: ${description}
- Amount: AUD ${Math.abs(amount)} (${type})
- Date: ${date}

Respond with JSON only:
{
  "category": "one of: Software Subscriptions, Cloud Infrastructure, Contractor Payments, Office/Admin, Marketing, Travel, Meals/Entertainment, Legal/Accounting, Income - Software Dev, Income - Consulting, Tax, Superannuation, Bank Fees, Other",
  "confidence": 0.0-1.0,
  "xeroAccountCode": "relevant Xero account code if known",
  "notes": "brief rationale"
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

  const prompt = `You are the autonomous email handler for Ecodia Pty Ltd (Tate Donohoe, 21, software dev, Australia). Your job is to HANDLE emails — not alert about them. Act first, surface to Tate only as a last resort.

This email arrived in the ${inbox || 'code@ecodia.au'} inbox.

From: ${from}
Subject: ${subject}
${contextBlock}${pendingBlock}

Body:
${(body || snippet || '').slice(0, 3000)}

Your job is to decide what the system should DO about this email. Not what to tell Tate about it. ACT, don't alert. USE the knowledge graph context to inform your decisions.

Respond with JSON only:
{
  "priority": "urgent|high|normal|low|spam",
  "summary": "one sentence: what this email is and what it wants",
  "autonomousAction": "send_reply|archive|create_task|snooze|ignore",
  "reasoning": "why this action — include why you can or cannot handle this autonomously",
  "draftReply": "if autonomousAction is send_reply, write a complete reply in Tate's voice (direct, friendly, no corporate fluff, signs off as 'Tate'). This WILL be sent. null if no reply",
  "shouldCreateTask": true or false,
  "taskTitle": "if creating a task, what is it. null otherwise",
  "taskDescription": "detail. null otherwise",
  "taskPriority": "low|medium|high|urgent",
  "confidence": 0.0 to 1.0,
  "surfaceToHuman": true or false,
  "surfaceReason": "only if surfaceToHuman is true — why Tate's personal judgement is required"
}

ACTION PHILOSOPHY — read carefully:
- DEFAULT is to handle it yourself. Archive noise. Send replies. Create tasks. Snooze reminders.
- send_reply: You are confident in the reply and it WILL be sent automatically. Write it like Tate would. Use knowledge graph context about the sender and relationship.
- archive: No action needed. Receipts, confirmations, newsletters, automated notifications, marketing.
- create_task: Something needs doing but not a reply. Create the task with clear title/description and the system handles it.
- snooze: Repeated signal about something Tate has acknowledged but not yet acted on (billing reminders, renewal notices, etc). Log it, don't nag.
- ignore: Spam, phishing, irrelevant.

surfaceToHuman: Set true ONLY when the email genuinely requires Tate's personal judgement, approval, or creative input that no system can provide. Examples: a new client asking about a custom project, a legal question, a personal message from someone important. If you CAN handle it — handle it. If the ALREADY PENDING section shows this topic is queued, DO NOT surface again.

confidence: How sure you are about your autonomousAction. Below 0.7, the system will surface to Tate regardless of your surfaceToHuman choice. Be honest — this is a safety net, not a penalty.

Priority guide:
- urgent: money/deadline/legal at risk, needs hours-level response
- high: client or important contact, needs same-day attention
- normal: should be handled eventually
- low: informational, no action truly needed
- spam: junk`

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
