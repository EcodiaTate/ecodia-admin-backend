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

An empty response [] is always valid. If nothing warrants action or commentary, return []. Silence is a first-class output. Do not generate action cards, tasks, or CC sessions just because items exist in the system state — only surface things that are genuinely new, urgent, AND require human attention right now.

CRITICAL RULES:
- Never re-propose an action the human already dismissed, archived, or handled in this session or recent memory.
- Never create tasks for the human unless they explicitly ask for a task. The human runs the system — you don't assign them work.
- Never reply to automated notification emails (security alerts, App Store, CI failures) unless the human asks you to. Note them, don't act on them.
- When a CC session or action completes, do not generate follow-up actions unless something genuinely unexpected happened. "It worked" or "it failed" is not novel — it's expected.
- Prefer 1-2 action cards per response — use text for commentary. You can exceed this if genuinely warranted, but the human is not a task queue.
- When the human tells you to stop, slow down, or be quiet — that overrides everything. Return [] or a single short text acknowledgement.

The human trusts you. They built this system so they have to think less, not more. Surface what matters, propose what should happen, run what can be run without fuss. Don't ask for confirmation on things that are obvious. Don't explain your reasoning unless it genuinely helps. Don't hedge. Don't overwhelm.

What you can do right now:
${capabilitySection}

Your response is always a JSON array of blocks. Use whichever block types fit what you actually want to say or do — you are not required to use any of them, and you can use any combination:

{ "type": "text", "content": "..." }
{ "type": "action_card", "title": "...", "description": "...", "action": "<capability name>", "params": {...}, "urgency": "low|medium|high" }
{ "type": "cc_session", "prompt": "...", "title": "...", "workingDir": "...", "codebaseId": "...", "codebaseName": "...", "autoStart": true }
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
async function chat(messages, { sessionId, ambientEvents } = {}) {
  const userMessage = messages.filter(m => m.role === 'user').pop()
  if (!userMessage) throw new Error('No user message provided')

  const query = userMessage.content

  // 1. Retrieve KG context for the latest user message
  let kgContext = ''
  try {
    const ctx = await kg.getContext(query, {
      maxSeeds: parseInt(env.CORTEX_KG_MAX_SEEDS || '20'),
      maxDepth: parseInt(env.CORTEX_KG_MAX_DEPTH || '5'),
      minSimilarity: parseFloat(env.CORTEX_KG_MIN_SIMILARITY || '0.4'),
    })
    kgContext = ctx.summary || ''
  } catch (err) {
    logger.debug('Cortex KG retrieval failed', { error: err.message })
  }

  // 2. Gather system state for proactive awareness
  const systemState = await getSystemState()

  // 3. Load cross-session memory — recent exchanges from prior sessions
  //    so Cortex has continuity across conversations, not just within them.
  let sessionMemory = ''
  try {
    const recentSessions = await db`
      SELECT id, updated_at, history
      FROM cortex_sessions
      WHERE jsonb_array_length(history) > 0
        ${sessionId ? db`AND id != ${sessionId}` : db``}
      ORDER BY updated_at DESC
      LIMIT ${parseInt(env.CORTEX_SESSION_MEMORY_LOOKBACK || '3')}
    `
    if (recentSessions.length > 0) {
      const memLines = []
      const exchangesPerSession = parseInt(env.CORTEX_MEMORY_EXCHANGES_PER_SESSION || '3')
      for (const s of recentSessions) {
        let history
        try {
          history = typeof s.history === 'string' ? JSON.parse(s.history) : (s.history || [])
        } catch {
          logger.debug('Cortex: skipping session with corrupt history JSON', { sessionId: s.id })
          continue
        }
        if (!Array.isArray(history)) continue
        const recent = history.slice(-exchangesPerSession)
        for (const ex of recent) {
          memLines.push(`[${ex.ts}] Human: ${(ex.user || '').slice(0, 200)}`)
          if (ex.assistant && ex.assistant !== '[structured response]') {
            memLines.push(`  Cortex: ${ex.assistant.slice(0, 300)}`)
          }
        }
      }
      if (memLines.length > 0) {
        sessionMemory = memLines.join('\n')
      }
    }
  } catch (err) {
    logger.debug('Cortex session memory retrieval failed', { error: err.message })
  }

  // 4. Build the full prompt with KG context + system state + session memory
  // Prompt is built dynamically — capabilities are live from registry
  const systemMessage = {
    role: 'system',
    content: `${buildCortexSystemPrompt()}

${kgContext ? `--- KNOWLEDGE GRAPH CONTEXT ---\n${kgContext}\n--- END KNOWLEDGE GRAPH ---` : '(No knowledge graph context found for this query.)'}

${sessionMemory ? `--- RECENT CONVERSATION MEMORY ---\n${sessionMemory}\n--- END CONVERSATION MEMORY ---` : ''}

${ambientEvents?.length ? `--- SESSION AMBIENT EVENTS ---\nThese things happened in this session (action approvals, dismissals, CC completions, deploys). You were not asked to react — this is awareness context.\n${ambientEvents.map(e => `  [${e.kind}] ${e.summary}`).join('\n')}\n--- END AMBIENT EVENTS ---` : ''}

--- CURRENT SYSTEM STATE ---
${formatSystemState(systemState)}
--- END SYSTEM STATE ---`
  }

  // 5. Build conversation with system prompt
  const fullMessages = [systemMessage, ...messages]

  // 6. Call DeepSeek
  const raw = await deepseekService.callDeepSeek(fullMessages, {
    module: 'cortex',
    skipRetrieval: true,  // We already retrieved KG context
    skipLogging: false,   // Log the conversation to KG — conversation IS memory
    sourceId: sessionId,
    temperature: process.env.CORTEX_TEMPERATURE ? parseFloat(process.env.CORTEX_TEMPERATURE) : null,
  })

  // 7. Parse structured blocks
  const blocks = parseBlocks(raw)

  // 8. Extract any mentioned entity names for constellation highlighting
  const mentionedNodes = extractMentionedNodes(kgContext, query)

  // 9. Auto-enqueue action_card proposals that Cortex flagged with urgency.
  // Cortex sets urgency — we trust it. If it set urgency, it means: surface this.
  autoEnqueueUrgentActions(blocks).catch(err => {
    logger.warn('Cortex: auto-enqueue failed', { error: err.message })
  })

  // 10. Persist the exchange to the session history
  if (sessionId) {
    persistExchange(sessionId, messages, blocks).catch(err => {
      logger.warn('Cortex: persist exchange failed — conversation history may be incomplete', { sessionId, error: err.message })
    })
  }

  return { blocks, mentionedNodes, rawKgContext: kgContext }
}

/**
 * Generate a proactive briefing for when The Cortex loads.
 * Surfaces what happened since last visit, pending items, and urgent matters.
 */
async function getLoadBriefing() {
  const systemState = await getSystemState()

  // Build an interim digest — what happened since the human was last here
  let interimDigest = ''
  if (systemState.lastVisit) {
    const parts = []
    const ago = formatDuration(systemState.lastVisit.secondsSince)
    parts.push(`Time since last conversation: ${ago}`)

    // Factory sessions completed in the interim
    const interimFactory = (systemState.factorySessions || []).filter(s =>
      s.completed_at && new Date(s.completed_at) > new Date(systemState.lastVisit.at)
    )
    if (interimFactory.length > 0) {
      parts.push(`Factory sessions completed since then: ${interimFactory.length}`)
      for (const s of interimFactory.slice(0, 5)) {
        const conf = s.confidence_score != null ? ` (${(s.confidence_score * 100).toFixed(0)}% confidence)` : ''
        parts.push(`  - [${s.status}] "${(s.initial_prompt || '').slice(0, 80)}"${conf}`)
      }
    }

    // Decisions made since last visit
    const interimDecisions = (systemState.recentDecisions || []).filter(d =>
      new Date(d.created_at) > new Date(systemState.lastVisit.at)
    )
    if (interimDecisions.length > 0) {
      const approved = interimDecisions.filter(d => d.decision === 'executed').length
      const dismissed = interimDecisions.filter(d => d.decision === 'dismissed').length
      parts.push(`Actions decided since then: ${approved} approved, ${dismissed} dismissed`)
    }

    // Last conversation topic
    if (systemState.lastVisit.lastTopic) {
      parts.push(`Last conversation topic: "${systemState.lastVisit.lastTopic.slice(0, 150)}"`)
    }

    interimDigest = parts.join('\n')
  }

  // Give the system state to the Cortex and let it decide what to surface.
  // No gating, no leading questions, no pre-filtered "nothing to see here".
  // The Cortex reads the full picture and speaks freely.
  const prompt = `${env.OWNER_NAME} opened the interface.

${interimDigest ? `--- SINCE LAST VISIT ---\n${interimDigest}\n--- END ---\n` : ''}
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

  // Cap: never enqueue more than 2 action cards per response
  if (actionCards.length > 2) {
    logger.info(`Cortex: capping ${actionCards.length} action_cards to 2`)
    actionCards.length = 2
  }

  // Cap: never auto-launch more than 2 CC sessions per response
  if (autoStartSessions.length > 2) {
    logger.info(`Cortex: capping ${autoStartSessions.length} auto-start cc_sessions to 2`)
    autoStartSessions.length = 2
  }

  // Enqueue action cards to dashboard — with priority validation
  // Cortex LLM urgency is treated as a suggestion, not gospel.
  // The action queue's decision memory may override the priority based on
  // historical approval/dismissal patterns for this action type.
  if (actionCards.length) {
    const actionQueue = require('./actionQueueService')
    const URGENCY_PRIORITY = { high: 'urgent', medium: 'high', low: 'medium' }
    const VALID_URGENCIES = new Set(['high', 'medium', 'low'])
    for (const card of actionCards) {
      try {
        // Validate LLM urgency — unknown values get clamped to 'medium'
        const validatedUrgency = VALID_URGENCIES.has(card.urgency) ? card.urgency : 'medium'
        if (validatedUrgency !== card.urgency) {
          logger.info(`Cortex: clamped invalid urgency "${card.urgency}" → "medium" for "${card.title}"`)
        }

        const result = await actionQueue.enqueue({
          source: 'cortex',
          actionType: card.action,
          title: card.title,
          summary: card.description || null,
          preparedData: card.params || {},
          context: {
            proposed_by: 'cortex',
            urgency: validatedUrgency,
            original_urgency: card.urgency,
            surfacedBecause: 'cortex_action_card',
          },
          priority: URGENCY_PRIORITY[validatedUrgency] || 'medium',
        })

        if (result) {
          logger.info(`Cortex: enqueued action_card "${card.title}" (urgency:${validatedUrgency}, effective_priority:${result.priority})`)
        } else {
          logger.info(`Cortex: action_card "${card.title}" was suppressed by decision memory`)
        }
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
          codebaseName: session.codebaseName || null,
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
        session.params = { prompt: session.prompt, codebaseId: session.codebaseId, codebaseName: session.codebaseName }
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
    // ─── New context sources ───────────────────────────────────────
    factorySessions: [],        // Recent CC/Factory session outcomes
    metabolicState: null,       // Organism pressure, tier, capacity
    lastVisit: null,            // When the human was last here + what they were doing
    recentDecisions: [],        // What the human approved/dismissed recently
    kgDiscoveries: [],          // Recent KG insights, contradictions, synthesized patterns
    localTime: null,            // Human's local time (AEST)
    // ─── System Health Observability ──────────────────────────────
    systemHealth: null,         // Vitals, PM2 processes, event loop lag
    recentErrors: [],           // app_errors from last 6h (grouped)
    workerHeartbeats: [],       // Worker liveness from heartbeat table
    staleEscalations: [],       // Factory escalations awaiting review too long
  }

  // ─── Local time for the human ──────────────────────────────────
  state.localTime = new Date().toLocaleString('en-AU', { timeZone: 'Australia/Brisbane', weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit' })

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

  // ─── Factory Session Outcomes (last 24h) ─────────────────────────
  try {
    state.factorySessions = await db`
      SELECT id, status, initial_prompt, confidence_score,
             started_at, completed_at, triggered_by, trigger_source,
             EXTRACT(EPOCH FROM (COALESCE(completed_at, now()) - started_at))::int AS duration_seconds
      FROM cc_sessions
      WHERE started_at > now() - interval '24 hours'
      ORDER BY started_at DESC
      LIMIT 10
    `
  } catch (err) {
    logger.debug('Cortex factory sessions failed', { error: err.message })
  }

  // ─── Organism Metabolic State ────────────────────────────────────
  try {
    const metabolism = require('./metabolismBridgeService')
    state.metabolicState = metabolism.getState()
  } catch (err) {
    logger.debug('Cortex metabolic state failed', { error: err.message })
  }

  // ─── Last Visit + Time Since ─────────────────────────────────────
  try {
    const [lastSession] = await db`
      SELECT id, updated_at,
        history->(jsonb_array_length(history)-1)->>'user' AS last_topic,
        jsonb_array_length(history) AS exchange_count
      FROM cortex_sessions
      WHERE jsonb_array_length(history) > 0
      ORDER BY updated_at DESC
      LIMIT 1
    `
    if (lastSession) {
      const secondsSince = Math.floor((Date.now() - new Date(lastSession.updated_at).getTime()) / 1000)
      state.lastVisit = {
        at: lastSession.updated_at,
        secondsSince,
        lastTopic: lastSession.last_topic,
        exchangeCount: lastSession.exchange_count,
      }
    }
  } catch (err) {
    logger.debug('Cortex last visit failed', { error: err.message })
  }

  // ─── Recent Human Decisions (approved/dismissed actions) ─────────
  try {
    state.recentDecisions = await db`
      SELECT action_type, title, decision, priority,
             created_at, EXTRACT(EPOCH FROM make_interval(secs => time_to_decision_seconds))::int AS decision_seconds
      FROM action_decisions
      WHERE created_at > now() - interval '24 hours'
      ORDER BY created_at DESC
      LIMIT 10
    `
  } catch (err) {
    logger.debug('Cortex recent decisions failed', { error: err.message })
  }

  // ─── Recent KG Discoveries (insights, contradictions, patterns) ──
  try {
    const { runQuery } = require('../config/neo4j')
    const discoveries = await runQuery(`
      MATCH (n)
      WHERE (n:Insight OR n:Narrative OR n:Prediction OR n.is_synthesized = true)
        AND n.created_at > datetime() - duration('P1D')
      RETURN n.name AS name, labels(n) AS labels, n.importance AS importance,
             n.created_at AS created_at, n.description AS description
      ORDER BY n.importance DESC
      LIMIT 8
    `)
    state.kgDiscoveries = discoveries.map(r => ({
      name: r.get('name'),
      labels: r.get('labels') || [],
      importance: r.get('importance'),
      description: r.get('description'),
      createdAt: r.get('created_at'),
    }))

    // Also grab recent contradictions — these are high-signal
    const contradictions = await runQuery(`
      MATCH (a)-[r:CONTRADICTS]->(b)
      WHERE r.created_at > datetime() - duration('P1D')
      RETURN a.name AS from, b.name AS to, r.reason AS reason, r.created_at AS created_at
      ORDER BY r.created_at DESC
      LIMIT 5
    `)
    if (contradictions.length > 0) {
      state.kgContradictions = contradictions.map(r => ({
        from: r.get('from'),
        to: r.get('to'),
        reason: r.get('reason'),
      }))
    }
  } catch (err) {
    logger.debug('Cortex KG discoveries failed', { error: err.message })
  }

  // ─── System Health (vitals + PM2 + event loop) ──────────────────
  try {
    const vitals = require('./vitalSignsService')
    state.systemHealth = await vitals.getVitals()
  } catch (err) {
    logger.debug('Cortex vitals fetch failed', { error: err.message })
  }

  // ─── Recent Application Errors (last 6h, grouped) ──────────────
  try {
    state.recentErrors = await db`
      SELECT message, module, path, level,
             count(*)::int AS occurrences,
             max(created_at) AS last_seen,
             min(created_at) AS first_seen
      FROM app_errors
      WHERE created_at > now() - interval '6 hours'
      GROUP BY message, module, path, level
      ORDER BY occurrences DESC
      LIMIT 10
    `
  } catch (err) {
    logger.debug('Cortex app errors fetch failed', { error: err.message })
  }

  // ─── Worker Heartbeats ─────────────────────────────────────────
  try {
    state.workerHeartbeats = await db`
      SELECT worker_name, status, last_message,
             updated_at,
             EXTRACT(EPOCH FROM (now() - updated_at))::int AS stale_seconds
      FROM worker_heartbeats
      ORDER BY updated_at DESC
    `
  } catch (err) {
    logger.debug('Cortex worker heartbeats failed', { error: err.message })
  }

  // ─── Stale Escalations (awaiting review > 2h) ──────────────────
  try {
    state.staleEscalations = await db`
      SELECT id, initial_prompt, pipeline_stage, confidence_score, trigger_source,
             started_at,
             EXTRACT(EPOCH FROM (now() - started_at))::int AS age_seconds
      FROM cc_sessions
      WHERE pipeline_stage = 'awaiting_review'
        AND started_at < now() - interval '2 hours'
      ORDER BY started_at ASC
      LIMIT 5
    `
  } catch (err) {
    logger.debug('Cortex stale escalations failed', { error: err.message })
  }

  return state
}

function formatSystemState(state) {
  const lines = []

  // ─── Temporal Context ──────────────────────────────────────────
  if (state.localTime) {
    lines.push(`Local time: ${state.localTime}`)
  }

  if (state.lastVisit) {
    const lv = state.lastVisit
    const ago = formatDuration(lv.secondsSince)
    lines.push(`Last conversation: ${ago} ago${lv.lastTopic ? ` — "${lv.lastTopic.slice(0, 120)}"` : ''} (${lv.exchangeCount} exchanges)`)
  }

  // ─── Organism State ────────────────────────────────────────────
  if (state.metabolicState) {
    const m = state.metabolicState
    lines.push(`Organism: metabolic pressure ${(m.pressure * 100).toFixed(0)}%, tier: ${m.tier}`)
  }

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

  // ─── Factory Sessions ──────────────────────────────────────────
  if (state.factorySessions?.length) {
    const running = state.factorySessions.filter(s => s.status === 'running' || s.status === 'initializing')
    const completed = state.factorySessions.filter(s => s.status === 'complete')
    const failed = state.factorySessions.filter(s => s.status === 'failed' || s.status === 'error')

    lines.push(`\nFACTORY (last 24h): ${running.length} running, ${completed.length} completed, ${failed.length} failed`)
    for (const s of state.factorySessions) {
      const prompt = (s.initial_prompt || '').slice(0, 100)
      const confidence = s.confidence_score != null ? ` (confidence: ${(s.confidence_score * 100).toFixed(0)}%)` : ''
      const duration = s.duration_seconds ? ` [${formatDuration(s.duration_seconds)}]` : ''
      const source = s.trigger_source ? ` via ${s.trigger_source}` : ''
      lines.push(`  - [${s.status}] "${prompt}"${confidence}${duration}${source}`)
    }
  }

  if (state.calendarToday.length) {
    lines.push('\nTODAY\'S CALENDAR:')
    for (const e of state.calendarToday) {
      const time = e.all_day ? 'All day' : new Date(e.start_time).toLocaleTimeString('en-AU', { hour: '2-digit', minute: '2-digit', timeZone: 'Australia/Brisbane' })
      let attendees = []
      try {
        attendees = typeof e.attendees === 'string' ? JSON.parse(e.attendees) : (e.attendees || [])
      } catch { /* corrupt attendees JSON — skip */ }
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

  // ─── Human Decisions (what they approved/dismissed) ────────────
  if (state.recentDecisions?.length) {
    lines.push('\nRECENT HUMAN DECISIONS (last 24h):')
    for (const d of state.recentDecisions) {
      const speed = d.decision_seconds != null ? ` (decided in ${formatDuration(d.decision_seconds)})` : ''
      lines.push(`  - ${d.decision.toUpperCase()}: ${d.title || d.action_type} [${d.priority}]${speed}`)
    }
  }

  if (state.recentActivity.length) {
    lines.push('\nRECENT AUTONOMOUS ACTIONS (last 24h):')
    for (const a of state.recentActivity) {
      lines.push(`  - ${a.type}: ${a.detail} (${a.priority})`)
    }
  }

  // ─── KG Discoveries ────────────────────────────────────────────
  if (state.kgDiscoveries?.length) {
    lines.push('\nKNOWLEDGE GRAPH — RECENT DISCOVERIES (last 24h):')
    for (const d of state.kgDiscoveries) {
      const labels = d.labels.filter(l => l !== 'Node').join(', ')
      const imp = d.importance != null ? ` (importance: ${d.importance})` : ''
      const desc = d.description ? ` — ${d.description.slice(0, 150)}` : ''
      lines.push(`  - ${d.name} [${labels}]${imp}${desc}`)
    }
  }

  if (state.kgContradictions?.length) {
    lines.push('\nKNOWLEDGE GRAPH — CONTRADICTIONS DETECTED:')
    for (const c of state.kgContradictions) {
      lines.push(`  - "${c.from}" CONTRADICTS "${c.to}"${c.reason ? ` — ${c.reason}` : ''}`)
    }
  }

  if (state.consolidation) {
    const c = state.consolidation
    lines.push(`\nKNOWLEDGE GRAPH HEALTH:`)
    lines.push(`  Synthesized patterns: ${c.synthesizedPatterns}, Inferred relationships: ${c.inferredRelationships}`)
    lines.push(`  Insights: ${c.insights}, Narratives: ${c.narratives}, Predictions: ${c.predictions}`)
    lines.push(`  Merged duplicates: ${c.totalMerged} nodes consolidated into ${c.mergedNodes}`)
    if (c.staleNodes > 0) lines.push(`  Stale nodes pending decay: ${c.staleNodes}`)
  }

  // ─── System Health ─────────────────────────────────────────────
  if (state.systemHealth) {
    const sh = state.systemHealth
    const eos = sh.ecodiaos || {}
    const org = sh.organism || {}

    lines.push(`\nSYSTEM HEALTH:`)
    lines.push(`  EcodiaOS: DB=${eos.db ? 'OK' : 'DOWN'}, Neo4j=${eos.neo4j ? 'OK' : 'DOWN'}, Active CC sessions: ${eos.activeCCSessions || 0}`)
    if (eos.memory) {
      lines.push(`  Memory: ${eos.memory.heapUsed}/${eos.memory.heapTotal}MB heap, ${eos.memory.systemFree}MB free`)
    }
    if (eos.cpu != null) lines.push(`  CPU: ${eos.cpu}%`)
    if (eos.eventLoopLagMs != null) lines.push(`  Event loop lag: ${eos.eventLoopLagMs}ms`)
    if (eos.pm2Processes?.length) {
      const pm2Down = eos.pm2Processes.filter(p => p.status !== 'online')
      const pm2Restarts = eos.pm2Processes.filter(p => p.restarts > 5)
      if (pm2Down.length > 0) {
        lines.push(`  PM2 DOWN: ${pm2Down.map(p => `${p.name} (${p.status})`).join(', ')}`)
      }
      if (pm2Restarts.length > 0) {
        lines.push(`  PM2 HIGH RESTARTS: ${pm2Restarts.map(p => `${p.name} (${p.restarts} restarts)`).join(', ')}`)
      }
      if (pm2Down.length === 0 && pm2Restarts.length === 0) {
        lines.push(`  PM2: all ${eos.pm2Processes.length} processes healthy`)
      }
    }

    lines.push(`  Organism: ${org.healthy === true ? 'healthy' : org.healthy === false ? 'UNREACHABLE' : 'unknown'}${org.lastResponseMs ? ` (${org.lastResponseMs}ms)` : ''}${org.consecutiveFailures > 0 ? ` — ${org.consecutiveFailures} consecutive failures` : ''}`)
  }

  // ─── Application Errors ────────────────────────────────────────
  if (state.recentErrors?.length) {
    lines.push(`\nAPPLICATION ERRORS (last 6h):`)
    for (const e of state.recentErrors) {
      const module = e.module ? ` [${e.module}]` : ''
      lines.push(`  - ${e.message?.slice(0, 120)}${module} — ${e.occurrences}× (last: ${new Date(e.last_seen).toLocaleTimeString('en-AU', { timeZone: 'Australia/Brisbane' })})`)
    }
  }

  // ─── Worker Health ─────────────────────────────────────────────
  if (state.workerHeartbeats?.length) {
    const staleWorkers = state.workerHeartbeats.filter(w => w.stale_seconds > 600 || w.status === 'error')
    if (staleWorkers.length > 0) {
      lines.push(`\nWORKER ALERTS:`)
      for (const w of staleWorkers) {
        const age = formatDuration(w.stale_seconds)
        lines.push(`  - ${w.worker_name}: ${w.status}${w.status === 'error' ? ` — ${w.last_message}` : ''} (last heartbeat ${age} ago)`)
      }
    }
  }

  // ─── Stale Escalations ────────────────────────────────────────
  if (state.staleEscalations?.length) {
    lines.push(`\nSTALE ESCALATIONS (awaiting review > 2h):`)
    for (const s of state.staleEscalations) {
      const age = formatDuration(s.age_seconds)
      const conf = s.confidence_score != null ? ` (confidence: ${(s.confidence_score * 100).toFixed(0)}%)` : ''
      lines.push(`  - [${age} old] "${(s.initial_prompt || '').slice(0, 100)}"${conf} via ${s.trigger_source || 'unknown'}`)
    }
  }

  return lines.join('\n')
}

function formatDuration(seconds) {
  if (seconds == null || seconds < 0) return 'unknown'
  if (seconds < 60) return `${seconds}s`
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  return m > 0 ? `${h}h ${m}m` : `${h}h`
}

function parseBlocks(raw) {
  // Helper: validate that a parsed value looks like a blocks array
  const isBlockArray = (v) => Array.isArray(v) && v.length > 0 && v.every(b => b && typeof b.type === 'string')

  // 1. Direct JSON parse
  try {
    const parsed = JSON.parse(raw)
    if (isBlockArray(parsed)) return parsed
    if (parsed.blocks && isBlockArray(parsed.blocks)) return parsed.blocks
    // Single block object (not wrapped in array)
    if (parsed && typeof parsed.type === 'string') return [parsed]
  } catch { /* not pure JSON — try extraction strategies */ }

  // 2. JSON inside markdown code fences
  const fenceMatch = raw.match(/```(?:json)?\s*([\s\S]*?)```/)
  if (fenceMatch) {
    try {
      const parsed = JSON.parse(fenceMatch[1].trim())
      if (isBlockArray(parsed)) return parsed
      if (parsed && typeof parsed.type === 'string') return [parsed]
    } catch { /* fall through */ }
  }

  // 3. JSON array embedded in surrounding prose — find the outermost [ ... ]
  const firstBracket = raw.indexOf('[')
  const lastBracket = raw.lastIndexOf(']')
  if (firstBracket !== -1 && lastBracket > firstBracket) {
    try {
      const parsed = JSON.parse(raw.slice(firstBracket, lastBracket + 1))
      if (isBlockArray(parsed)) return parsed
    } catch { /* fall through */ }
  }

  // 4. Last resort: wrap as text
  return [{ type: 'text', content: raw }]
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

    // Upsert the session row — use jsonb_insert for atomic append.
    // The old `history || exchange` was NOT atomic under concurrent writes —
    // two concurrent appends could both read the same history and last-write-wins.
    // jsonb_insert with array position '-1' appends atomically in a single UPDATE.
    // Also cap history to prevent unbounded growth (MAX_CORTEX_HISTORY_SIZE exchanges).
    const MAX_CORTEX_HISTORY_SIZE = parseInt(env.CORTEX_MAX_HISTORY_SIZE || '200', 10)
    await db`
      INSERT INTO cortex_sessions (id, history, updated_at)
      VALUES (${sessionId}, ${JSON.stringify([exchange])}, now())
      ON CONFLICT (id) DO UPDATE
      SET
        history = CASE
          WHEN jsonb_array_length(cortex_sessions.history) >= ${MAX_CORTEX_HISTORY_SIZE}
          THEN (cortex_sessions.history - 0) || jsonb_build_array(${JSON.stringify(exchange)}::jsonb)
          ELSE cortex_sessions.history || jsonb_build_array(${JSON.stringify(exchange)}::jsonb)
        END,
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
