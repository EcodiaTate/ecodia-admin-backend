const db = require('../config/db')
const logger = require('../config/logger')
const metabolismBridge = require('../services/metabolismBridgeService')
const { recordHeartbeat } = require('./heartbeat')

// Integration pollers — called on AI decision, not on schedule
const workspacePollers = (() => {
  try { return require('./workspacePoller') } catch { return {} }
})()
const gmailPoller = (() => {
  try { return require('./gmailPoller') } catch { return {} }
})()

// Track last poll times so the AI can reason about staleness
const _lastPolled = {}

// Track recently dispatched intents to prevent duplicate actions
// Map<normalised_error_key, timestamp_ms>
const _recentDispatches = new Map()
const COOLDOWN_MS = 2 * 60 * 60 * 1000  // 2 hours

// Consecutive empty cycles counter — for adaptive backoff
let _emptyCycles = 0
const MAX_DECISIONS_PER_CYCLE = parseInt(process.env.MAINTENANCE_MAX_DECISIONS || '3')

// ═══════════════════════════════════════════════════════════════════════
// AUTONOMOUS MAINTENANCE WORKER
//
// No cron schedules. No hardcoded task types. No "audit at 3am".
//
// One loop. One mind. Every cycle it reads the full state of the system
// and decides what maintenance work is needed right now — not what we
// programmed it to do at a particular time.
//
// The mind is DeepSeek. The system state is everything we know.
// The actions are Factory sessions, dispatched by intent, not by type.
//
// This is the difference between a system that follows instructions
// and one that has judgment.
//
// Cycle interval: adapts to pressure (15min idle → 5min under stress).
// ═══════════════════════════════════════════════════════════════════════

let running = false
let cycleTimer = null
let inCycle = false  // prevent concurrent cycles from event triggers + scheduled timer

// Named handlers so they can be removed on stop()
async function _onDeployFailed() {
  if (!running || inCycle) return
  logger.info('AutonomousMaintenanceWorker: deploy failure detected — requesting immediate cycle')
  await runCycle()
}

async function _onKGPrediction(payload) {
  if (!running || inCycle) return
  if (payload.importance) {
    logger.info(`AutonomousMaintenanceWorker: KG prediction (importance: ${payload.importance}) — considering maintenance`)
    await runCycle()
  }
}

async function _onOrganismPercept(percept) {
  if (!running || inCycle) return
  if (percept.salience >= 0.8) {
    logger.info(`AutonomousMaintenanceWorker: high-salience organism percept (${percept.percept_type}, salience: ${percept.salience}) — triggering cycle`)
    await runCycle()
  }
}

// ─── Start ────────────────────────────────────────────────────────────

function start() {
  if (running) return
  running = true
  logger.info('AutonomousMaintenanceWorker: started')
  scheduleCycle()
  try {
    const eventBus = require('../services/internalEventBusService')
    eventBus.on('factory:deploy_failed', _onDeployFailed)
    eventBus.on('kg:prediction_created', _onKGPrediction)
    eventBus.on('organism:cognitive_broadcast', _onOrganismPercept)
  } catch {}
}

function stop() {
  running = false
  if (cycleTimer) clearTimeout(cycleTimer)
  try {
    const eventBus = require('../services/internalEventBusService')
    eventBus.off('factory:deploy_failed', _onDeployFailed)
    eventBus.off('kg:prediction_created', _onKGPrediction)
    eventBus.off('organism:cognitive_broadcast', _onOrganismPercept)
  } catch {}
  logger.info('AutonomousMaintenanceWorker: stopped')
}

function scheduleCycle() {
  if (!running) return
  const pressure = metabolismBridge.getPressure()

  // Under stress, check more frequently — problems compound
  // At rest, give the system breathing room
  // If nothing to do for several cycles, back off further — don't burn cycles on nothing
  let intervalMs = pressure > 0.7 ? 5 * 60 * 1000      // 5 min under high pressure
                 : pressure > 0.4 ? 10 * 60 * 1000     // 10 min moderate
                 : 15 * 60 * 1000                        // 15 min at rest

  // Empty-cycle backoff: after 3+ consecutive empty cycles, stretch interval (up to 30min)
  if (_emptyCycles >= 3) {
    const backoffMultiplier = Math.min(_emptyCycles - 2, 3)  // 1x, 2x, 3x
    intervalMs = Math.min(intervalMs * (1 + backoffMultiplier), 30 * 60 * 1000)
  }

  cycleTimer = setTimeout(async () => {
    await runCycle()
    scheduleCycle()
  }, intervalMs)
}

// ─── The Cycle ────────────────────────────────────────────────────────
// Read. Think. Act. That's all.

async function runCycle() {
  if (inCycle) {
    logger.debug('AutonomousMaintenanceWorker: cycle already in progress — skipping')
    return
  }
  inCycle = true
  const cycleStart = Date.now()

  try {
    // 1. Build a complete picture of system state
    const state = await readSystemState()

    // 2. Ask the mind what this system needs right now
    const allDecisions = await thinkAboutMaintenance(state)

    // 3. Apply decision cap — prevent runaway dispatching
    const capped = allDecisions.slice(0, MAX_DECISIONS_PER_CYCLE)
    if (allDecisions.length > MAX_DECISIONS_PER_CYCLE) {
      logger.info(`AutonomousMaintenanceWorker: capped ${allDecisions.length} decisions to ${MAX_DECISIONS_PER_CYCLE}`)
    }

    // 4. Apply cooldown — skip decisions targeting recently-dispatched patterns
    const now = Date.now()
    const decisions = capped.filter(d => {
      const key = _normaliseDecisionKey(d)
      const lastDispatch = _recentDispatches.get(key)
      if (lastDispatch && (now - lastDispatch) < COOLDOWN_MS) {
        logger.debug(`AutonomousMaintenanceWorker: cooldown skip — "${key}" dispatched ${Math.round((now - lastDispatch) / 60000)}min ago`)
        return false
      }
      return true
    })

    // 5. Act on each decision
    let actioned = 0
    for (const decision of decisions) {
      if (await actOnDecision(decision, state)) {
        actioned++
        _recentDispatches.set(_normaliseDecisionKey(decision), now)
      }
    }

    // Track empty cycles for adaptive backoff
    if (decisions.length === 0) {
      _emptyCycles++
    } else {
      _emptyCycles = 0
    }

    // Expire old cooldown entries
    for (const [key, ts] of _recentDispatches) {
      if (now - ts > COOLDOWN_MS) _recentDispatches.delete(key)
    }

    await recordHeartbeat('autonomous_maintenance', 'active')
    logger.info(`AutonomousMaintenanceWorker: cycle complete — ${allDecisions.length} decisions, ${decisions.length} after cap+cooldown, ${actioned} actioned, empty streak: ${_emptyCycles} (${Date.now() - cycleStart}ms)`)

    // Feed cycle outcome into KG — richer signal for learning
    const kgHooks = require('../services/kgIngestionHooks')
    kgHooks.onSystemEvent({
      type: 'maintenance_cycle',
      decisions: allDecisions.length,
      afterCooldown: decisions.length,
      actioned,
      emptyCycleStreak: _emptyCycles,
      pressure: metabolismBridge.getPressure(),
    }).catch(() => {})

  } catch (err) {
    logger.error('AutonomousMaintenanceWorker: cycle failed', { error: err.message })
    await recordHeartbeat('autonomous_maintenance', 'error', err.message)
  } finally {
    inCycle = false
  }
}

// ─── Read System State ────────────────────────────────────────────────
// Gather everything that could be relevant to maintenance decisions.
// No filtering — the mind decides what matters.

async function readSystemState() {
  const state = {
    timestamp: new Date().toISOString(),
    pressure: metabolismBridge.getPressure(),
    metabolicTier: metabolismBridge.getMetabolicTier(),
  }

  await Promise.allSettled([
    // Codebase health
    db`SELECT id, name, repo_path, language, last_indexed_at FROM codebases`.then(rows => {
      state.codebases = rows
    }),

    // Recent Factory sessions — success rate, error patterns, confidence
    db`
      SELECT
        count(*)::int AS total,
        count(*) FILTER (WHERE status = 'complete')::int AS complete,
        count(*) FILTER (WHERE status = 'error')::int AS errors,
        round(avg(confidence_score)::numeric, 2) AS avg_confidence,
        max(started_at) AS last_session
      FROM cc_sessions
      WHERE started_at > now() - interval '48 hours'
    `.then(([r]) => { state.factoryHealth = r }),

    // Recent error messages (distinct patterns)
    db`
      SELECT error_message, count(*)::int AS occurrences, max(started_at) AS last_seen
      FROM cc_sessions
      WHERE status = 'error' AND started_at > now() - interval '7 days' AND error_message IS NOT NULL
      GROUP BY error_message
      ORDER BY occurrences DESC LIMIT 5
    `.then(rows => { state.errorPatterns = rows }),

    // Last maintenance actions — with outcome signal (did errors drop after?)
    db`
      SELECT s.initial_prompt, s.status, s.started_at, s.confidence_score,
        (SELECT count(*)::int FROM cc_sessions e
         WHERE e.status = 'error' AND e.started_at > s.completed_at
           AND e.started_at < s.completed_at + interval '24 hours'
        ) AS errors_after_24h
      FROM cc_sessions s
      WHERE s.triggered_by = 'scheduled' AND s.started_at > now() - interval '7 days'
      ORDER BY s.started_at DESC LIMIT 10
    `.then(rows => { state.recentMaintenance = rows }),

    // KG insights that haven't been acted on
    db`
      SELECT description, created_at, importance
      FROM notifications
      WHERE type IN ('kg_pattern', 'kg_prediction', 'kg_insight')
        AND read = false
        AND created_at > now() - interval '48 hours'
      ORDER BY importance DESC LIMIT 5
    `.catch(() => []).then(rows => { state.pendingKGInsights = rows }),

    // Validation trend — are confidence scores improving or declining?
    db`
      SELECT
        date_trunc('day', started_at) AS day,
        round(avg(confidence_score)::numeric, 2) AS avg_confidence,
        count(*)::int AS sessions
      FROM cc_sessions
      WHERE started_at > now() - interval '14 days'
        AND confidence_score IS NOT NULL
      GROUP BY day ORDER BY day
    `.then(rows => { state.confidenceTrend = rows }),

    // Action queue pressure — backlog signal
    db`
      SELECT count(*)::int AS pending, count(*) FILTER (WHERE priority = 'urgent')::int AS urgent
      FROM action_queue WHERE status = 'pending' AND (expires_at IS NULL OR expires_at > now())
    `.then(([r]) => { state.actionQueuePressure = r }),

    // Application errors (last 48h) — the system sees its own failures
    db`
      SELECT message, module, path, count(*)::int AS occurrences, max(created_at) AS last_seen
      FROM app_errors
      WHERE created_at > now() - interval '48 hours'
      GROUP BY message, module, path
      ORDER BY occurrences DESC
      LIMIT 10
    `.catch(() => []).then(rows => { state.appErrors = rows }),
  ])

  // Integration staleness — how long since each service was polled
  const now = Date.now()
  state.integrationStaleness = {
    gmail:       _lastPolled.gmail       ? Math.round((now - _lastPolled.gmail)       / 60000) : null,
    google_drive: _lastPolled.google_drive ? Math.round((now - _lastPolled.google_drive) / 60000) : null,
    vercel:      _lastPolled.vercel      ? Math.round((now - _lastPolled.vercel)      / 60000) : null,
    meta:        _lastPolled.meta        ? Math.round((now - _lastPolled.meta)        / 60000) : null,
  }

  // Git activity runs after DB queries — needs state.codebases populated first
  state.gitActivity = []
  if (state.codebases?.length) {
    const { execFileSync } = require('child_process')
    const fs = require('fs')
    for (const cb of state.codebases) {
      if (!cb.repo_path || !fs.existsSync(cb.repo_path)) continue
      try {
        const out = execFileSync('git', ['log', '--oneline', '--since=24 hours ago'], {
          cwd: cb.repo_path, encoding: 'utf-8', timeout: 10_000,
        }).trim()
        const commits = out ? out.split('\n').length : 0
        if (commits > 0) state.gitActivity.push({ name: cb.name, commits })
      } catch {}
    }
  }

  return state
}

// ─── Think About Maintenance ──────────────────────────────────────────
// Ask DeepSeek: given this system state, what should happen now?
// Returns an array of decisions — each has intent and target codebase.

async function thinkAboutMaintenance(state) {
  const deepseekService = require('../services/deepseekService')
  const pressure = state.pressure

  // Build a compact, honest system brief
  const brief = buildSystemBrief(state)

  const systemPrompt = `You are the autonomous maintenance intelligence of EcodiaOS. You see the full system state and decide what the Factory should work on right now — or nothing, if nothing is warranted.

You have access to the knowledge graph context: recurring patterns, known issues, recent changes, codebase health signals. You are not executing maintenance yourself — you are deciding what to queue for execution.

BUDGET: Each decision dispatches a Factory session (Claude Code). Return at most ${MAX_DECISIONS_PER_CYCLE} decisions per cycle. Prefer fewer, higher-impact actions over many small ones. Returning [] is a valid and often correct response.

OUTCOMES: The "Recent maintenance" section shows whether past actions helped — check the errors-after-24h count. If a previous fix didn't reduce errors, don't repeat the same approach. Investigate differently or escalate.

Think about: what is actually broken or degrading? What has been neglected? What would meaningfully improve reliability or capability right now? Is there a codebase that hasn't been indexed in a long time?

Respond as a JSON array. If nothing is needed, return []. Each decision:
{
  "intent": "concrete, specific prompt for the Factory session — be precise enough that Claude Code can act without clarification",
  "reason": "what you observed that led to this",
  "codebaseHint": "which codebase to target, or omit if not codebase-specific",
  "urgency": "immediate | normal | low",
  "type": "fix | improvement | security | cleanup | investigation | poll"
}

Current time: ${new Date().toISOString()}. Metabolic pressure: ${pressure.toFixed(2)}. Empty cycle streak: ${_emptyCycles}.`

  const userMessage = brief

  try {
    const raw = await deepseekService.callDeepSeek(
      [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userMessage },
      ],
      {
        module: 'autonomous_maintenance',
        skipRetrieval: false,
        skipLogging: false,
        contextQuery: 'system health maintenance codebase quality',
      }
    )

    // Parse the JSON response — the mind speaks in structured decisions
    const parsed = parseDecisions(raw)
    logger.info(`AutonomousMaintenanceWorker: mind returned ${parsed.length} decision(s)`)
    return parsed

  } catch (err) {
    logger.warn('AutonomousMaintenanceWorker: mind call failed', { error: err.message })
    // Fallback: if the mind is unreachable, use simple heuristics
    return fallbackHeuristics(state)
  }
}

// ─── Poll Registry ───────────────────────────────────────────────────
// Open registry — any module can register a poll function at runtime.
// The AI can request any name; if it's registered it runs, if not a warning is logged.

const pollRegistry = new Map([
  ['poll_gmail',    async () => { if (gmailPoller.pollOnce) { await gmailPoller.pollOnce(); _lastPolled.gmail = Date.now() } }],
  ['poll_drive',    async () => { if (workspacePollers.pollDrive) { await workspacePollers.pollDrive(); _lastPolled.google_drive = Date.now() } }],
  ['extract_drive', async () => { if (workspacePollers.extractDriveContent) await workspacePollers.extractDriveContent() }],
  ['embed_drive',   async () => { if (workspacePollers.embedDriveFiles) await workspacePollers.embedDriveFiles() }],
  ['poll_vercel',   async () => { if (workspacePollers.pollVercel) { await workspacePollers.pollVercel(); _lastPolled.vercel = Date.now() } }],
  ['poll_meta',     async () => { if (workspacePollers.pollMeta) { await workspacePollers.pollMeta(); _lastPolled.meta = Date.now() } }],
  ['expire_queue',  async () => { if (workspacePollers.expireStaleActions) await workspacePollers.expireStaleActions() }],
])

/**
 * Register a poll function so the AI can request it by name.
 * Other modules call this at boot time to expand what the AI can poll.
 *
 * @param {string} name  - the poll name the AI will use in decision.intent
 * @param {Function} fn  - async function to execute
 */
function registerPoll(name, fn) {
  pollRegistry.set(name, fn)
  logger.debug(`AutonomousMaintenanceWorker: poll registered — ${name}`)
}

// ─── Act On Decision ─────────────────────────────────────────────────

async function actOnDecision(decision, state) {
  if (!decision.intent) return false

  // Direct integration poll — no Factory session needed
  if (decision.type === 'poll') {
    const pollFn = pollRegistry.get(decision.intent)
    if (!pollFn) {
      logger.warn(`AutonomousMaintenanceWorker: unknown poll name — ${decision.intent} (not in registry)`)
      return false
    }
    try {
      logger.info(`AutonomousMaintenanceWorker: polling — ${decision.intent}`)
      await pollFn()
      return true
    } catch (err) {
      logger.warn(`AutonomousMaintenanceWorker: poll failed — ${decision.intent}`, { error: err.message })
      return false
    }
  }

  try {
    // Skip Factory dispatch if CLI is rate-limited — no point spawning sessions that will fail
    const ccService = require('../services/ccService')
    const rlStatus = ccService.getRateLimitStatus()
    if (rlStatus.limited) {
      const resetsIn = Math.ceil((rlStatus.resetsAt - new Date()) / 60000)
      logger.debug(`AutonomousMaintenanceWorker: skipping dispatch — CLI rate-limited, resets in ${resetsIn}min`)
      return false
    }

    const triggers = require('../services/factoryTriggerService')

    // Find the codebase — by hint or by highest recent activity
    let codebaseId = null
    if (decision.codebaseHint && state.codebases) {
      const hint = decision.codebaseHint.toLowerCase()
      const match = state.codebases.find(cb => cb.name?.toLowerCase() === hint)
        ?? state.codebases.find(cb => cb.name?.toLowerCase().includes(hint))
      if (match) codebaseId = match.id
    }

    // If no codebase hint but there's git activity, prefer the most active
    if (!codebaseId && decision.type !== 'investigation') {
      const mostActive = state.gitActivity?.[0]
      if (mostActive && state.codebases) {
        const match = state.codebases.find(cb => cb.name === mostActive.name)
        if (match) codebaseId = match.id
      }
    }

    logger.info(`AutonomousMaintenanceWorker: acting — "${decision.intent.slice(0, 80)}..." [${decision.type}, ${decision.urgency}]`)

    // Embed urgency and context into the prompt — dispatchFromSchedule only passes prompt through
    const urgencyPrefix = decision.urgency === 'immediate' ? '[URGENT] ' : ''
    const contextSuffix = decision.reason ? `\n\nContext: ${decision.reason}` : ''

    await triggers.dispatchFromSchedule({
      codebaseId,
      prompt: `${urgencyPrefix}${decision.intent}${contextSuffix}`,
    })

    return true
  } catch (err) {
    logger.warn('AutonomousMaintenanceWorker: dispatch failed', { error: err.message, intent: decision.intent?.slice(0, 60) })
    return false
  }
}

// ─── Build System Brief ───────────────────────────────────────────────
// Compact, honest summary of state for the mind's context.

function buildSystemBrief(state) {
  const lines = []

  lines.push(`Metabolic pressure: ${state.pressure.toFixed(2)} (${state.metabolicTier})`)

  if (state.factoryHealth) {
    const h = state.factoryHealth
    const successRate = h.total > 0 ? Math.round((h.complete / h.total) * 100) : 'N/A'
    lines.push(`Factory (48h): ${h.total} sessions, ${successRate}% success, avg confidence ${h.avg_confidence ?? 'N/A'}`)
    lines.push(`Last session: ${h.last_session ? new Date(h.last_session).toISOString() : 'never'}`)
  }

  if (state.errorPatterns?.length > 0) {
    lines.push(`\nRecurring errors (7d):`)
    state.errorPatterns.forEach(e =>
      lines.push(`  ${e.occurrences}x: ${e.error_message?.slice(0, 100)}`)
    )
  }

  if (state.gitActivity?.length > 0) {
    lines.push(`\nGit activity (24h): ${state.gitActivity.map(g => `${g.name} (${g.commits} commits)`).join(', ')}`)
  }

  if (state.confidenceTrend?.length >= 2) {
    const trend = state.confidenceTrend
    const first = parseFloat(trend[0]?.avg_confidence || 0)
    const last = parseFloat(trend[trend.length - 1]?.avg_confidence || 0)
    const direction = last > first ? 'improving' : last < first ? 'declining' : 'stable'
    lines.push(`Confidence trend (14d): ${direction} (${first.toFixed(2)} → ${last.toFixed(2)})`)
  }

  if (state.codebases?.length > 0) {
    lines.push(`\nCodebases:`)
    state.codebases.forEach(cb => {
      const indexAge = cb.last_indexed_at
        ? `indexed ${Math.round((Date.now() - new Date(cb.last_indexed_at).getTime()) / 3600000)}h ago`
        : 'never indexed'
      lines.push(`  ${cb.name} (${cb.language || '?'}) — ${indexAge}`)
    })
  }

  if (state.recentMaintenance?.length > 0) {
    lines.push(`\nRecent maintenance (7d — did it help?):`)
    state.recentMaintenance.slice(0, 5).forEach(s => {
      const outcome = s.errors_after_24h != null ? `, ${s.errors_after_24h} errors in 24h after` : ''
      const conf = s.confidence_score != null ? ` conf:${s.confidence_score}` : ''
      lines.push(`  [${s.status}${conf}${outcome}] ${s.initial_prompt?.slice(0, 80)} — ${new Date(s.started_at).toLocaleDateString()}`)
    })
  }

  if (state.pendingKGInsights?.length > 0) {
    lines.push(`\nPending KG insights (not yet acted on):`)
    state.pendingKGInsights.forEach(i =>
      lines.push(`  [${i.importance?.toFixed(2) || '?'}] ${i.description?.slice(0, 100)}`)
    )
  }

  if (state.actionQueuePressure) {
    const q = state.actionQueuePressure
    if (q.pending > 10 || q.urgent > 0) {
      lines.push(`\nAction queue: ${q.pending} pending${q.urgent > 0 ? `, ${q.urgent} urgent` : ''}`)
    }
  }

  if (state.appErrors?.length > 0) {
    lines.push(`\nApplication errors (48h):`)
    state.appErrors.forEach(e =>
      lines.push(`  ${e.occurrences}x [${e.module || e.path || 'unknown'}]: ${e.message?.slice(0, 120)}`)
    )
  }

  if (state.integrationStaleness) {
    const stale = Object.entries(state.integrationStaleness)
      .map(([k, v]) => `${k}: ${v === null ? 'never polled' : `${v}min ago`}`)
      .join(', ')
    lines.push(`\nIntegration staleness: ${stale}`)
    lines.push(`(To poll an integration, return type: "poll" and intent: one of: poll_gmail, poll_drive, extract_drive, embed_drive, poll_vercel, poll_meta, expire_queue)`)
  }

  return lines.join('\n')
}

// ─── Decision Key Normalisation ──────────────────────────────────────
// Extracts a stable key from a decision so we can detect duplicates
// across cycles even when DeepSeek phrases the same intent differently.

function _normaliseDecisionKey(decision) {
  // For polls, the intent IS the key
  if (decision.type === 'poll') return decision.intent
  // For fixes targeting error patterns, extract the core error text
  const errorMatch = decision.intent?.match(/error[:\s]+(.{20,80})/i)
  if (errorMatch) return `fix:${errorMatch[1].trim().toLowerCase().slice(0, 60)}`
  // Fallback: type + first 50 chars of intent, lowercased
  return `${decision.type || 'unknown'}:${(decision.intent || '').toLowerCase().slice(0, 50).trim()}`
}

// ─── Parse Decisions ──────────────────────────────────────────────────

function parseDecisions(raw) {
  try {
    const trimmed = raw.trim()
    // Handle both bare array and ```json wrapped
    const jsonStr = trimmed.startsWith('[')
      ? trimmed
      : trimmed.match(/```(?:json)?\s*([\s\S]*?)```/)?.[1] || trimmed

    const parsed = JSON.parse(jsonStr)
    if (!Array.isArray(parsed)) return []

    return parsed
      .filter(d => d && typeof d.intent === 'string' && d.intent.length > 10)

  } catch (err) {
    logger.debug('AutonomousMaintenanceWorker: could not parse decisions', { raw: raw?.slice(0, 200) })
    return []
  }
}

// ─── Fallback Heuristics ──────────────────────────────────────────────
// When the mind is unreachable, very simple signal-based fallback.
// Not a replacement — just graceful degradation.

function fallbackHeuristics(state) {
  const decisions = []
  const pressure = state.pressure

  const pressureThreshold = parseFloat(process.env.MAINTENANCE_FALLBACK_PRESSURE_THRESHOLD || '0.7')
  const minOccurrences = parseInt(process.env.MAINTENANCE_FALLBACK_MIN_OCCURRENCES || '3')

  // Only react under high pressure (mind should handle everything else)
  if (pressure > pressureThreshold && state.errorPatterns?.length > 0) {
    const worst = state.errorPatterns[0]
    if (worst.occurrences >= minOccurrences) {
      decisions.push({
        intent: `Investigate and fix recurring error pattern (${worst.occurrences} occurrences in 7 days): ${worst.error_message?.slice(0, 200)}`,
        reason: 'High error frequency detected during mind outage — fallback heuristic',
        urgency: 'immediate',
        type: 'fix',
      })
    }
  }

  return decisions
}

module.exports = { start, stop, runCycle, registerPoll }
