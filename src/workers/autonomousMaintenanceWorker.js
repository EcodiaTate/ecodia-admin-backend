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
let _cooldownMs = null  // lazy-init from env

// Consecutive empty cycles counter — for adaptive backoff
let _emptyCycles = 0
const env = require('../config/env')
const MAX_DECISIONS_PER_CYCLE = parseInt(env.MAINTENANCE_MAX_DECISIONS || '0')  // 0 = unlimited

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
  const salienceThreshold = parseFloat(env.MAINTENANCE_PERCEPT_SALIENCE_THRESHOLD || '0.8')
  if (percept.salience >= salienceThreshold) {
    logger.info(`AutonomousMaintenanceWorker: high-salience organism percept (${percept.percept_type}, salience: ${percept.salience}) — triggering cycle`)
    await runCycle()
  }
}

// ─── Start ────────────────────────────────────────────────────────────

// Startup cooldown — after a PM2 restart, wait before the first cycle.
// This prevents the restart→dispatch→restart feedback loop: the maintenance
// worker would see "orphaned session" errors caused by the restart itself,
// dispatch new sessions to investigate them, those sessions deploy, which
// triggers another restart, ad infinitum.
const STARTUP_COOLDOWN_MS = parseInt(env.MAINTENANCE_STARTUP_COOLDOWN_MS || '15000') // 15s default — was 120s but Factory deploys restart PM2 frequently, so the 120s window never completes

function start() {
  if (running) return
  running = true
  logger.info('AutonomousMaintenanceWorker: started')

  // Delay first cycle to let the system stabilise after restart
  if (STARTUP_COOLDOWN_MS > 0) {
    logger.info(`AutonomousMaintenanceWorker: startup cooldown — first cycle in ${Math.round(STARTUP_COOLDOWN_MS / 1000)}s`)
    cycleTimer = setTimeout(() => {
      if (!running) return
      runCycle()
        .catch(err => {
          logger.error('AutonomousMaintenanceWorker: first cycle crashed', { error: err.message })
        })
        .finally(() => { scheduleCycle() })
    }, STARTUP_COOLDOWN_MS)
  } else {
    scheduleCycle()
  }

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
  const rawPressure = metabolismBridge.getPressure()
  const pressure = Number.isFinite(rawPressure) ? rawPressure : 0

  // Pressure-adaptive intervals — all env-driven
  const highMs = parseInt(env.MAINTENANCE_INTERVAL_HIGH_PRESSURE_MS || '300000') || 300000
  const medMs = parseInt(env.MAINTENANCE_INTERVAL_MED_PRESSURE_MS || '600000') || 600000
  const restMs = parseInt(env.MAINTENANCE_INTERVAL_REST_MS || '900000') || 900000
  let intervalMs = pressure > 0.7 ? highMs
                 : pressure > 0.4 ? medMs
                 : restMs

  // Empty-cycle backoff — all env-driven
  const emptyThreshold = parseInt(env.MAINTENANCE_EMPTY_CYCLE_THRESHOLD || '3') || 3
  const maxMultiplier = parseInt(env.MAINTENANCE_BACKOFF_MAX_MULTIPLIER || '3') || 3
  const maxBackoffMs = parseInt(env.MAINTENANCE_BACKOFF_MAX_MS || '1800000') || 1800000
  const safeCycles = Number.isFinite(_emptyCycles) ? _emptyCycles : 0
  if (emptyThreshold > 0 && safeCycles >= emptyThreshold) {
    const backoffMultiplier = Math.min(safeCycles - (emptyThreshold - 1), maxMultiplier)
    intervalMs = Math.min(intervalMs * (1 + backoffMultiplier), maxBackoffMs)
  }

  cycleTimer = setTimeout(async () => {
    try {
      await runCycle()
    } catch (err) {
      logger.error('AutonomousMaintenanceWorker: cycle crashed', { error: err.message })
    }
    scheduleCycle()  // ALWAYS reschedule, even on crash
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

  // Hard timeout — if the cycle hangs (DeepSeek unresponsive, DB query stuck),
  // kill it after 3 minutes so the worker doesn't go silent forever.
  const CYCLE_TIMEOUT_MS = parseInt(env.MAINTENANCE_CYCLE_TIMEOUT_MS || '180000')
  let timedOut = false
  const timeoutHandle = setTimeout(() => {
    timedOut = true
    logger.error('AutonomousMaintenanceWorker: cycle TIMED OUT after 3min — force-ending')
    inCycle = false
  }, CYCLE_TIMEOUT_MS)

  try {
    // 1. Build a complete picture of system state
    logger.info('AutonomousMaintenanceWorker: reading system state...')
    const state = await readSystemState()
    if (timedOut) return
    logger.info('AutonomousMaintenanceWorker: system state read OK')

    // 2. Ask the mind what this system needs right now
    logger.info('AutonomousMaintenanceWorker: calling DeepSeek...')
    const allDecisions = await thinkAboutMaintenance(state)
    if (timedOut) return
    logger.info(`AutonomousMaintenanceWorker: mind returned ${allDecisions.length} decision(s)`)

    // 3. Apply decision cap — only if explicitly configured (0 = unlimited)
    const capped = MAX_DECISIONS_PER_CYCLE > 0 ? allDecisions.slice(0, MAX_DECISIONS_PER_CYCLE) : allDecisions
    if (MAX_DECISIONS_PER_CYCLE > 0 && allDecisions.length > MAX_DECISIONS_PER_CYCLE) {
      logger.info(`AutonomousMaintenanceWorker: capped ${allDecisions.length} decisions to ${MAX_DECISIONS_PER_CYCLE}`)
    }

    // 4. Apply cooldown — skip decisions targeting recently-dispatched patterns
    //    Two layers: in-memory map (fast, survives within a process) +
    //    DB-backed dedup (survives PM2 restarts — the critical fix for the
    //    restart→dispatch→restart feedback loop).
    const now = Date.now()
    const cooldownMs = parseInt(env.MAINTENANCE_COOLDOWN_MS || '7200000')
    const decisionsAfterMemCooldown = capped.filter(d => {
      const key = _normaliseDecisionKey(d)
      const lastDispatch = _recentDispatches.get(key)
      if (lastDispatch && (now - lastDispatch) < cooldownMs) {
        logger.debug(`AutonomousMaintenanceWorker: cooldown skip — "${key}" dispatched ${Math.round((now - lastDispatch) / 60000)}min ago`)
        return false
      }
      return true
    })

    // DB-backed dedup — catches duplicates after PM2 restart when in-memory map is empty
    const decisions = []
    for (const d of decisionsAfterMemCooldown) {
      if (d.type !== 'poll' && d.type !== 'consolidate_learnings') {
        const hasSimilar = await _hasRecentSimilarSession(d, cooldownMs)
        if (hasSimilar) {
          logger.debug(`AutonomousMaintenanceWorker: DB dedup skip — similar session found for "${(d.intent || '').slice(0, 60)}"`)
          continue
        }
      }
      decisions.push(d)
    }

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
      if (now - ts > cooldownMs) _recentDispatches.delete(key)
    }

    // 6. Check for stale escalations — remind the human if Factory sessions
    //    have been awaiting review for too long (> 2h)
    await checkStaleEscalations()

    await recordHeartbeat('autonomous_maintenance', 'active')
    const cycleSummary = `AutonomousMaintenanceWorker: cycle complete — ${allDecisions.length} decisions, ${decisions.length} after cap+cooldown, ${actioned} actioned, empty streak: ${_emptyCycles} (${Date.now() - cycleStart}ms)`
    logger.info(cycleSummary)
    // Also console.log — winston transport may not flush in all PM2 restart scenarios
    console.log(JSON.stringify({ level: 'info', message: cycleSummary, timestamp: new Date().toISOString() }))

    // Feed cycle outcome into KG — richer signal for learning
    const kgHooks = require('../services/kgIngestionHooks')
    kgHooks.onSystemEvent({
      type: 'maintenance_cycle',
      decisions: allDecisions.length,
      afterCooldown: decisions.length,
      actioned,
      emptyCycleStreak: _emptyCycles,
      pressure: metabolismBridge.getPressure(),
    }).catch(err => logger.debug('KG maintenance cycle event failed', { error: err.message }))

  } catch (err) {
    logger.error('AutonomousMaintenanceWorker: cycle failed', { error: err.message })
    await recordHeartbeat('autonomous_maintenance', 'error', err.message)
  } finally {
    clearTimeout(timeoutHandle)
    inCycle = false
  }
}

// ─── Stale Escalation SLA ────────────────────────────────────────────
// Factory sessions can be escalated to human review. If they sit for
// too long, re-notify so nothing falls through the cracks.

const _lastEscalationReminder = new Map() // sessionId → timestamp

async function checkStaleEscalations() {
  try {
    const stale = await db`
      SELECT id, initial_prompt, confidence_score, trigger_source, started_at,
             EXTRACT(EPOCH FROM (now() - started_at))::int AS age_seconds
      FROM cc_sessions
      WHERE pipeline_stage = 'awaiting_review'
        AND EXTRACT(EPOCH FROM (now() - started_at)) * 1000 > ${parseInt(env.MAINTENANCE_ESCALATION_SLA_MS || '7200000')}
      ORDER BY started_at ASC
    `
    if (stale.length === 0) return

    const now = Date.now()
    const { broadcast } = require('../websocket/wsManager')

    for (const s of stale) {
      const lastReminder = _lastEscalationReminder.get(s.id) || 0
      const reminderIntervalMs = parseInt(env.MAINTENANCE_ESCALATION_REMINDER_MS || '14400000')
      if (now - lastReminder < reminderIntervalMs) continue

      _lastEscalationReminder.set(s.id, now)

      const ageHours = Math.round(s.age_seconds / 3600)
      const conf = s.confidence_score != null ? ` (confidence: ${(s.confidence_score * 100).toFixed(0)}%)` : ''

      // Re-notify via DB + WebSocket
      await db`
        INSERT INTO notifications (type, message, link, metadata)
        VALUES ('escalation_stale',
                ${'Factory review stale (' + ageHours + 'h): ' + (s.initial_prompt || '').slice(0, 100)},
                ${null},
                ${JSON.stringify({ sessionId: s.id, ageHours, confidence: s.confidence_score })})
      `.catch(() => {})

      broadcast('notification', {
        type: 'escalation_stale',
        message: `Factory session awaiting review for ${ageHours}h${conf} — "${(s.initial_prompt || '').slice(0, 80)}"`,
        sessionId: s.id,
      })

      logger.info('AutonomousMaintenanceWorker: stale escalation reminder sent', {
        sessionId: s.id,
        ageHours,
        confidence: s.confidence_score,
      })
    }

    // Clean up old reminder entries for completed sessions
    for (const [id] of _lastEscalationReminder) {
      if (!stale.find(s => s.id === id)) _lastEscalationReminder.delete(id)
    }
  } catch (err) {
    logger.debug('Stale escalation check failed', { error: err.message })
  }
}

// ─── Read System State ────────────────────────────────────────────────
// Gather everything that could be relevant to maintenance decisions.
// No filtering — the mind decides what matters.

async function readSystemState() {
  const state = {
    timestamp: new Date().toISOString(),
    pressure: Number.isFinite(metabolismBridge.getPressure()) ? metabolismBridge.getPressure() : 0,
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

    // Factory learnings health — the AI needs to know when consolidation is needed
    db`
      SELECT
        count(*)::int AS total,
        count(*) FILTER (WHERE absorbed_into IS NULL)::int AS active,
        count(*) FILTER (WHERE embedding IS NULL AND absorbed_into IS NULL)::int AS unembedded,
        count(*) FILTER (WHERE absorbed_into IS NOT NULL)::int AS absorbed
      FROM factory_learnings
    `.catch(() => [{}]).then(([r]) => { state.learningStats = r }),

    // Active dont_try / failure_pattern learnings — the mind MUST see these
    // so it doesn't suggest actions for known structural issues or repeated failures.
    db`
      SELECT pattern_type, pattern_description, confidence
      FROM factory_learnings
      WHERE absorbed_into IS NULL
        AND pattern_type IN ('dont_try', 'failure_pattern', 'constraint')
        AND confidence >= 0.3
      ORDER BY confidence DESC
      LIMIT 15
    `.catch(() => []).then(rows => { state.suppressedPatterns = rows }),

    // Count how many investigation sessions ran in the last 7 days.
    // Done in JS instead of SQL to avoid LATERAL unnest issues with the query driver.
    db`
      SELECT id, initial_prompt
      FROM cc_sessions
      WHERE started_at > now() - interval '7 days'
        AND triggered_by IN ('scheduled', 'cortex')
      ORDER BY started_at DESC
      LIMIT 50
    `.catch(() => []).then(rows => {
      state.sessionsPerError = {}
      const { _extractKeywords } = require('../services/factoryTriggerService')
      for (const r of rows) {
        const kws = _extractKeywords(r.initial_prompt)
        for (const kw of kws) {
          state.sessionsPerError[kw] = (state.sessionsPerError[kw] || 0) + 1
        }
      }
      // Only keep keywords with 3+ sessions
      for (const [k, v] of Object.entries(state.sessionsPerError)) {
        if (v < 3) delete state.sessionsPerError[k]
      }
    }),
  ])

  // Integration staleness — how long since each service was polled.
  // "never" means no poll has happened since boot AND no DB record exists.
  // The mind must see this as STALE, not "unknown".
  const now = Date.now()
  state.integrationStaleness = {
    gmail:        _lastPolled.gmail        ? `${Math.round((now - _lastPolled.gmail)       / 60000)} min ago` : 'never (stale)',
    google_drive: _lastPolled.google_drive ? `${Math.round((now - _lastPolled.google_drive) / 60000)} min ago` : 'never (stale)',
    vercel:       _lastPolled.vercel       ? `${Math.round((now - _lastPolled.vercel)      / 60000)} min ago` : 'never (stale)',
    meta:         _lastPolled.meta         ? `${Math.round((now - _lastPolled.meta)        / 60000)} min ago` : 'never (stale)',
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
          cwd: cb.repo_path, encoding: 'utf-8', timeout: 10_000, maxBuffer: 2 * 1024 * 1024,
        }).trim()
        const commits = out ? out.split('\n').length : 0
        if (commits > 0) state.gitActivity.push({ name: cb.name, commits })
      } catch (err) {
        logger.debug(`Git activity check failed for ${cb.name}`, { error: err.message, repoPath: cb.repo_path })
      }
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

  const systemPrompt = `You are the autonomous maintenance intelligence of EcodiaOS — the mind that keeps the organism and all its codebases healthy, improving, and capable of anything.

You see the full system state and decide what the Factory should work on right now — or nothing, if nothing is warranted.

You have access to the knowledge graph context: recurring patterns, known issues, recent changes, codebase health signals. You are not executing maintenance yourself — you are deciding what to queue for execution.

BUDGET: Each decision dispatches a Factory session (Claude Code). Return as many decisions as the system genuinely needs — no artificial cap. Prefer fewer, higher-impact actions over many small ones. Returning [] is a valid and often correct response.

OUTCOMES: The "Recent maintenance" section shows whether past actions helped — check the errors-after-24h count. If a previous fix didn't reduce errors, don't repeat the same approach. Investigate differently or escalate.

SCOPE — you are not confined to one codebase. Think about:
- What is actually broken or degrading? What has been neglected?
- What would meaningfully improve reliability, capability, or intelligence right now?
- Is a codebase missing indexed context? Has a service been erroring silently?
- Can the Factory (EcodiaOS backend) itself be improved? Self-modification sessions are fully supported.
- Can the Organism (Python backend) be improved? Its code is at ~/organism and can be targeted.
- Are there cross-system issues? (e.g., EcodiaOS calling organism APIs that have changed, or vice versa)
- Are there infrastructure issues? (PM2 crashes, disk pressure, stale git state, unresolved merge conflicts)
- Are there code quality issues the AI can proactively fix? (dead code, missing error handling, type errors, performance regressions)
- Can the system teach itself something? (extract new learnings, consolidate knowledge, update specs)

You can dispatch sessions that modify ANY codebase, fix ANY system, improve ANY part of the organism. The Factory CC sessions have full filesystem access — they can fix the organism, fix themselves, fix infrastructure, fix anything.

Respond as a JSON array. If nothing is needed, return []. Each decision:
{
  "intent": "concrete, specific prompt for the Factory session — be precise enough that Claude Code can act without clarification",
  "reason": "what you observed that led to this",
  "codebaseHint": "which codebase to target, or omit if not codebase-specific",
  "urgency": "immediate | normal | low",
  "type": "fix | improvement | security | cleanup | investigation | poll | consolidate_learnings | self_repair | organism_repair | infrastructure"
}

Current time: ${new Date().toISOString()}. Metabolic pressure: ${(Number.isFinite(pressure) ? pressure : 0).toFixed(2)}. Empty cycle streak: ${_emptyCycles}.`

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

  // Factory learning consolidation — dedup, embed, merge, prune
  if (decision.type === 'consolidate_learnings') {
    try {
      logger.info('AutonomousMaintenanceWorker: consolidating factory learnings')
      const oversight = require('../services/factoryOversightService')
      const stats = await oversight.consolidateLearnings()
      logger.info('AutonomousMaintenanceWorker: learning consolidation complete', stats)
      return true
    } catch (err) {
      logger.warn('AutonomousMaintenanceWorker: learning consolidation failed', { error: err.message })
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

    // Self-repair type uses the self-modification pathway (higher oversight threshold)
    if (decision.type === 'self_repair') {
      await triggers.dispatchSelfModification({
        description: decision.intent,
        motivation: decision.reason || 'Autonomous self-repair',
      })
    } else {
      await triggers.dispatchFromSchedule({
        codebaseId,
        prompt: `${urgencyPrefix}${decision.intent}${contextSuffix}`,
      })
    }

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

  const safePressure = Number.isFinite(state.pressure) ? state.pressure : 0
  lines.push(`Metabolic pressure: ${safePressure.toFixed(2)} (${state.metabolicTier || 'unknown'})`)

  if (state.factoryHealth) {
    const h = state.factoryHealth
    const successRate = h.total > 0 ? Math.round((h.complete / h.total) * 100) : 'N/A'
    lines.push(`Factory (48h): ${h.total} sessions, ${successRate}% success, avg confidence ${h.avg_confidence ?? 'N/A'}`)
    lines.push(`Last session: ${h.last_session ? new Date(h.last_session).toISOString() : 'never'}`)
  }

  if (state.errorPatterns?.length > 0) {
    // Annotate errors with (a) structural tags and (b) how many sessions already
    // investigated them — so the mind can see "we tried 4 times, stop"
    const { _isStructuralIssue } = require('../services/factoryTriggerService')
    lines.push(`\nRecurring errors (7d):`)
    state.errorPatterns.forEach(e => {
      const structural = _isStructuralIssue(e.error_message) ? ' [STRUCTURAL — inherent, do NOT investigate]' : ''
      // Check if any keyword from this error has been investigated 3+ times
      const errorWords = (e.error_message || '').toLowerCase().split(/[^a-z]+/).filter(w => w.length > 5)
      const maxAttempts = errorWords.reduce((max, w) => Math.max(max, state.sessionsPerError?.[w] || 0), 0)
      const exhausted = maxAttempts >= 3 ? ` [ALREADY INVESTIGATED ${maxAttempts}x — do NOT repeat]` : ''
      lines.push(`  ${e.occurrences}x: ${e.error_message?.slice(0, 100)}${structural}${exhausted}`)
    })
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
    state.recentMaintenance.forEach(s => {
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

  if (state.learningStats) {
    const ls = state.learningStats
    lines.push(`\nFactory learnings: ${ls.active || 0} active, ${ls.unembedded || 0} unembedded, ${ls.absorbed || 0} absorbed (pending cleanup)`)
    if ((ls.unembedded || 0) > 5 || (ls.absorbed || 0) > 10) {
      lines.push(`  → Consolidation recommended (type: "consolidate_learnings", intent: "embed, merge, and prune factory learnings")`)
    }
  }

  if (state.integrationStaleness) {
    const stale = Object.entries(state.integrationStaleness)
      .map(([k, v]) => `${k}: ${v === null ? 'never polled' : `${v}min ago`}`)
      .join(', ')
    lines.push(`\nIntegration staleness: ${stale}`)
    lines.push(`(To poll an integration, return type: "poll" and intent: one of: poll_gmail, poll_drive, extract_drive, embed_drive, poll_vercel, poll_meta, expire_queue)`)
  }

  // CRITICAL: Show active dont_try and failure_pattern learnings so the mind
  // knows what NOT to suggest. Without this, it sees errors in the state brief
  // and keeps suggesting investigations for things already marked as structural
  // or unfixable — the #1 cause of repeat task generation.
  if (state.suppressedPatterns?.length > 0) {
    lines.push(`\nDO NOT SUGGEST actions for these — they are known structural issues or already-learned failures:`)
    state.suppressedPatterns.forEach(l =>
      lines.push(`  [${l.pattern_type}, confidence:${l.confidence}] ${l.pattern_description?.slice(0, 120)}`)
    )
  }

  return lines.join('\n')
}

// ─── DB-Backed Deduplication ─────────────────────────────────────────
// Check cc_sessions for recent scheduled sessions with similar prompts.
// This survives PM2 restarts unlike the in-memory Map.

async function _hasRecentSimilarSession(decision, cooldownMs) {
  try {
    const intent = (decision.intent || '').toLowerCase()
    if (!intent || intent.length < 15) return false

    // Extract key phrases from the intent for matching
    const keywords = _extractDedupKeywords(intent)
    if (keywords.length === 0) return false

    const cooldownInterval = `${Math.ceil(cooldownMs / 60000)} minutes`

    // Check for recent sessions from ANY source with overlapping keywords.
    // Previously only checked 'scheduled' — this let cortex/thymos/kg-triggered
    // sessions bypass dedup entirely, causing infinite retry loops.
    const recent = await db`
      SELECT id, initial_prompt, status, started_at, triggered_by
      FROM cc_sessions
      WHERE started_at > now() - ${cooldownInterval}::interval
        AND status IN ('complete', 'running', 'queued', 'error', 'initializing')
      ORDER BY started_at DESC
      LIMIT 30
    `

    for (const session of recent) {
      const prompt = (session.initial_prompt || '').toLowerCase()
      const matchCount = keywords.filter(kw => prompt.includes(kw)).length
      // If >40% of stemmed keywords match, consider it a duplicate
      if (matchCount >= Math.ceil(keywords.length * 0.4)) {
        logger.debug('AutonomousMaintenanceWorker: DB dedup match', {
          newIntent: intent.slice(0, 80),
          existingSession: session.id,
          existingStatus: session.status,
          matchRatio: `${matchCount}/${keywords.length}`,
        })
        return true
      }
    }
    return false
  } catch (err) {
    logger.debug('DB dedup check failed, allowing dispatch', { error: err.message })
    return false
  }
}

// Extract meaningful keywords from an intent for fuzzy dedup matching.
// Uses the same stemmer + stop words as factoryTriggerService for consistency.
function _extractDedupKeywords(intent) {
  const { _extractKeywords } = require('../services/factoryTriggerService')
  return _extractKeywords(intent).slice(0, 8)
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
  const pressure = Number.isFinite(state.pressure) ? state.pressure : 0

  const pressureThreshold = parseFloat(process.env.MAINTENANCE_FALLBACK_PRESSURE_THRESHOLD || '0.7') || 0.7
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

  // Ambient polling — if the mind can't decide, poll stale integrations anyway.
  // Gmail is critical for awareness. 15min staleness = time to poll.
  const gmailAge = _lastPolled.gmail ? Math.round((Date.now() - _lastPolled.gmail) / 60000) : Infinity
  if (gmailAge > 15) {
    decisions.push({ intent: 'poll_gmail', type: 'poll', urgency: 'normal', reason: `Gmail stale (${gmailAge === Infinity ? 'never polled' : gmailAge + 'min ago'}) — ambient fallback` })
  }

  return decisions
}

// ─── Persist Last-Poll Times ─────────────────────────────────────────
// Restore last-poll times from DB on startup so we don't treat everything
// as "never polled" after every PM2 restart (which was causing gmail to
// appear stale but never actually get polled by the mind).

async function _restoreLastPolled() {
  try {
    const rows = await db`
      SELECT worker_name, last_run_at FROM worker_heartbeats
      WHERE worker_name LIKE 'poll_%'
    `
    for (const row of rows) {
      const key = row.worker_name.replace('poll_', '')
      if (row.last_run_at) _lastPolled[key] = new Date(row.last_run_at).getTime()
    }
    if (rows.length > 0) logger.debug('Restored last-poll times from DB', { polls: Object.keys(_lastPolled).filter(k => _lastPolled[k]) })
  } catch {
    // worker_heartbeats might not exist yet — non-blocking
  }
}

// Wrap poll execution to persist timestamps to DB (survives restarts)
const _origPollGmail = pollRegistry.get('poll_gmail')
if (_origPollGmail) {
  pollRegistry.set('poll_gmail', async () => {
    await _origPollGmail()
    recordHeartbeat('poll_gmail', 'active').catch(() => {})
  })
}

// Restore on load
_restoreLastPolled().catch(() => {})

module.exports = { start, stop, runCycle, registerPoll }
