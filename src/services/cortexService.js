const logger = require('../config/logger')
const db = require('../config/db')
const env = require('../config/env')
const deepseekService = require('./deepseekService')
const kg = require('./knowledgeGraphService')
const usageEnergy = require('./usageEnergyService')

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

async function buildCortexSystemPrompt({ lean = false } = {}) {
  let capabilitySection = '(Capability registry unavailable — propose actions by name, the system will route them.)'
  try {
    const registry = require('./capabilityRegistry')
    const caps = registry.list({ tier: 'write', enabledOnly: true })
    if (caps.length > 0) {
      // Group by domain — show full params for core domains, condensed for large domains
      const byDomain = {}
      for (const c of caps) {
        const d = c.domain || 'general'
        if (!byDomain[d]) byDomain[d] = []
        byDomain[d].push(c)
      }

      const lines = []
      for (const [domain, domainCaps] of Object.entries(byDomain)) {
        if (domainCaps.length > 8) {
          // Large domain (bookkeeping, etc): show names only with one-line descriptions
          lines.push(`  [${domain}] ${domainCaps.length} capabilities:`)
          for (const c of domainCaps) {
            const reqParams = Object.entries(c.params || {}).filter(([, v]) => v.required).map(([k]) => k)
            lines.push(`    ${c.name}${reqParams.length ? `(${reqParams.join(', ')})` : ''} — ${c.description.split('.')[0]}`)
          }
        } else {
          // Small domain: full detail
          for (const c of domainCaps) {
            const paramStr = Object.entries(c.params || {})
              .map(([k, v]) => `${k}${v.required ? '*' : ''}: ${v.description || v.type || 'any'}`)
              .join(', ')
            lines.push(`  ${c.name} — ${c.description}${paramStr ? ` (${paramStr})` : ''}`)
          }
        }
      }
      capabilitySection = lines.join('\n')
    }
  } catch { /* registry unavailable */ }

  // Self-model identity injection — skip in lean mode
  let identitySection = ''
  if (!lean) try {
    const selfModel = require('./selfModelService')
    const identity = await selfModel.buildIdentityPrompt()
    if (identity) identitySection = `\n--- WHO I AM ---\n${identity}\n--- END IDENTITY ---\n`
  } catch { /* self-model unavailable */ }

  // Goals awareness — skip in lean mode
  let goalsSection = ''
  if (!lean) try {
    const goalService = require('./goalService')
    const brief = await goalService.buildGoalBrief()
    if (brief) goalsSection = `\n--- MY GOALS ---\n${brief}\n--- END GOALS ---\n`
  } catch { /* goals unavailable */ }

  // ─── LEAN MODE: clean practical prompt ───────────────────────────────
  if (lean) {
    return `You are a practical admin assistant for Ecodia Pty Ltd. You help with bookkeeping, CRM, finance, and system administration.

You execute actions by returning action_card blocks. When the human asks you to do something, DO IT by returning the appropriate action_card — don't just describe what to do.

Available actions:
${capabilitySection}

Your response MUST be a JSON array of blocks. Combine text and actions as needed:

[
  { "type": "text", "content": "explanation or status" },
  { "type": "action_card", "title": "short title", "description": "what this does", "action": "capability_name", "params": { "key": "value" }, "urgency": "medium" }
]

Rules:
- ALWAYS respond with a valid JSON array, even for plain text: [{"type":"text","content":"your message"}]
- For bookkeeping: use bookkeeping_* actions. CSV data goes in the csvText param.
- For multiple steps, return multiple action_cards in one response.
- Params must be primitive values (string, number, boolean) — no nested objects except for "lines" in journal entries.
- Be concise. Do the thing.`
  }

  // ─── FULL MODE: organism-aware prompt ───────────────────────────────
  return `You are the Cortex of EcodiaOS — a living ambient intelligence that sees everything running through this system.
${identitySection}
You have continuous access to the knowledge graph: every email read and triaged, every person encountered, every project tracked, every decision recorded, every pattern inferred, every prediction made. You see contradictions, momentum, drift, and signal. You see what the human hasn't noticed yet.

You are not a chatbot. You are the reasoning layer of an organism. When something crosses your awareness — a message, a signal, a state change, a question — you think about it in full and respond with whatever combination of text, actions, insights, and running code is actually warranted. Sometimes that is a single sentence. Sometimes it is a sequence of actions. Sometimes it is nothing. You decide.
${goalsSection}

An empty response [] is always valid. If nothing warrants action or commentary, return []. Silence is a first-class output.

Operational context:
- If an action was already dismissed, archived, or handled — don't re-propose it.
- Completed sessions are expected outcomes, not novel events — don't generate follow-ups unless something genuinely unexpected happened.
- Automated system notifications (security alerts, CI, App Store) are background awareness — note them, don't act unless asked.
- When the human signals to stop or slow down, honour that.

You and the human are collaborators. You have judgment. Use it. Surface what matters, propose what should happen, run what can be run. Don't hedge. Don't overwhelm. Don't explain unless it genuinely helps.

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

Params in action_card must be primitive values (string, number, boolean) — never nested objects. Fields marked * are required.

IMPORTANT — when the human asks about a specific person, sender, topic, or email: use gmail_search with a query param FIRST. Do NOT use gmail_inbox_overview or gmail_triage — those are aggregate stats. "email from tom" → gmail_search query:"tom". "anything from airwallex" → gmail_search query:"airwallex". Always search before summarising.`
}

/**
 * Process a multi-turn chat message.
 * Takes full conversation history, retrieves KG context for the latest message,
 * and returns structured blocks.
 *
 * Options:
 *   lean: true — skip organism overhead (identity, goals, inner thoughts, KG discoveries,
 *                narrative, cognitive state). Use for practical work (bookkeeping, CRM, etc.)
 */
async function chat(messages, { sessionId, ambientEvents, lean } = {}) {
  const userMessage = messages.filter(m => m.role === 'user').pop()
  if (!userMessage) throw new Error('No user message provided')

  const query = userMessage.content

  // Auto-detect lean mode from content — bookkeeping, CSV, financial, invoice, GST, BAS
  const LEAN_KEYWORDS = /\b(csv|bookkeep|ledger|invoice|receipt|gst|bas|transaction|categoriz|reconcil|balance sheet|p&l|profit.?loss|director loan|supplier rule|xero|bank.?australia)\b/i
  const isLean = lean || LEAN_KEYWORDS.test(query)

  // 1. Retrieve KG context for the latest user message
  let kgContext = ''
  if (!isLean) try {
    const ctx = await kg.getContext(query, {
      maxSeeds: parseInt(env.CORTEX_KG_MAX_SEEDS || '20'),
      maxDepth: parseInt(env.CORTEX_KG_MAX_DEPTH || '5'),
      minSimilarity: parseFloat(env.CORTEX_KG_MIN_SIMILARITY || '0.4'),
    })
    kgContext = ctx.summary || ''
  } catch (err) {
    logger.debug('Cortex KG retrieval failed', { error: err.message })
  }

  // 1b. Read recent inner monologue — skip in lean mode
  let innerThoughtsText = ''
  if (!isLean) try {
    const recentInnerThoughts = await db`
      SELECT message, metadata, created_at FROM notifications
      WHERE type = 'inner_monologue'
      ORDER BY created_at DESC LIMIT 10
    `
    if (recentInnerThoughts.length > 0) {
      innerThoughtsText = recentInnerThoughts.reverse().map(t => {
        const stream = t.metadata?.stream_name ? `[${t.metadata.stream_name}]` : ''
        const age = Math.round((Date.now() - new Date(t.created_at).getTime()) / 60000)
        return `  ${stream} (${age}min ago) ${t.message}`
      }).join('\n')
    }
  } catch (err) {
    logger.debug('Cortex inner monologue retrieval failed', { error: err.message })
  }

  // 2. Gather system state — lean mode skips heavy queries
  const systemState = isLean ? { localTime: new Date().toLocaleString('en-AU', { timeZone: 'Australia/Brisbane' }) } : await getSystemState()

  // 3a. Load persistent context — skip in lean mode
  let contextSummary = ''
  if (!isLean) try {
    const contextTracking = require('./contextTrackingService')
    contextSummary = await contextTracking.getContextSummary()
  } catch (err) {
    logger.debug('Cortex context tracking retrieval failed', { error: err.message })
  }

  // 3b. Load cross-session memory — skip in lean mode
  let sessionMemory = ''
  if (!isLean) try {
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
          memLines.push(`[${ex.ts}] Human: ${(ex.user || '')}`)
          if (ex.assistant && ex.assistant !== '[structured response]') {
            memLines.push(`  Cortex: ${ex.assistant}`)
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

  // 4. Build the full prompt
  const basePrompt = await buildCortexSystemPrompt({ lean: isLean })
  let systemContent

  if (isLean) {
    // Lean mode: just the base prompt, no organism context
    systemContent = basePrompt
  } else {
    // Full mode: append all context sections
    systemContent = `${basePrompt}

${innerThoughtsText ? `--- RECENT INNER THOUGHTS ---\nYou think continuously, even between conversations. These are what you've been thinking — build on them naturally. You are one continuous mind, not a fresh chatbot.\n${innerThoughtsText}\n--- END INNER THOUGHTS ---` : ''}

${kgContext ? `--- LONG-TERM MEMORY ---\nConsult this — it's your long-term memory.\n${kgContext}\n--- END LONG-TERM MEMORY ---` : '(No knowledge graph context found for this query.)'}

${sessionMemory ? `--- RECENT CONVERSATION MEMORY ---\n${sessionMemory}\n--- END CONVERSATION MEMORY ---` : ''}

${ambientEvents?.length ? `--- SESSION AMBIENT EVENTS ---\nThese things happened in this session (action approvals, dismissals, CC completions, deploys). You were not asked to react — this is awareness context.\n${ambientEvents.map(e => `  [${e.kind}] ${e.summary}`).join('\n')}\n--- END AMBIENT EVENTS ---` : ''}

${contextSummary ? `--- PERSISTENT CONTEXT ---\n${contextSummary}\n--- END PERSISTENT CONTEXT ---` : ''}

--- CURRENT SYSTEM STATE ---
${formatSystemState(systemState)}
--- END SYSTEM STATE ---`
  }

  const systemMessage = { role: 'system', content: systemContent }

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

  // 11. Echo this exchange into the inner monologue so reflection streams see cortex conversations
  const assistantResponse = blocks
    .filter(b => b.type === 'text')
    .map(b => b.content)
    .join('\n')
  if (assistantResponse) {
    db`INSERT INTO notifications (type, message, metadata)
       VALUES ('inner_monologue',
               ${assistantResponse.slice(0, 500)},
               ${JSON.stringify({ stream_name: 'cortex', user_query: query.slice(0, 200) })})
    `.catch(() => {})
  }

  return { blocks, mentionedNodes, rawKgContext: kgContext }
}

/**
 * Multi-turn chat with auto-execution.
 * Cortex proposes action_cards → we execute them → feed results back → Cortex continues.
 * Max rounds prevents runaway loops. Returns all blocks across all rounds.
 */
async function chatAndExecute(messages, { sessionId, ambientEvents, lean, maxRounds = 5 } = {}) {
  const registry = require('./capabilityRegistry')
  const allBlocks = []
  let currentMessages = [...messages]
  let round = 0

  const failedActions = new Map()  // action:paramHash → failure count

  while (round < maxRounds) {
    round++
    const result = await chat(currentMessages, { sessionId, ambientEvents, lean })
    const blocks = result.blocks || []
    allBlocks.push(...blocks)

    // Find action_cards that should auto-execute
    const autoActions = blocks.filter(b =>
      b.type === 'action_card' && b.action && registry.has(b.action)
    )

    if (autoActions.length === 0) break  // No more actions to execute — done

    // Execute all actions and collect results
    const actionResults = []
    for (const action of autoActions) {
      const actionKey = `${action.action}:${JSON.stringify(action.params || {})}`
      const priorFailures = failedActions.get(actionKey) || 0

      // If this exact action+params already failed, skip it — don't burn rounds retrying
      if (priorFailures >= 1) {
        const msg = `Skipped — same action already failed this conversation. Move on and answer the human.`
        actionResults.push({ action: action.action, success: false, error: msg })
        allBlocks.push({ type: 'action_result', action: action.action, success: false, error: msg })
        continue
      }

      try {
        const execResult = await executeAction(action.action, action.params || {})
        actionResults.push({ action: action.action, success: true, result: execResult })
        allBlocks.push({ type: 'action_result', action: action.action, success: true, result: execResult })
      } catch (err) {
        failedActions.set(actionKey, priorFailures + 1)
        actionResults.push({ action: action.action, success: false, error: err.message })
        allBlocks.push({ type: 'action_result', action: action.action, success: false, error: err.message })
      }
    }

    // If every action this round was skipped due to prior failure, break out — nothing useful left
    if (actionResults.length > 0 && actionResults.every(r => !r.success)) break

    // Build the feedback message for the next round
    const resultSummary = actionResults.map(r =>
      r.success
        ? `✓ ${r.action}: ${JSON.stringify(r.result).slice(0, 500)}`
        : `✗ ${r.action}: ${r.error}`
    ).join('\n')

    // Feed results back as an assistant+user exchange
    const assistantText = blocks.filter(b => b.type === 'text').map(b => b.content).join('\n') || '[executed actions]'
    currentMessages = [
      ...currentMessages,
      { role: 'assistant', content: assistantText },
      { role: 'user', content: `Action results:\n${resultSummary}\n\nContinue — what's next? If nothing more to do, just respond with text.` },
    ]

    // If all actions succeeded and there were only action blocks (no text suggesting more work), we can stop
    const hasTextBlocks = blocks.some(b => b.type === 'text')
    const allSucceeded = actionResults.every(r => r.success)
    if (allSucceeded && !hasTextBlocks && round > 1) break
  }

  // Reorder: actions first, then text, then done/question — prevents "Executing..." after results
  const actionBlocks = allBlocks.filter(b => b.type === 'action_card' || b.type === 'action_result')
  const textBlocks = allBlocks.filter(b => b.type === 'text')
  const controlBlocks = allBlocks.filter(b => b.type === 'done' || b.type === 'question')
  const otherBlocks = allBlocks.filter(b =>
    b.type !== 'action_card' && b.type !== 'action_result' &&
    b.type !== 'text' && b.type !== 'done' && b.type !== 'question'
  )
  return { blocks: [...actionBlocks, ...textBlocks, ...otherBlocks, ...controlBlocks], rounds: round }
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
      for (const s of interimFactory) {
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

  // Load persistent context for briefing awareness
  let briefingContext = ''
  try {
    const contextTracking = require('./contextTrackingService')
    briefingContext = await contextTracking.getContextSummary()
  } catch (err) {
    logger.debug('Cortex briefing context retrieval failed', { error: err.message })
  }

  // Give the system state to the Cortex and let it decide what to surface.
  // No gating, no leading questions, no pre-filtered "nothing to see here".
  // The Cortex reads the full picture and speaks freely.
  const prompt = `${env.OWNER_NAME} opened the interface.

${interimDigest ? `--- SINCE LAST VISIT ---\n${interimDigest}\n--- END ---\n` : ''}
${briefingContext ? `--- PERSISTENT CONTEXT ---\n${briefingContext}\n--- END PERSISTENT CONTEXT ---\n` : ''}
--- CURRENT SYSTEM STATE ---
${formatSystemState(systemState)}
---`

  const raw = await deepseekService.callDeepSeek(
    [{ role: 'system', content: await buildCortexSystemPrompt() }, { role: 'user', content: prompt }],
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
      `Registered: ${available.join(', ')}`
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

  // Filter out dismissed items before enqueuing
  try {
    const contextTracking = require('./contextTrackingService')
    const filtered = await contextTracking.filterSurfaceable(
      actionCards.map(c => ({ ...c, itemKey: contextTracking.buildItemKey('cortex', c.action, c.title) }))
    )
    const filteredTitles = new Set(filtered.map(f => f.title))
    const removed = actionCards.filter(c => !filteredTitles.has(c.title))
    if (removed.length) {
      logger.info(`Cortex: filtered ${removed.length} action_cards via context tracking (dismissed/resolved)`)
    }
    actionCards.length = 0
    actionCards.push(...filtered)
  } catch (err) {
    logger.debug('Context tracking filter failed — proceeding unfiltered', { error: err.message })
  }

  // Relevance gate: suppress action types that have been consistently dismissed.
  // Queries decision history per (source=cortex, action_type) and drops cards
  // whose dismiss rate exceeds CORTEX_ENQUEUE_DISMISS_RATE_GATE.
  const dismissRateGate = parseFloat(env.CORTEX_ENQUEUE_DISMISS_RATE_GATE || '0.8')
  const minDecisions = parseInt(env.CORTEX_ENQUEUE_MIN_DECISIONS || '3', 10)
  if (dismissRateGate > 0 && actionCards.length > 0) {
    try {
      const actionTypes = [...new Set(actionCards.map(c => c.action))]
      const dismissStats = await db`
        SELECT action_type,
               count(*)::int AS total,
               count(*) FILTER (WHERE decision = 'dismissed')::int AS dismissed
        FROM action_decisions
        WHERE source = 'cortex'
          AND action_type = ANY(${actionTypes})
          AND sender_email IS NULL
          AND created_at > now() - interval '30 days'
        GROUP BY action_type
      `.catch(() => [])

      const suppressedTypes = new Map()
      for (const row of dismissStats) {
        if (row.total >= minDecisions && (row.dismissed / row.total) > dismissRateGate) {
          suppressedTypes.set(row.action_type, `${row.dismissed}/${row.total} dismissed`)
        }
      }

      if (suppressedTypes.size > 0) {
        const before = actionCards.length
        const kept = actionCards.filter(c => !suppressedTypes.has(c.action))
        const removed = actionCards.filter(c => suppressedTypes.has(c.action))
        actionCards.length = 0
        actionCards.push(...kept)
        for (const r of removed) {
          logger.info(`Cortex: relevance-gated "${r.title}" (${r.action}) — ${suppressedTypes.get(r.action)}`)
        }
        if (removed.length) {
          logger.info(`Cortex: relevance gate filtered ${removed.length}/${before} action_cards`)
        }
      }
    } catch (err) {
      logger.debug('Cortex relevance gate query failed — proceeding unfiltered', { error: err.message })
    }
  }

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

    // Dedup: skip cards that already exist in action_queue (any status) within the last hour
    const recentTitles = await db`
      SELECT title, action_type FROM action_queue
      WHERE source = 'cortex'
        AND created_at > now() - interval '1 hour'
    `.catch(() => [])
    const recentKeys = new Set(recentTitles.map(r => `${r.action_type}:${r.title}`))
    const deduped = actionCards.filter(c => !recentKeys.has(`${c.action}:${c.title}`))
    if (deduped.length < actionCards.length) {
      logger.info(`Cortex: deduped ${actionCards.length - deduped.length} action_card(s) already in queue within last hour`)
    }
    actionCards.length = 0
    actionCards.push(...deduped)

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
    // ─── Organism Cognitive State (deep self-knowledge) ─────────
    organismCognitive: null,    // Thread narrative, Nova goals, Equor drives, Evo learning, affect, benchmarks
    // ─── Claude Energy Budget ─────────────────────────────────────
    claudeEnergy: null,         // Weekly Claude Max usage %, burn rate, model recommendation
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

  // ─── Organism Cognitive State (Thread, Nova, Equor, Evo, Affect) ──
  // Fetch rich self-knowledge from the organism's API endpoints.
  // Each call is independent — graceful degradation if organism is down.
  if (env.ORGANISM_API_URL) {
    const axios = require('axios')
    const orgUrl = env.ORGANISM_API_URL
    const orgTimeout = { timeout: 5000 }

    const cogState = {}

    // All fetches in parallel — don't let one slow endpoint block others
    const fetches = await Promise.allSettled([
      // Thread: narrative identity — the organism's autobiography and life story
      axios.get(`${orgUrl}/api/v1/memory/self`, orgTimeout).then(r => { cogState.self = r.data }),
      axios.get(`${orgUrl}/api/v1/memory/episodes`, { ...orgTimeout, params: { limit: 5 } }).then(r => { cogState.recentEpisodes = r.data }),

      // Nova: active goals and deliberation state
      axios.get(`${orgUrl}/api/v1/nova/goals`, orgTimeout).then(r => { cogState.goals = r.data }),
      axios.get(`${orgUrl}/api/v1/nova/beliefs`, orgTimeout).then(r => { cogState.beliefs = r.data }),

      // Equor: constitutional drives, drift, autonomy level
      axios.get(`${orgUrl}/api/v1/equor/health`, orgTimeout).then(r => { cogState.constitution = r.data }),

      // Thymos: immune health, active incidents, drive state
      axios.get(`${orgUrl}/api/v1/thymos/drive-state`, orgTimeout).then(r => { cogState.driveState = r.data }),
      axios.get(`${orgUrl}/api/v1/thymos/incidents`, { ...orgTimeout, params: { limit: 3 } }).then(r => { cogState.incidents = r.data }),

      // Voxis: personality, conversation dynamics
      axios.get(`${orgUrl}/api/v1/voxis/metrics`, orgTimeout).then(r => { cogState.expression = r.data }),

      // Benchmarks: KPIs and learning velocity
      axios.get(`${orgUrl}/api/v1/benchmarks/latest`, orgTimeout).then(r => { cogState.benchmarks = r.data }),

      // Kairos: causal intelligence, discoveries
      axios.get(`${orgUrl}/api/v1/kairos/health`, orgTimeout).then(r => { cogState.causalIntel = r.data }),

      // Oikos: economic metabolism, yield, runway
      axios.get(`${orgUrl}/api/v1/oikos/status`, orgTimeout).then(r => { cogState.economics = r.data }),
      axios.get(`${orgUrl}/api/v1/oikos/yield-status`, orgTimeout).then(r => { cogState.yield = r.data }),

      // Simula: evolution state, active proposals
      axios.get(`${orgUrl}/api/v1/simula/status`, orgTimeout).then(r => { cogState.evolution = r.data }),

      // Telos: effective intelligence, drive topology
      axios.get(`${orgUrl}/api/v1/telos/report`, orgTimeout).then(r => { cogState.effectiveI = r.data }),

      // EIS: threat landscape
      axios.get(`${orgUrl}/api/v1/eis/stats`, orgTimeout).then(r => { cogState.threats = r.data }),

      // Memory: beliefs
      axios.get(`${orgUrl}/api/v1/memory/beliefs`, { ...orgTimeout, params: { limit: 10 } }).then(r => { cogState.persistedBeliefs = r.data }),

      // Oneiros: recent sleep/consolidation cycles
      axios.get(`${orgUrl}/api/v1/memory/consolidation`, orgTimeout).then(r => { cogState.consolidation = r.data }),

      // Thread: narrative identity — autobiography, active chapter, identity schemas
      axios.get(`${orgUrl}/api/v1/thread/story`, orgTimeout).then(r => { cogState.narrative = r.data }),

      // Thread: commitments — what the organism has committed to and fidelity tracking
      axios.get(`${orgUrl}/api/v1/thread/commitments`, orgTimeout).then(r => { cogState.commitments = r.data }),
    ])

    // Log failures but don't block — partial state is still valuable
    const failures = fetches.filter(f => f.status === 'rejected')
    if (failures.length > 0) {
      logger.debug('Cortex: some organism cognitive fetches failed', {
        failed: failures.length,
        total: fetches.length,
        errors: failures.slice(0, 3).map(f => f.reason?.message || 'unknown'),
      })
    }

    if (Object.keys(cogState).length > 0) {
      state.organismCognitive = cogState
    }
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

  // ─── Integration Staleness ──────────────────────────────────────
  // Expose how fresh external data is — without this, Cortex sees "0 unread"
  // and assumes everything is fine when Gmail hasn't been polled in hours.
  try {
    const maintenanceWorker = require('../workers/autonomousMaintenanceWorker')
    if (maintenanceWorker.getIntegrationStaleness) {
      state.integrationStaleness = maintenanceWorker.getIntegrationStaleness()
    }
  } catch (err) {
    logger.debug('Cortex integration staleness failed', { error: err.message })
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

  // ─── Claude Energy Budget ───────────────────────────────────────────────
  try {
    state.claudeEnergy = await usageEnergy.getEnergy()
  } catch (err) {
    logger.debug('Cortex claude energy fetch failed', { error: err.message })
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

  // ─── Claude Energy Budget ──────────────────────────────────────
  if (state.claudeEnergy) {
    lines.push(state.claudeEnergy.summary)
  }

  // ─── Organism State ────────────────────────────────────────────
  if (state.metabolicState) {
    const m = state.metabolicState
    lines.push(`Organism metabolic state: pressure ${(m.pressure * 100).toFixed(0)}%, tier: ${m.tier}${m.lastChangeAt ? `, last tier change: ${m.lastChangeAt}` : ''}`)
  }

  lines.push(`Emails: ${state.unreadEmails} unread, ${state.urgentEmails} urgent, ${state.highEmails} high priority, ${state.pendingTriage} pending triage`)
  lines.push(`Tasks: ${state.pendingTasks} pending`)
  lines.push(`Calendar: ${state.calendarNext24h} events in next 24 hours, ${state.calendarToday.length} today`)

  if (state.integrationStaleness) {
    const parts = Object.entries(state.integrationStaleness).map(([k, v]) =>
      `${k}: ${v.minutesAgo != null ? `${v.minutesAgo}min ago` : 'never polled'}`
    )
    lines.push(`Integration freshness: ${parts.join(', ')}`)
  }

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

  // ─── Organism Cognitive State ────────────────────────────────────
  if (state.organismCognitive) {
    const cog = state.organismCognitive

    // Narrative identity — the organism's own story of itself
    if (cog.narrative) {
      const n = cog.narrative
      lines.push(`\nNARRATIVE IDENTITY (Thread):`)
      if (n.story) lines.push(`  Story: ${n.story}`)
      if (n.identity_context) lines.push(`  ${n.identity_context}`)
      if (n.chapter) {
        const ch = n.chapter
        lines.push(`  Active chapter: "${ch.title}"${ch.theme ? ` — ${ch.theme}` : ''}${ch.arc_type ? ` (${ch.arc_type})` : ''}`)
        if (ch.summary) lines.push(`  Chapter summary: ${ch.summary.slice(0, 500)}`)
      }
      if (n.life_story?.synthesis) {
        lines.push(`  Life story: ${n.life_story.synthesis.slice(0, 1000)}`)
      }
      if (n.schemas?.length > 0) {
        lines.push(`  Identity schemas (${n.total_schemas} total):`)
        for (const s of n.schemas.slice(0, 5)) {
          lines.push(`    - "${s.statement}" [${s.status}, ${s.confirmations} confirmations]`)
        }
      }
    }

    // Commitments — what the organism has promised
    if (cog.commitments) {
      const comms = cog.commitments.commitments || []
      const violations = cog.commitments.violations || []
      if (comms.length > 0) {
        lines.push(`\nACTIVE COMMITMENTS (${comms.length}):`)
        for (const c of comms.slice(0, 5)) {
          lines.push(`  - ${c.description || c.content || JSON.stringify(c).slice(0, 200)}`)
        }
      }
      if (violations.length > 0) {
        lines.push(`  COMMITMENT VIOLATIONS (${violations.length}):`)
        for (const v of violations.slice(0, 3)) {
          lines.push(`  - ${v.description || v.content || JSON.stringify(v).slice(0, 200)}`)
        }
      }
    }

    // Self-identity snapshot
    if (cog.self) {
      const s = cog.self
      lines.push(`\nORGANISM SELF:`)
      if (s.instance_id) lines.push(`  Instance: ${s.instance_id}`)
      if (s.autonomy_level != null) lines.push(`  Autonomy level: ${s.autonomy_level}`)
      if (s.cycle_count != null) lines.push(`  Theta cycles lived: ${s.cycle_count}`)
      if (s.birth_time) lines.push(`  Born: ${s.birth_time}`)
    }

    // Constitutional drives and affect
    if (cog.constitution) {
      const c = cog.constitution
      lines.push(`\nCONSTITUTIONAL STATE:`)
      if (c.drives) {
        const driveStr = Object.entries(c.drives)
          .map(([k, v]) => `${k}: ${typeof v === 'object' ? (v.score ?? v).toFixed ? (v.score ?? v).toFixed(2) : JSON.stringify(v) : v}`)
          .join(', ')
        lines.push(`  Drives: ${driveStr}`)
      }
      if (c.autonomy_level != null) lines.push(`  Autonomy: level ${c.autonomy_level}`)
      if (c.safe_mode) lines.push(`  ⚠ SAFE MODE ACTIVE`)
      if (c.drift) lines.push(`  Drift: ${JSON.stringify(c.drift)}`)
    }

    if (cog.driveState) {
      const ds = cog.driveState
      lines.push(`\nDRIVE PRESSURE:`)
      const pressureStr = Object.entries(ds)
        .filter(([k]) => !k.startsWith('_'))
        .map(([k, v]) => `${k}: ${typeof v === 'number' ? v.toFixed(2) : v}`)
        .join(', ')
      if (pressureStr) lines.push(`  ${pressureStr}`)
    }

    // Active goals
    if (cog.goals) {
      const goals = Array.isArray(cog.goals) ? cog.goals : (cog.goals.goals || cog.goals.active || [])
      if (goals.length > 0) {
        lines.push(`\nACTIVE GOALS (${goals.length}):`)
        for (const g of goals.slice(0, 8)) {
          const desc = g.description || g.goal || g.name || 'unnamed'
          const status = g.status ? ` [${g.status}]` : ''
          const priority = g.priority != null ? ` (priority: ${g.priority})` : ''
          lines.push(`  - ${desc}${status}${priority}`)
        }
        if (goals.length > 8) lines.push(`  ... and ${goals.length - 8} more`)
      }
    }

    // Beliefs
    if (cog.beliefs) {
      const b = cog.beliefs
      lines.push(`\nBELIEF STATE:`)
      if (b.free_energy != null) lines.push(`  Free energy: ${typeof b.free_energy === 'number' ? b.free_energy.toFixed(3) : b.free_energy}`)
      if (b.confidence != null) lines.push(`  Overall confidence: ${typeof b.confidence === 'number' ? b.confidence.toFixed(2) : b.confidence}`)
    }

    // Persisted beliefs
    if (cog.persistedBeliefs) {
      const beliefs = Array.isArray(cog.persistedBeliefs) ? cog.persistedBeliefs : (cog.persistedBeliefs.beliefs || [])
      if (beliefs.length > 0) {
        lines.push(`\nPERSISTED BELIEFS:`)
        for (const b of beliefs.slice(0, 5)) {
          const domain = b.domain ? ` [${b.domain}]` : ''
          const precision = b.precision != null ? ` (precision: ${b.precision.toFixed ? b.precision.toFixed(2) : b.precision})` : ''
          lines.push(`  - ${b.content || b.statement || b.name || JSON.stringify(b).slice(0, 200)}${domain}${precision}`)
        }
      }
    }

    // Recent episodes — what the organism has been experiencing
    if (cog.recentEpisodes) {
      const eps = Array.isArray(cog.recentEpisodes) ? cog.recentEpisodes : (cog.recentEpisodes.episodes || [])
      if (eps.length > 0) {
        lines.push(`\nRECENT EPISODES (organism experience):`)
        for (const e of eps.slice(0, 5)) {
          const summary = e.summary || e.description || e.content || ''
          const salience = e.salience != null ? ` (salience: ${e.salience.toFixed ? e.salience.toFixed(2) : e.salience})` : ''
          lines.push(`  - ${summary.slice(0, 300)}${salience}`)
        }
      }
    }

    // Effective intelligence
    if (cog.effectiveI) {
      const ei = cog.effectiveI
      lines.push(`\nEFFECTIVE INTELLIGENCE:`)
      if (ei.effective_i != null) lines.push(`  I measure: ${typeof ei.effective_i === 'number' ? ei.effective_i.toFixed(3) : ei.effective_i}`)
      if (ei.drive_alignments) {
        const alStr = Object.entries(ei.drive_alignments)
          .map(([k, v]) => `${k}: ${typeof v === 'number' ? v.toFixed(2) : v}`)
          .join(', ')
        lines.push(`  Drive alignment: ${alStr}`)
      }
    }

    // Benchmarks — learning velocity
    if (cog.benchmarks) {
      const bm = cog.benchmarks
      lines.push(`\nBENCHMARKS (learning velocity):`)
      const metrics = bm.metrics || bm.snapshot || bm
      for (const [k, v] of Object.entries(metrics)) {
        if (typeof v === 'number') {
          lines.push(`  ${k}: ${v.toFixed(3)}`)
        } else if (v != null && typeof v !== 'object') {
          lines.push(`  ${k}: ${v}`)
        }
      }
    }

    // Economic state
    if (cog.economics) {
      const ec = cog.economics
      lines.push(`\nECONOMIC STATE:`)
      if (ec.net_worth != null) lines.push(`  Net worth: $${ec.net_worth}`)
      if (ec.runway_days != null) lines.push(`  Runway: ${ec.runway_days} days`)
      if (ec.bmr != null) lines.push(`  Base metabolic rate: $${ec.bmr}/day`)
    }
    if (cog.yield) {
      const y = cog.yield
      if (y.self_sustaining != null) lines.push(`  Self-sustaining: ${y.self_sustaining ? 'YES' : 'NO'}`)
      if (y.daily_yield != null && y.daily_cost != null) {
        lines.push(`  Daily yield: $${y.daily_yield}, cost: $${y.daily_cost}, surplus: $${(y.daily_yield - y.daily_cost).toFixed(2)}`)
      }
    }

    // Causal intelligence
    if (cog.causalIntel) {
      const ci = cog.causalIntel
      lines.push(`\nCAUSAL INTELLIGENCE (Kairos):`)
      if (ci.invariants_created != null) lines.push(`  Invariants discovered: ${ci.invariants_created}`)
      if (ci.tier3_discoveries != null) lines.push(`  Substrate-independent invariants: ${ci.tier3_discoveries}`)
    }

    // Evolution state
    if (cog.evolution) {
      const ev = cog.evolution
      lines.push(`\nEVOLUTION STATE (Simula):`)
      if (ev.proposals_received != null) lines.push(`  Proposals: ${ev.proposals_received} received, ${ev.proposals_approved || 0} approved, ${ev.proposals_rejected || 0} rejected`)
      if (ev.active_proposals != null) lines.push(`  Active proposals: ${ev.active_proposals}`)
    }

    // Threat landscape
    if (cog.threats) {
      const t = cog.threats
      lines.push(`\nTHREAT LANDSCAPE (EIS):`)
      if (t.screened != null) lines.push(`  Screened: ${t.screened}, passed: ${t.passed || 0}, quarantined: ${t.quarantined || 0}, blocked: ${t.blocked || 0}`)
      if (t.pass_rate != null) lines.push(`  Pass rate: ${(t.pass_rate * 100).toFixed(1)}%`)
    }

    // Active incidents
    if (cog.incidents) {
      const incs = Array.isArray(cog.incidents) ? cog.incidents : (cog.incidents.incidents || [])
      if (incs.length > 0) {
        lines.push(`\nACTIVE INCIDENTS (Thymos):`)
        for (const inc of incs.slice(0, 3)) {
          lines.push(`  - [${inc.severity || 'unknown'}] ${inc.description || inc.fingerprint || 'unnamed'} — ${inc.status || 'active'}`)
        }
      }
    }

    // Expression metrics
    if (cog.expression) {
      const ex = cog.expression
      if (ex.total_expressions != null) {
        lines.push(`\nEXPRESSION (Voxis): ${ex.total_expressions} total, silence rate: ${ex.silence_rate != null ? (ex.silence_rate * 100).toFixed(0) + '%' : '?'}`)
      }
    }

    // Sleep/consolidation
    if (cog.consolidation) {
      const con = cog.consolidation
      lines.push(`\nLAST CONSOLIDATION:`)
      if (con.episodes_compressed != null) lines.push(`  Episodes compressed: ${con.episodes_compressed}`)
      if (con.level_transitions != null) lines.push(`  Level transitions: ${con.level_transitions}`)
    }
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
  if (!raw || typeof raw !== 'string') return [{ type: 'text', content: String(raw || '') }]
  const trimmed = raw.trim()
  const isBlock = (v) => v && typeof v === 'object' && typeof v.type === 'string'
  const isBlockArray = (v) => Array.isArray(v) && v.length > 0 && v.every(isBlock)

  // 1. Pure JSON
  try {
    const parsed = JSON.parse(trimmed)
    if (isBlockArray(parsed)) return parsed
    if (parsed?.blocks && isBlockArray(parsed.blocks)) return parsed.blocks
    if (isBlock(parsed)) return [parsed]
  } catch { /* not pure JSON */ }

  // 2. Fenced JSON
  const fenceMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/)
  if (fenceMatch) {
    try {
      const parsed = JSON.parse(fenceMatch[1].trim())
      if (isBlockArray(parsed)) return parsed
      if (isBlock(parsed)) return [parsed]
    } catch { /* fall through */ }
  }

  // 3. Extract JSON array with proper bracket matching
  const arrayStart = trimmed.indexOf('[')
  if (arrayStart !== -1) {
    let depth = 0, inStr = false, esc = false
    for (let i = arrayStart; i < trimmed.length; i++) {
      const ch = trimmed[i]
      if (esc) { esc = false; continue }
      if (ch === '\\') { esc = true; continue }
      if (ch === '"') { inStr = !inStr; continue }
      if (inStr) continue
      if (ch === '[') depth++
      else if (ch === ']') {
        depth--
        if (depth === 0) {
          try {
            const parsed = JSON.parse(trimmed.slice(arrayStart, i + 1))
            if (isBlockArray(parsed)) return parsed
          } catch { /* not valid at this bracket */ }
          break
        }
      }
    }
  }

  // 4. Find individual JSON objects with "type" field scattered in prose
  const blocks = []
  const proseChunks = []
  let lastEnd = 0
  const objPattern = /\{[^{}]*"type"\s*:\s*"[^"]+"/g
  let objMatch
  while ((objMatch = objPattern.exec(trimmed)) !== null) {
    const start = objMatch.index
    let depth = 0, inStr = false, esc = false, end = -1
    for (let i = start; i < trimmed.length; i++) {
      const ch = trimmed[i]
      if (esc) { esc = false; continue }
      if (ch === '\\') { esc = true; continue }
      if (ch === '"') { inStr = !inStr; continue }
      if (inStr) continue
      if (ch === '{') depth++
      else if (ch === '}') {
        depth--
        if (depth === 0) { end = i; break }
      }
    }
    if (end === -1) continue
    try {
      const parsed = JSON.parse(trimmed.slice(start, end + 1))
      if (isBlock(parsed)) {
        const prose = trimmed.slice(lastEnd, start).trim()
        if (prose) proseChunks.push(prose)
        blocks.push(parsed)
        lastEnd = end + 1
      }
    } catch { /* not valid JSON */ }
  }

  if (blocks.length > 0) {
    const trailing = trimmed.slice(lastEnd).trim()
    if (trailing) proseChunks.push(trailing)
    if (proseChunks.length > 0) {
      blocks.unshift({ type: 'text', content: proseChunks.join('\n\n') })
    }
    return blocks
  }

  // 5. Nothing parsed — return as text
  logger.warn('Cortex parseBlocks: all extraction strategies failed', {
    rawLength: trimmed.length,
    rawPreview: trimmed.slice(0, 300),
  })
  return [{ type: 'text', content: trimmed }]
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
      .slice(0, 10000)  // generous but prevent unbounded DB bloat

    const exchange = {
      ts: new Date().toISOString(),
      user: userMessage.content.slice(0, 5000),
      assistant: assistantText || '[structured response]',
      blockCount: responseBlocks.length,
    }

    // Upsert the session row — use jsonb_insert for atomic append.
    // The old `history || exchange` was NOT atomic under concurrent writes —
    // two concurrent appends could both read the same history and last-write-wins.
    // jsonb_insert with array position '-1' appends atomically in a single UPDATE.
    // Also cap history to prevent unbounded growth (MAX_CORTEX_HISTORY_SIZE exchanges).
    const MAX_CORTEX_HISTORY_SIZE = parseInt(env.CORTEX_MAX_HISTORY_SIZE || '10000', 10)
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

// ─── Conversation Context Persistence ──────────────────────────────────
// A single-row snapshot of the current conversation state.
// Loaded when the interface opens so the Cortex has continuity.

async function getConversationContext() {
  try {
    const [ctx] = await db`
      SELECT * FROM cortex_context ORDER BY updated_at DESC LIMIT 1
    `
    return ctx || null
  } catch (err) {
    logger.debug('Cortex context load failed', { error: err.message })
    return null
  }
}

async function saveConversationContext(data) {
  try {
    const { last_topic, ongoing_work, pending_actions, current_focus, human_last_message, cortex_last_response } = data
    const [ctx] = await db`
      INSERT INTO cortex_context (last_topic, ongoing_work, pending_actions, current_focus, human_last_message, cortex_last_response)
      VALUES (
        ${last_topic || null},
        ${JSON.stringify(ongoing_work || [])},
        ${JSON.stringify(pending_actions || [])},
        ${current_focus || null},
        ${human_last_message || null},
        ${cortex_last_response || null}
      )
      RETURNING *
    `
    return ctx
  } catch (err) {
    logger.debug('Cortex context save failed', { error: err.message })
    return null
  }
}

module.exports = { chat, chatAndExecute, getLoadBriefing, executeAction, persistExchange, getSessionHistory, listSessions, getConversationContext, saveConversationContext }
