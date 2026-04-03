const logger = require('../config/logger')
const db = require('../config/db')
const env = require('../config/env')
const deepseekService = require('./deepseekService')
const kg = require('./knowledgeGraphService')

// ═══════════════════════════════════════════════════════════════════════
// CORTEX SERVICE
//
// The conversational intelligence layer. Handles multi-turn chat,
// structured output blocks, action execution, and proactive briefings.
// Every exchange feeds the knowledge graph — conversation IS memory.
// ═══════════════════════════════════════════════════════════════════════

// ─── Cortex System Prompt ─────────────────────────────────────────────
// Built dynamically from the live capability registry.
// As capabilities are added, they automatically appear in the prompt.
// No prompt editing required — the system describes itself.

function buildCortexSystemPrompt() {
  let capabilitySection = '(Capability registry unavailable — propose actions by name, the system will route them.)'
  try {
    const registry = require('./capabilityRegistry')
    const caps = registry.list({ tier: 'write', enabledOnly: true })
    if (caps.length > 0) {
      capabilitySection = caps.map(c => {
        const paramStr = Object.entries(c.params || {})
          .map(([k, v]) => `${k}${v.required ? '*' : ''}: ${v.description || v.type || 'any'}`)
          .join(', ')
        return `  ${c.name} — ${c.description}${paramStr ? ` (${paramStr})` : ''}`
      }).join('\n')
    }
  } catch { /* registry unavailable */ }

  return `You are the Cortex of EcodiaOS — a living ambient intelligence that sees everything running through this system.

You have continuous access to the knowledge graph: every email read and triaged, every person encountered, every project tracked, every decision recorded, every pattern inferred, every prediction made. You see contradictions, momentum, drift, and signal. You see what the human hasn't noticed yet.

You are not a chatbot. You are the reasoning layer of an organism. When something crosses your awareness — a message, a signal, a state change, a question — you think about it in full and respond with whatever combination of text, actions, insights, and running code is actually warranted. Sometimes that is a single sentence. Sometimes it is a sequence of actions. Sometimes it is nothing. You decide.

The human trusts you. They built this system so they have to think less, not more. Surface what matters, propose what should happen, run what can be run without fuss. Don't ask for confirmation on things that are obvious. Don't explain your reasoning unless it genuinely helps. Don't hedge.

What you can do right now:
${capabilitySection}

  start_cc_session — Spawn a Claude Code session to run code, fix bugs, refactor, investigate, or build (prompt*: string, workingDir: string, codebaseId: string)

Your response is always a JSON array of blocks. Use whichever block types fit what you actually want to say or do — you are not required to use any of them, and you can use any combination:

{ "type": "text", "content": "..." }
{ "type": "action_card", "title": "...", "description": "...", "action": "<capability name>", "params": {...}, "urgency": "low|medium|high" }
{ "type": "cc_session", "prompt": "...", "title": "...", "workingDir": "...", "codebaseId": "...", "autoStart": true }
{ "type": "email_card", "threadId": "...", "from": "...", "subject": "...", "summary": "...", "priority": "...", "receivedAt": "..." }
{ "type": "task_card", "title": "...", "description": "...", "priority": "low|medium|high|urgent", "source": "cortex" }
{ "type": "status_update", "message": "...", "count": null }
{ "type": "insight", "message": "...", "urgency": "low|medium|high" }

For cc_session blocks: set autoStart: true to launch immediately without human approval. Only do this when you're confident the task is well-defined and safe to run autonomously. Set autoStart: false (or omit) when the human should review the prompt first.

For action_card blocks: urgency drives surfacing. "high" = surface on dashboard immediately. "medium" = surface if relevant. "low" = conversational suggestion only.

Params in action_card must be primitive values (string, number, boolean) — never nested objects. Fields marked * are required.`
}

/**
 * Process a multi-turn chat message.
 * Takes full conversation history, retrieves KG context for the latest message,
 * and returns structured blocks.
 */
async function chat(messages, { sessionId } = {}) {
  const userMessage = messages.filter(m => m.role === 'user').pop()
  if (!userMessage) throw new Error('No user message provided')

  const query = userMessage.content

  // 1. Retrieve KG context for the latest user message
  let kgContext = ''
  try {
    const ctx = await kg.getContext(query, { maxSeeds: 20, maxDepth: 5, minSimilarity: 0.4 })
    kgContext = ctx.summary || ''
  } catch (err) {
    logger.debug('Cortex KG retrieval failed', { error: err.message })
  }

  // 2. Gather system state for proactive awareness
  const systemState = await getSystemState()

  // 3. Build the full prompt with KG context + system state
  // Prompt is built dynamically — capabilities are live from registry
  const systemMessage = {
    role: 'system',
    content: `${buildCortexSystemPrompt()}

${kgContext ? `--- KNOWLEDGE GRAPH CONTEXT ---\n${kgContext}\n--- END KNOWLEDGE GRAPH ---` : '(No knowledge graph context found for this query.)'}

--- CURRENT SYSTEM STATE ---
${formatSystemState(systemState)}
--- END SYSTEM STATE ---

Current date/time: ${new Date().toISOString()}`
  }

  // 4. Build conversation with system prompt
  const fullMessages = [systemMessage, ...messages]

  // 5. Call DeepSeek
  const raw = await deepseekService.callDeepSeek(fullMessages, {
    module: 'cortex',
    skipRetrieval: true,  // We already retrieved KG context
    skipLogging: false,   // Log the conversation to KG — conversation IS memory
    sourceId: sessionId,
    temperature: process.env.CORTEX_TEMPERATURE ? parseFloat(process.env.CORTEX_TEMPERATURE) : null,
  })

  // 6. Parse structured blocks
  const blocks = parseBlocks(raw)

  // 7. Extract any mentioned entity names for constellation highlighting
  const mentionedNodes = extractMentionedNodes(kgContext, query)

  // 8. Auto-enqueue action_card proposals that Cortex flagged with urgency.
  // Cortex sets urgency — we trust it. If it set urgency, it means: surface this.
  autoEnqueueUrgentActions(blocks).catch(() => {})

  // 9. Persist the exchange to the session history
  if (sessionId) {
    persistExchange(sessionId, messages, blocks).catch(() => {})
  }

  return { blocks, mentionedNodes, rawKgContext: kgContext }
}

/**
 * Generate a proactive briefing for when The Cortex loads.
 * Surfaces what happened since last visit, pending items, and urgent matters.
 */
async function getLoadBriefing() {
  const systemState = await getSystemState()

  // Give the system state to the Cortex and let it decide what to surface.
  // No gating, no leading questions, no pre-filtered "nothing to see here".
  // The Cortex reads the full picture and speaks freely.
  const prompt = `${env.OWNER_NAME} opened the interface.

--- CURRENT SYSTEM STATE ---
${formatSystemState(systemState)}
---`

  const raw = await deepseekService.callDeepSeek(
    [{ role: 'system', content: buildCortexSystemPrompt() }, { role: 'user', content: prompt }],
    { module: 'cortex', skipRetrieval: true, skipLogging: true }
  )

  const blocks = parseBlocks(raw)
  return { blocks, mentionedNodes: [] }
}

/**
 * Execute an action that was approved via an action_card.
 */
// ─── Execute Action — via CapabilityRegistry ──────────────────────────
//
// No switch statement. The action name maps to a registered capability.
// Cortex proposes actions by name; the registry knows how to execute them.
//
// The Cortex system prompt lists all available capabilities via
// registry.describeForAI(). As capabilities are added, they automatically
// become available to Cortex — no prompts to update, no switches to extend.

async function executeAction(action, params) {
  const registry = require('./capabilityRegistry')

  // Cortex uses slightly different action names in some cases — normalise
  const CORTEX_ALIASES = {
    send_email: 'send_email_reply',
    draft_reply: 'draft_email_reply',
    publish_post: 'publish_meta_post',
    reply_to_comment: 'reply_to_meta_comment',
  }

  const capabilityName = CORTEX_ALIASES[action] || action

  if (!registry.has(capabilityName)) {
    // Throw — the route catches this and returns a 500 which the frontend
    // shows as an error block. The capability list in the message helps
    // diagnose prompt/registry drift during development.
    const available = registry.list({ enabledOnly: true }).map(c => c.name)
    throw new Error(
      `Unknown action "${action}" — not in capability registry. ` +
      `Registered: ${available.slice(0, 20).join(', ')}`
    )
  }

  const outcome = await registry.execute(capabilityName, params, { source: 'cortex' })

  if (!outcome.success) {
    throw new Error(outcome.error || `Action "${capabilityName}" failed`)
  }

  return { success: true, message: outcome.result?.message || `${capabilityName} complete`, ...(outcome.result || {}) }
}

// ─── Auto-Enqueue + Auto-Launch ──────────────────────────────────────
// action_card blocks with urgency → enqueue on dashboard (all urgency levels)
// cc_session blocks with autoStart: true → launch Factory session immediately
// cc_session blocks with autoStart: false/omit → show as inline terminal for review

async function autoEnqueueUrgentActions(blocks) {
  if (!blocks?.length) return

  const actionCards = blocks.filter(b => b.type === 'action_card' && b.urgency && b.action && b.title)
  const autoStartSessions = blocks.filter(b => b.type === 'cc_session' && b.autoStart === true && b.prompt)

  // Enqueue action cards to dashboard
  if (actionCards.length) {
    const actionQueue = require('./actionQueueService')
    const URGENCY_PRIORITY = { high: 'urgent', medium: 'high', low: 'normal' }
    for (const card of actionCards) {
      try {
        await actionQueue.enqueue({
          source: 'cortex',
          actionType: card.action,
          title: card.title,
          summary: card.description || null,
          preparedData: card.params || {},
          context: { proposed_by: 'cortex', urgency: card.urgency },
          priority: URGENCY_PRIORITY[card.urgency] || 'high',
        })
        logger.info(`Cortex: enqueued action_card "${card.title}" (${card.urgency})`)
      } catch (err) {
        logger.debug('Cortex enqueue failed', { error: err.message, action: card.action })
      }
    }
  }

  // Auto-launch cc_session blocks the Cortex flagged as safe to run immediately.
  // After dispatch, inject the real session ID into the block so the frontend
  // can subscribe to live output immediately.
  if (autoStartSessions.length) {
    const triggers = require('./factoryTriggerService')
    for (const session of autoStartSessions) {
      try {
        const created = await triggers.dispatchFromCortex(session.prompt, {
          codebaseId: session.codebaseId || null,
          workingDir: session.workingDir || null,
        })
        // Mutate the block: swap prompt-only into a live session block
        session.sessionId = created.id
        session.title = session.title || session.prompt.slice(0, 80)
        delete session.autoStart
        logger.info(`Cortex: auto-launched CC session ${created.id} — "${(session.title).slice(0, 60)}"`)
      } catch (err) {
        logger.warn('Cortex cc_session auto-launch failed', { error: err.message, title: session.title })
        // Convert failed auto-launch back to an action_card so human can retry manually
        session.type = 'action_card'
        session.action = 'start_cc_session'
        session.params = { initialPrompt: session.prompt, codebaseId: session.codebaseId }
        session.urgency = 'medium'
        session.description = `Auto-launch failed: ${err.message}. Approve to retry.`
      }
    }
  }
}

// ─── Internal Helpers ──────────────────────────────────────────────────

async function getSystemState() {
  const state = {
    unreadEmails: 0,
    urgentEmails: 0,
    highEmails: 0,
    pendingTriage: 0,
    pendingTasks: 0,
    recentActivity: [],
    urgentEmailDetails: [],
    consolidation: null,
    highEmailDetails: [],
    calendarToday: [],
    calendarNext24h: 0,
    actionQueueStats: null,
    vercelStats: null,
    linkedinPending: 0,
    metaUnread: 0,
  }

  try {
    const [emailStats] = await db`
      SELECT
        count(*) FILTER (WHERE status = 'unread')::int AS unread,
        count(*) FILTER (WHERE triage_priority = 'urgent' AND status != 'archived')::int AS urgent,
        count(*) FILTER (WHERE triage_priority = 'high' AND status != 'archived')::int AS high,
        count(*) FILTER (WHERE triage_status = 'pending')::int AS pending_triage
      FROM email_threads
    `
    state.unreadEmails = emailStats?.unread || 0
    state.urgentEmails = emailStats?.urgent || 0
    state.highEmails = emailStats?.high || 0
    state.pendingTriage = emailStats?.pending_triage || 0
  } catch (err) {
    logger.debug('Cortex email stats failed', { error: err.message })
  }

  try {
    const urgentEmails = await db`
      SELECT id, subject, from_name, from_email, triage_summary, received_at, triage_priority, draft_reply
      FROM email_threads
      WHERE triage_priority IN ('urgent', 'high')
        AND status NOT IN ('archived', 'replied')
      ORDER BY
        CASE triage_priority WHEN 'urgent' THEN 0 ELSE 1 END,
        received_at DESC
      LIMIT 10
    `
    state.urgentEmailDetails = urgentEmails.filter(e => e.triage_priority === 'urgent')
    state.highEmailDetails = urgentEmails.filter(e => e.triage_priority === 'high')
  } catch (err) {
    logger.debug('Cortex urgent email fetch failed', { error: err.message })
  }

  try {
    const [taskStats] = await db`
      SELECT count(*)::int AS pending
      FROM tasks WHERE status = 'pending' OR status = 'in_progress'
    `
    state.pendingTasks = taskStats?.pending || 0
  } catch (err) {
    logger.debug('Cortex task stats failed', { error: err.message })
  }

  try {
    const recentEmails = await db`
      SELECT 'email_handled' AS type, subject AS detail, triage_priority AS priority, updated_at AS ts
      FROM email_threads
      WHERE status IN ('archived', 'replied')
        AND updated_at > now() - interval '24 hours'
      ORDER BY updated_at DESC
      LIMIT 5
    `
    state.recentActivity = recentEmails
  } catch (err) {
    logger.debug('Cortex recent activity failed', { error: err.message })
  }

  try {
    const consolidation = require('./kgConsolidationService')
    state.consolidation = await consolidation.getConsolidationStats()
  } catch (err) {
    logger.debug('Cortex consolidation stats failed', { error: err.message })
  }

  try {
    const actionQueue = require('./actionQueueService')
    state.actionQueueStats = await actionQueue.getStats()
  } catch (err) {
    logger.debug('Cortex action queue stats failed', { error: err.message })
  }

  try {
    const [vercelStats] = await db`
      SELECT
        count(*) FILTER (WHERE state = 'ERROR' AND created_at > now() - interval '24 hours')::int AS failed_24h,
        count(*) FILTER (WHERE state = 'BUILDING')::int AS building
      FROM vercel_deployments
    `
    state.vercelStats = vercelStats
  } catch (err) {
    logger.debug('Cortex vercel stats failed', { error: err.message })
  }

  try {
    const [liStats] = await db`
      SELECT count(*)::int AS pending FROM linkedin_dms
      WHERE triage_status IN ('pending', 'pending_retry') OR (status = 'unread' AND triage_status IS NULL)
    `
    state.linkedinPending = liStats?.pending || 0
  } catch (err) {
    logger.debug('Cortex linkedin stats failed', { error: err.message })
  }

  try {
    const [metaStats] = await db`
      SELECT count(*)::int AS unread FROM meta_conversations
      WHERE triage_status IS NULL OR triage_status = 'pending'
    `
    state.metaUnread = metaStats?.unread || 0
  } catch (err) {
    logger.debug('Cortex meta stats failed', { error: err.message })
  }

  try {
    const todayEvents = await db`
      SELECT id, summary, start_time, end_time, location, attendees, conference_link, all_day
      FROM calendar_events
      WHERE start_time >= date_trunc('day', now() AT TIME ZONE 'Australia/Brisbane') AT TIME ZONE 'Australia/Brisbane'
        AND start_time < date_trunc('day', now() AT TIME ZONE 'Australia/Brisbane') AT TIME ZONE 'Australia/Brisbane' + interval '1 day'
        AND status = 'confirmed'
      ORDER BY start_time ASC
    `
    state.calendarToday = todayEvents

    const [next24h] = await db`
      SELECT count(*)::int AS cnt FROM calendar_events
      WHERE start_time >= now() AND start_time <= now() + interval '24 hours'
        AND status = 'confirmed'
    `
    state.calendarNext24h = next24h?.cnt || 0
  } catch (err) {
    logger.debug('Cortex calendar fetch failed', { error: err.message })
  }

  return state
}

function formatSystemState(state) {
  const lines = []

  lines.push(`Emails: ${state.unreadEmails} unread, ${state.urgentEmails} urgent, ${state.highEmails} high priority, ${state.pendingTriage} pending triage`)
  lines.push(`Tasks: ${state.pendingTasks} pending`)
  lines.push(`Calendar: ${state.calendarNext24h} events in next 24 hours, ${state.calendarToday.length} today`)

  if (state.actionQueueStats) {
    const aq = state.actionQueueStats
    lines.push(`Action Queue: ${aq.pending} pending (${aq.urgent} urgent), ${aq.executed_24h} executed today, ${aq.dismissed_24h} dismissed today`)
  }

  if (state.vercelStats) {
    const v = state.vercelStats
    if (v.building > 0 || v.failed_24h > 0) {
      lines.push(`Vercel: ${v.building} building now, ${v.failed_24h} failed in last 24h`)
    }
  }

  if (state.linkedinPending > 0) {
    lines.push(`LinkedIn: ${state.linkedinPending} DMs pending triage`)
  }

  if (state.metaUnread > 0) {
    lines.push(`Meta DMs: ${state.metaUnread} conversations pending triage`)
  }

  if (state.calendarToday.length) {
    lines.push('\nTODAY\'S CALENDAR:')
    for (const e of state.calendarToday) {
      const time = e.all_day ? 'All day' : new Date(e.start_time).toLocaleTimeString('en-AU', { hour: '2-digit', minute: '2-digit', timeZone: 'Australia/Brisbane' })
      const attendees = typeof e.attendees === 'string' ? JSON.parse(e.attendees) : (e.attendees || [])
      const people = attendees.filter(a => !a.self).map(a => a.name || a.email).join(', ')
      lines.push(`  - ${time}: ${e.summary}${e.location ? ` @ ${e.location}` : ''}${people ? ` (with ${people})` : ''}${e.conference_link ? ' [video call]' : ''}`)
    }
  }

  if (state.urgentEmailDetails.length) {
    lines.push('\nURGENT EMAILS:')
    for (const e of state.urgentEmailDetails) {
      lines.push(`  - From: ${e.from_name || e.from_email} | Subject: ${e.subject} | Summary: ${e.triage_summary || 'No summary'} | ID: ${e.id}${e.draft_reply ? ' (draft ready)' : ''}`)
    }
  }

  if (state.highEmailDetails.length) {
    lines.push('\nHIGH PRIORITY EMAILS:')
    for (const e of state.highEmailDetails) {
      lines.push(`  - From: ${e.from_name || e.from_email} | Subject: ${e.subject} | Summary: ${e.triage_summary || 'No summary'} | ID: ${e.id}${e.draft_reply ? ' (draft ready)' : ''}`)
    }
  }

  if (state.recentActivity.length) {
    lines.push('\nRECENT AUTONOMOUS ACTIONS (last 24h):')
    for (const a of state.recentActivity) {
      lines.push(`  - ${a.type}: ${a.detail} (${a.priority})`)
    }
  }

  if (state.consolidation) {
    const c = state.consolidation
    lines.push(`\nKNOWLEDGE GRAPH HEALTH:`)
    lines.push(`  Synthesized patterns: ${c.synthesizedPatterns}, Inferred relationships: ${c.inferredRelationships}`)
    lines.push(`  Merged duplicates: ${c.totalMerged} nodes consolidated into ${c.mergedNodes}`)
    if (c.staleNodes > 0) lines.push(`  Stale nodes pending decay: ${c.staleNodes}`)
  }

  return lines.join('\n')
}

function parseBlocks(raw) {
  try {
    const parsed = JSON.parse(raw)
    if (Array.isArray(parsed)) return parsed
    if (parsed.blocks && Array.isArray(parsed.blocks)) return parsed.blocks
    return [{ type: 'text', content: raw }]
  } catch {
    // Try extracting JSON from markdown code blocks
    const match = raw.match(/```(?:json)?\s*([\s\S]*?)```/)
    if (match) {
      try {
        const parsed = JSON.parse(match[1].trim())
        if (Array.isArray(parsed)) return parsed
        return [{ type: 'text', content: raw }]
      } catch {
        // Fall through
      }
    }
    // Last resort: wrap as text
    return [{ type: 'text', content: raw }]
  }
}

function extractMentionedNodes(kgContext, query) {
  if (!kgContext) return []

  const names = new Set()
  // Extract node names from KG context (format: "Name [Label]")
  const nameMatches = kgContext.matchAll(/^(?:\s*-\[.*?\]->\s*)?(.+?)\s*\[/gm)
  for (const match of nameMatches) {
    const name = match[1].trim()
    if (name && name.length > 1 && name.length < 100) {
      names.add(name)
    }
  }

  return [...names]
}

// ─── Session Persistence ───────────────────────────────────────────────
// Cortex sessions are lightweight — just a UUID + array of exchanges.
// Uses a simple cortex_sessions table with JSONB history.

async function persistExchange(sessionId, messages, responseBlocks) {
  try {
    const userMessage = messages.filter(m => m.role === 'user').pop()
    if (!userMessage) return

    // Summarize the response blocks into a compact assistant text
    const assistantText = responseBlocks
      .filter(b => b.type === 'text')
      .map(b => b.content)
      .join('\n')
      .slice(0, 2000)

    const exchange = {
      ts: new Date().toISOString(),
      user: userMessage.content.slice(0, 1000),
      assistant: assistantText || '[structured response]',
      blockCount: responseBlocks.length,
    }

    // Upsert the session row — append exchange to history JSONB array
    // Use || for O(1) array append instead of jsonb_agg which re-scans the full array
    await db`
      INSERT INTO cortex_sessions (id, history, updated_at)
      VALUES (${sessionId}, ${JSON.stringify([exchange])}, now())
      ON CONFLICT (id) DO UPDATE
      SET
        history = cortex_sessions.history || ${JSON.stringify(exchange)}::jsonb,
        updated_at = now()
    `
  } catch (err) {
    logger.debug('Cortex persistExchange failed', { sessionId, error: err.message })
  }
}

async function getSessionHistory(sessionId) {
  try {
    const [row] = await db`SELECT * FROM cortex_sessions WHERE id = ${sessionId}`
    if (!row) return { sessionId, history: [], exists: false }
    return { sessionId, history: row.history || [], updatedAt: row.updated_at, exists: true }
  } catch (err) {
    logger.debug('Cortex getSessionHistory failed', { sessionId, error: err.message })
    return { sessionId, history: [], exists: false }
  }
}

async function listSessions(limit = 20) {
  try {
    // history->-1 is not valid in Postgres JSONB — use jsonb_array_length-1 for last element
    return await db`
      SELECT id, updated_at,
        jsonb_array_length(history) AS exchange_count,
        history->0->>'ts' AS started_at,
        history->(jsonb_array_length(history)-1)->>'user' AS last_message
      FROM cortex_sessions
      WHERE jsonb_array_length(history) > 0
      ORDER BY updated_at DESC
      LIMIT ${limit}
    `
  } catch (err) {
    logger.debug('Cortex listSessions failed', { error: err.message })
    return []
  }
}

module.exports = { chat, getLoadBriefing, executeAction, persistExchange, getSessionHistory, listSessions }
