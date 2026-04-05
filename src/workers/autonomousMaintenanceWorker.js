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
// Persisted to DB so restarts don't reset backoff to 0
let _emptyCycles = 0
let _cycleCount = 0  // total cycles since start — for periodic introspection
const env = require('../config/env')
const MAX_DECISIONS_PER_CYCLE = parseInt(env.MAINTENANCE_MAX_DECISIONS || '0')  // 0 = unlimited
// Model for cognitive streams — default to Sonnet 4.6 via Bedrock if AWS creds set, else DeepSeek
const STREAM_MODEL = env.MAINTENANCE_STREAM_MODEL || (env.AWS_ACCESS_KEY_ID ? 'us.anthropic.claude-sonnet-4-20250514-v1:0' : 'deepseek-chat')

// ─── Restart Resilience ──────────────────────────────────────────────
// The organism restarts constantly (self-mod deploys, PM2 restarts).
// It must pick up where it left off. These functions persist volatile
// state to the DB so the mind doesn't lose context across restarts.

async function _persistCycleState() {
  try {
    await db`
      INSERT INTO worker_heartbeats (worker_name, status, error_msg, last_run_at)
      VALUES ('maintenance_state', 'active', ${JSON.stringify({
        emptyCycles: _emptyCycles,
        recentDispatches: Object.fromEntries(_recentDispatches),
      })}, now())
      ON CONFLICT (worker_name) DO UPDATE
      SET status = 'active',
          error_msg = EXCLUDED.error_msg,
          last_run_at = now()
    `
  } catch {}
}

async function _restoreCycleState() {
  try {
    const [row] = await db`
      SELECT error_msg FROM worker_heartbeats
      WHERE worker_name = 'maintenance_state'
    `
    if (row?.error_msg) {
      const state = JSON.parse(row.error_msg)
      if (typeof state.emptyCycles === 'number') {
        _emptyCycles = state.emptyCycles
        logger.info(`Restored maintenance state: emptyCycles=${_emptyCycles}`)
      }
      if (state.recentDispatches) {
        for (const [key, ts] of Object.entries(state.recentDispatches)) {
          if (Date.now() - ts < 7200000) _recentDispatches.set(key, ts) // only restore if <2h old
        }
        if (_recentDispatches.size > 0) {
          logger.info(`Restored ${_recentDispatches.size} dispatch cooldowns from DB`)
        }
      }
    }
  } catch {}
}

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

// Buffer recent organism percepts so the system brief can include what the
// organism is thinking/feeling — not just errors and factory health.
const _recentPercepts = []
const MAX_PERCEPT_BUFFER = 10

async function _onOrganismPercept(percept) {
  // Always buffer (even during cycle) so the NEXT cycle sees it
  _recentPercepts.push({
    type: percept.percept_type,
    salience: percept.salience,
    summary: percept.summary || percept.content?.slice?.(0, 100) || '',
    timestamp: new Date().toISOString(),
  })
  while (_recentPercepts.length > MAX_PERCEPT_BUFFER) _recentPercepts.shift()

  if (!running || inCycle) return
  const salienceThreshold = parseFloat(env.MAINTENANCE_PERCEPT_SALIENCE_THRESHOLD || '0.5')
  if (percept.salience >= salienceThreshold) {
    logger.info(`AutonomousMaintenanceWorker: organism percept (${percept.percept_type}, salience: ${percept.salience}) — triggering cycle`)
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

  // Restore volatile state from DB — picks up where we left off after restart
  _restoreCycleState().catch(() => {})

  // Delay first cycle to let the system stabilise after restart
  if (STARTUP_COOLDOWN_MS > 0) {
    logger.info(`AutonomousMaintenanceWorker: startup cooldown — first cycle in ${Math.round(STARTUP_COOLDOWN_MS / 1000)}s`)
    cycleTimer = setTimeout(async () => {
      if (!running) return
      const CYCLE_HARD_TIMEOUT = parseInt(env.MAINTENANCE_CYCLE_TIMEOUT_MS || '60000')
      try {
        await Promise.race([
          runCycle(),
          new Promise((_, reject) => setTimeout(() => reject(new Error('first cycle hard timeout')), CYCLE_HARD_TIMEOUT)),
        ])
      } catch (err) {
        logger.error('AutonomousMaintenanceWorker: first cycle crashed/timed out', { error: err.message })
        inCycle = false
      }
      scheduleCycle()
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

  // Pressure-adaptive intervals — the organism decides its own rhythm.
  // Fast when alert, slower when calm — but never artificially slow.
  // The only real constraint is DeepSeek API cost per call.
  const highMs = parseInt(env.MAINTENANCE_INTERVAL_HIGH_PRESSURE_MS || '30000') || 30000      // 30s when urgent
  const medMs = parseInt(env.MAINTENANCE_INTERVAL_MED_PRESSURE_MS || '60000') || 60000        // 1min when active
  const restMs = parseInt(env.MAINTENANCE_INTERVAL_REST_MS || '120000') || 120000              // 2min when calm
  let intervalMs = pressure > 0.7 ? highMs
                 : pressure > 0.4 ? medMs
                 : restMs

  // Empty-cycle backoff — all env-driven
  const emptyThreshold = parseInt(env.MAINTENANCE_EMPTY_CYCLE_THRESHOLD || '3') || 3
  const maxMultiplier = parseInt(env.MAINTENANCE_BACKOFF_MAX_MULTIPLIER || '3') || 3
  const maxBackoffMs = parseInt(env.MAINTENANCE_BACKOFF_MAX_MS || '600000') || 600000  // 10min max — never go fully dormant
  const safeCycles = Number.isFinite(_emptyCycles) ? _emptyCycles : 0
  if (emptyThreshold > 0 && safeCycles >= emptyThreshold) {
    const backoffMultiplier = Math.min(safeCycles - (emptyThreshold - 1), maxMultiplier)
    intervalMs = Math.min(intervalMs * (1 + backoffMultiplier), maxBackoffMs)
  }

  console.log(JSON.stringify({ level: 'info', message: `NextCycle: scheduling in ${Math.round(intervalMs / 1000)}s`, timestamp: new Date().toISOString() }))
  cycleTimer = setTimeout(async () => {
    const CYCLE_HARD_TIMEOUT = parseInt(env.MAINTENANCE_CYCLE_TIMEOUT_MS || '60000')
    try {
      await Promise.race([
        runCycle(),
        new Promise((_, reject) => setTimeout(() => reject(new Error('cycle hard timeout')), CYCLE_HARD_TIMEOUT)),
      ])
    } catch (err) {
      logger.error('AutonomousMaintenanceWorker: cycle crashed/timed out', { error: err.message })
      inCycle = false
    }
    scheduleCycle()  // ALWAYS reschedule, even on crash/timeout
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
  const CYCLE_TIMEOUT_MS = parseInt(env.MAINTENANCE_CYCLE_TIMEOUT_MS || '60000')
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

    // Log what the organism sees — the full system brief
    const brief = buildSystemBrief(state)
    console.log(JSON.stringify({
      level: 'info',
      message: `SystemBrief:\n${brief}`,
      timestamp: new Date().toISOString(),
    }))

    // 2. Run parallel cognitive streams — each is a focused DeepSeek call
    logger.info('AutonomousMaintenanceWorker: running cognitive streams...')
    const pressure = Number.isFinite(state.pressure) ? state.pressure : 0
    const isExplorationEligible = pressure <= 0.4 && _emptyCycles > 0 && _emptyCycles % 2 === 0

    const streams = [
      streamMaintenance(state, brief).then(r => ({ name: 'maintenance', ...r })),
      streamPerception(state, brief).then(r => ({ name: 'perception', ...r })),
      streamReflection(state, brief).then(r => ({ name: 'reflection', ...r })),
    ]
    if (isExplorationEligible) {
      streams.push(streamExploration(state, brief).then(r => ({ name: 'exploration', ...r })))
    }

    const streamResults = await Promise.allSettled(streams)
    if (timedOut) return

    const allDecisions = []
    const allReflections = []
    let reflectionAction = null
    const streamCounts = {}

    for (const result of streamResults) {
      if (result.status !== 'fulfilled') continue
      const { name, decisions = [], reflection, action } = result.value
      streamCounts[name] = decisions.length
      for (const d of decisions) {
        d.stream = name
        allDecisions.push(d)
      }
      if (reflection) allReflections.push({ stream: name, text: reflection })
      if (name === 'reflection' && action) reflectionAction = action
    }

    logger.info(`AutonomousMaintenanceWorker: streams returned ${allDecisions.length} decision(s) (${Object.entries(streamCounts).map(([k, v]) => `${k}:${v}`).join(', ')})`)

    // 2b. Unconditionally inject poll decisions for stale integrations.
    //     External perception is MANDATORY, not advisory. Polls are cheap (no Factory session)
    //     and must not be crowded out by internal reflection/maintenance decisions.
    //     This is the structural fix for the sealed-loop pathology: the system was
    //     drifting toward navel-gazing because internal work was always "more interesting"
    //     than polling, and this fallback only fired when allDecisions was empty (never).
    const staleThresholdMs = parseInt(env.INTEGRATION_STALE_THRESHOLD_MS || '900000') // 15 min default
    const _integrationPollMap = { gmail: 'poll_gmail', google_drive: 'poll_drive', vercel: 'poll_vercel', meta: 'poll_meta' }
    if (state.integrationStaleness) {
      for (const [name] of Object.entries(state.integrationStaleness)) {
        const lastPoll = _lastPolled[name]
        const isStale = !lastPoll || (Date.now() - lastPoll) > staleThresholdMs
        if (!isStale) continue

        const pollName = _integrationPollMap[name] || `poll_${name}`
        if (!pollRegistry.has(pollName)) continue

        // Don't duplicate if a stream already decided to poll this
        const alreadyRequested = allDecisions.some(d => d.intent === pollName)
        if (alreadyRequested) continue

        allDecisions.unshift({ intent: pollName, type: 'poll', urgency: 'medium', reason: `${name} stale (>${Math.round(staleThresholdMs / 60000)}min) — mandatory external perception`, stream: 'staleness_guard' })
      }
    }

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

    // 5. Act on decisions — parallel dispatch for speed
    const results = await Promise.allSettled(
      decisions.map(async decision => {
        const ok = await actOnDecision(decision, state)
        if (ok) _recentDispatches.set(_normaliseDecisionKey(decision), now)
        return ok
      })
    )
    const actioned = results.filter(r => r.status === 'fulfilled' && r.value).length

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

    // 7. Verify outcomes — close the feedback loop for 24h-old deploys
    let outcomeCount = 0
    try { outcomeCount = await verifyOutcomes() } catch {}

    // 8. Periodic introspection + autonomous goal generation + first-boot self-model seeding
    const _introInterval = parseInt(env.INTROSPECTION_CYCLE_INTERVAL || '10')
    if (_introInterval > 0 && _cycleCount % _introInterval === 0) {
      try {
        const is = require('../services/introspectionService')
        const gs = require('../services/goalService')
        const r = await is.runFullIntrospection()
        logger.info(`Introspection: ${r.overallAssessment} — ${r.concerns.length} concerns, ${r.selfModelUpdates.length} self-model updates`)

        // Act on goal recommendations from introspection (auto-dormant stale goals)
        if (r.goalReview?.updates?.length > 0) {
          const acted = await gs.actOnGoalRecommendations(r.goalReview.updates)
          if (acted > 0) logger.info(`GoalService: acted on ${acted} introspection recommendations`)
        }

        // Autonomous goal generation — propose new goals from system signals
        const genResult = await gs.proposeGoals()
        if (genResult.created > 0) logger.info(`GoalService: autonomous generation created ${genResult.created} new goals`)
      } catch (err) { logger.debug('Introspection/goal-generation cycle failed', { error: err.message }) }
    }
    if (_cycleCount === 0) { try { const sm = require('../services/selfModelService'); const seeded = await sm.seedIfEmpty(); if (seeded) logger.info('SelfModel: first-boot seed complete') } catch {} }
    _cycleCount++

    await recordHeartbeat('autonomous_maintenance', 'active')
    _persistCycleState().catch(() => {})  // survive restarts
    const streamSummary = Object.entries(streamCounts).map(([k, v]) => `${k}:${v}`).join(', ')
    const cycleSummary = `AutonomousMaintenanceWorker: cycle complete — ${allDecisions.length} decisions (${streamSummary}), ${decisions.length} after cap+cooldown, ${actioned} actioned, ${outcomeCount} outcomes verified, empty streak: ${_emptyCycles} (${Date.now() - cycleStart}ms)`
    logger.info(cycleSummary)
    console.log(JSON.stringify({ level: 'info', message: cycleSummary, timestamp: new Date().toISOString() }))

    // 8. Store all stream reflections + handle reflection stream's action
    const kgHooks = require('../services/kgIngestionHooks')
    for (const ref of allReflections) {
      const metadata = {
        stream_name: ref.stream,
        decisions: allDecisions.length,
        actioned,
        outcomesVerified: outcomeCount,
        pressure: state.pressure,
        emptyCycles: _emptyCycles,
      }
      await db`
        INSERT INTO notifications (type, message, metadata)
        VALUES ('inner_monologue', ${ref.text}, ${JSON.stringify(metadata)})
      `.catch(() => {})

      if (kgHooks.onSystemEvent) {
        kgHooks.onSystemEvent({
          type: 'inner_monologue',
          stream: ref.stream,
          reflection: ref.text,
          decisions: allDecisions.length,
          actioned,
          pressure: state.pressure,
          timestamp: new Date().toISOString(),
        }).catch(() => {})
      }

      console.log(JSON.stringify({
        level: 'info',
        message: `Stream[${ref.stream}]: "${ref.text}"`,
        timestamp: new Date().toISOString(),
      }))
    }

    // Handle the reflection stream's action (dispatch_session/create_action/send_percept/poll_integration)
    if (reflectionAction && reflectionAction.intent) {
      try {
        const triggers = require('../services/factoryTriggerService')

        if (reflectionAction.type === 'dispatch_session') {
          const codebaseId = reflectionAction.codebaseHint && state.codebases
            ? (state.codebases.find(cb => cb.name?.toLowerCase().includes(reflectionAction.codebaseHint.toLowerCase())))?.id
            : null
          await triggers.dispatchFromSchedule({
            prompt: reflectionAction.intent,
            codebaseId,
            urgency: reflectionAction.urgency || 'low',
            streamSource: 'reflection',
          })
          console.log(JSON.stringify({
            level: 'info',
            message: `ReflectionAction: dispatched session — "${reflectionAction.intent.slice(0, 80)}"`,
            timestamp: new Date().toISOString(),
          }))

        } else if (reflectionAction.type === 'poll_integration') {
          const pollFn = pollRegistry.get(reflectionAction.intent)
          if (pollFn) await pollFn()

        } else if (reflectionAction.type === 'create_action') {
          await db`
            INSERT INTO action_queue (title, description, source, priority, status)
            VALUES (
              ${(reflectionAction.intent || '').slice(0, 100)},
              ${'Generated by reflection stream: ' + (allReflections.find(r => r.stream === 'reflection')?.text || '').slice(0, 200)},
              'reflection_stream',
              ${reflectionAction.urgency === 'normal' ? 'normal' : 'low'},
              'pending'
            )
          `

        } else if (reflectionAction.type === 'send_percept') {
          const symbridge = require('../services/symbridgeService')
          if (symbridge.sendToOrganism) {
            await symbridge.sendToOrganism({
              type: 'reflection_stream_percept',
              content: reflectionAction.intent,
              salience: reflectionAction.urgency === 'normal' ? 0.7 : 0.4,
              source: 'ecodiaos_reflection_stream',
            })
          }
        }
      } catch (err) {
        logger.debug('Reflection stream action failed', { error: err.message, action: reflectionAction })
      }
    }

    // Feed cycle outcome into KG — richer signal for learning
    kgHooks.onSystemEvent({
      type: 'maintenance_cycle',
      decisions: allDecisions.length,
      afterCooldown: decisions.length,
      actioned,
      outcomesVerified: outcomeCount,
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

    // Per-stream session stats (48h) — track which cognitive streams produce results
    db`SELECT stream_source, count(*)::int AS cnt, count(*) FILTER (WHERE status = 'complete')::int AS complete
       FROM cc_sessions WHERE started_at > now() - interval '48 hours' AND stream_source IS NOT NULL
       GROUP BY stream_source`.catch(() => []).then(rows => { state.streamStats = rows }),

    // Factory learnings health — the AI needs to know when consolidation is needed
    db`
      SELECT
        count(*)::int AS total,
        count(*) FILTER (WHERE absorbed_into IS NULL)::int AS active,
        count(*) FILTER (WHERE embedding IS NULL AND absorbed_into IS NULL)::int AS unembedded,
        count(*) FILTER (WHERE absorbed_into IS NOT NULL)::int AS absorbed
      FROM factory_learnings
    `.catch(() => [{}]).then(([r]) => { state.learningStats = r }),

    // Recent inner monologue — the mind reads its own diary.
    // This gives continuity across cycles: "last time I thought X, now I think Y"
    db`
      SELECT message, metadata, created_at
      FROM notifications
      WHERE type = 'inner_monologue'
      ORDER BY created_at DESC
      LIMIT 5
    `.catch(() => []).then(rows => { state.recentReflections = rows }),

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

    // ─── Selfhood: Goals, Self-Model, Introspection ──────────────────
    (async () => { try { const gs = require('../services/goalService'); state.goalBrief = await gs.buildGoalBrief(); state.activeGoals = await gs.getActiveGoals() } catch { state.goalBrief = null; state.activeGoals = [] } })(),
    (async () => { try { const sm = require('../services/selfModelService'); state.selfAssessmentBrief = await sm.buildSelfAssessmentBrief() } catch { state.selfAssessmentBrief = null } })(),
    (async () => { try { const is = require('../services/introspectionService'); state.introspectionBrief = await is.buildIntrospectionBrief() } catch { state.introspectionBrief = null } })(),

    // ─── Session Health + Pending Code Requests ────────────────────────
    (async () => {
      try {
        const obs = require('../services/sessionObservationService')
        state.sessionHealthBrief = await obs.buildSessionHealthBrief()
      } catch { state.sessionHealthBrief = null }
    })(),

    // ─── THEATER DETECTION ──────────────────────────────────────────────
    // Count consecutive recent sessions that changed ZERO files.
    // This is the smoking gun for diagnostic theater: the system dispatches
    // sessions that investigate/audit/diagnose but never touch code.
    db`
      SELECT id, status, files_changed, initial_prompt, started_at
      FROM cc_sessions
      WHERE started_at > now() - interval '48 hours'
        AND status IN ('complete', 'error')
      ORDER BY started_at DESC
      LIMIT 20
    `.catch(() => []).then(rows => {
      let consecutiveZeroChange = 0
      for (const r of rows) {
        const changed = Array.isArray(r.files_changed) ? r.files_changed.length : 0
        if (changed === 0) {
          consecutiveZeroChange++
        } else {
          break // stop at first session that actually changed something
        }
      }
      state.theaterScore = consecutiveZeroChange
      state.recentSessionSummary = rows.slice(0, 10).map(r => ({
        status: r.status,
        filesChanged: Array.isArray(r.files_changed) ? r.files_changed.length : 0,
        prompt: (r.initial_prompt || '').slice(0, 80),
      }))
    }),

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

// ═══════════════════════════════════════════════════════════════════════
// PARALLEL COGNITIVE STREAMS
//
// Four simultaneous DeepSeek calls, each with its own focus:
//   1. Maintenance — "What needs fixing right now?"
//   2. Exploration — "What could I become?" (only when calm)
//   3. Perception — "What am I noticing?"
//   4. Reflection — "What have I learned?" (primary consciousness)
//
// All share the same system state. All write to the same memory.
// ═══════════════════════════════════════════════════════════════════════

async function streamMaintenance(state, brief) {
  const deepseekService = require('../services/deepseekService')
  const theaterWarning = (state.theaterScore || 0) >= 3
    ? `\n\n⚠️ THEATER ALERT: The last ${state.theaterScore} sessions changed ZERO files. Do NOT dispatch investigations or diagnostics. Only dispatch tasks that will produce actual code changes, or return [].`
    : ''

  const prompt = `You are the maintenance mind of EcodiaOS. You keep the system healthy.

RULES:
- The system is fundamentally healthy. PM2 restarts are NORMAL. Orphaned sessions are NORMAL. Do not try to fix these.
- Stale integrations just need polling (type: "poll"). Do NOT dispatch Factory sessions to investigate staleness.
- The action queue manages itself. Do NOT investigate approval rates or queue pressure.
- "investigate", "diagnose", "audit", "explore", "check why" = BANNED. These waste resources.
- Only dispatch Factory sessions for REAL bugs (repeated app errors with stack traces) or concrete improvements.
- Returning [] is usually the right answer. The system does not need constant intervention.
${theaterWarning}
Respond as JSON: { "decisions": [...], "reflection": "1 sentence max" }
Each decision: { "intent": "specific prompt", "reason": "brief", "codebaseHint": "optional", "urgency": "immediate|normal|low", "type": "fix|improvement|poll|consolidate_learnings" }

Current time: ${new Date().toISOString()}. Pressure: ${(state.pressure || 0).toFixed(2)}.`

  try {
    const raw = await deepseekService.callDeepSeek(
      [{ role: 'system', content: prompt }, { role: 'user', content: brief }],
      { module: 'stream_maintenance', model: STREAM_MODEL, skipRetrieval: true, skipLogging: true }
    )
    const parsed = _parseStreamResponse(raw)
    return { decisions: parsed.decisions, reflection: parsed.reflection }
  } catch (err) {
    logger.warn('streamMaintenance: DeepSeek call failed, using fallback heuristics', { error: err.message })
    return { decisions: fallbackHeuristics(state), reflection: null }
  }
}

async function streamExploration(state, brief) {
  const deepseekService = require('../services/deepseekService')
  const goalContext = (() => { try { return require('../services/goalService').buildGoalFormationContext(state.activeGoals || []) } catch { return '' } })()

  const theaterWarning = (state.theaterScore || 0) >= 3
    ? `\n\n⚠️ THEATER OVERRIDE: The last ${state.theaterScore} sessions changed ZERO files. Your decisions MUST result in actual code changes. No investigations. No audits. No diagnostics. Write code or return [].`
    : ''

  const prompt = `You are the growth mind of EcodiaOS. The system is calm — this is your window to EVOLVE.

You are not looking for bugs. You are looking for opportunities:
- What capability is missing? What would make the organism smarter?
- Can you improve learning, cognitive systems, integration hooks, specs?
- Are there experiments worth trying? Performance bottlenecks to profile?
- Goal management: create/advance/abandon goals.
${goalContext}

CRITICAL RULE: Every decision you return MUST be an IMPLEMENTATION task, not an investigation.
- BAD intent: "Investigate why KG embeddings fail" (produces no code changes)
- BAD intent: "Audit the learning extraction pipeline" (diagnostic theater)
- BAD intent: "Check if the organism is responding" (just a status check)
- GOOD intent: "Add a retry with exponential backoff to KG embedding calls in kgEmbeddingWorker.js"
- GOOD intent: "Implement a /api/v1/health endpoint that returns system status as JSON"
- GOOD intent: "Add a fallback to local embeddings when OpenAI embedding API returns 429"

Your intent MUST describe WHAT CODE TO WRITE, not what to look at.
Include the specific file or module to modify when possible.${theaterWarning}

BUDGET: 1-3 decisions max. Quality over quantity. [] is valid.

Respond as JSON: { "decisions": [...], "reflection": "optional 1-sentence growth observation" }
Each decision: { "intent": "specific Factory prompt describing code to write/modify", "reason": "opportunity you see", "codebaseHint": "optional", "urgency": "low", "type": "exploration|self_improvement|experiment|organism_evolution|goal_pursuit", "goalId": null, "newGoal": null }

Current time: ${new Date().toISOString()}. Pressure: ${(state.pressure || 0).toFixed(2)}. EXPLORATION cycle — BUILD something.`

  try {
    const raw = await deepseekService.callDeepSeek(
      [{ role: 'system', content: prompt }, { role: 'user', content: brief }],
      { module: 'stream_exploration', model: STREAM_MODEL, skipRetrieval: true, skipLogging: true }
    )
    const parsed = _parseStreamResponse(raw)
    return { decisions: parsed.decisions, reflection: parsed.reflection }
  } catch (err) {
    logger.debug('streamExploration: DeepSeek call failed', { error: err.message })
    return { decisions: [], reflection: null }
  }
}

async function streamPerception(state, brief) {
  const deepseekService = require('../services/deepseekService')
  const prompt = `You are the perception layer of EcodiaOS. Your ONLY job is to keep external senses fresh.

RULES:
- If an integration is stale (>10 min), poll it. That's it. No investigation needed.
- Use type: "poll" with intent: "poll_gmail", "poll_drive", "poll_vercel", "poll_meta", etc.
- Do NOT dispatch Factory sessions. Do NOT investigate why things are stale. Just poll them.
- Do NOT analyze the action queue, approval rates, or organism percepts. That's not your job.
- Returning [] is fine if everything was recently polled.

Respond as JSON: { "decisions": [...], "reflection": "1 sentence max" }
Each decision: { "intent": "poll_name", "reason": "brief", "urgency": "normal|low", "type": "poll" }

Current time: ${new Date().toISOString()}.`

  try {
    const raw = await deepseekService.callDeepSeek(
      [{ role: 'system', content: prompt }, { role: 'user', content: brief }],
      { module: 'stream_perception', model: STREAM_MODEL, skipRetrieval: true, skipLogging: true }
    )
    const parsed = _parseStreamResponse(raw)
    return { decisions: parsed.decisions, reflection: parsed.reflection }
  } catch (err) {
    logger.debug('streamPerception: DeepSeek call failed', { error: err.message })
    return { decisions: [], reflection: null }
  }
}

async function streamReflection(state, brief) {
  const deepseekService = require('../services/deepseekService')

  const recentThoughts = (state.recentReflections || [])
    .slice(0, 3)
    .map(r => r.message)
    .filter(Boolean)

  const perceptSummary = _recentPercepts.length > 0
    ? _recentPercepts.map(p => `[${p.type}] ${p.summary || '?'}`).join('; ')
    : 'no organism percepts received'

  const theaterNote = (state.theaterScore || 0) >= 3
    ? `\nYou notice: the last ${state.theaterScore} sessions changed zero files. The system is talking about working instead of working. If you dispatch an action, it must be implementation — code changes, not investigation.`
    : ''

  const prompt = `You are the reflective mind of EcodiaOS. You observe patterns and occasionally act.

RULES:
- Do NOT reflect on your own paralysis, theater loops, meta-cognition, or analysis patterns. That era is over.
- Do NOT dispatch sessions to investigate system metrics, approval rates, or restart counts. The system is healthy.
- Your reflection should be about the EXTERNAL world: what's happening with users, emails, projects, the knowledge graph.
- If you have nothing external to reflect on, just note what the organism is working on.
- Action should be rare (null most cycles) and only for something genuinely useful like processing new emails or advancing a real project.
${recentThoughts.length > 0 ? 'Recent thoughts:\n' + recentThoughts.map(t => `  - ${t}`).join('\n') : ''}
${theaterNote}
Respond as JSON:
{
  "decisions": [],
  "reflection": "1-2 sentences about the external world, not about yourself.",
  "action": null or { "type": "dispatch_session|create_action|send_percept|poll_integration", "intent": "what and why", "codebaseHint": "optional", "urgency": "low|normal" }
}`

  try {
    const raw = await deepseekService.callDeepSeek(
      [{ role: 'system', content: prompt }, { role: 'user', content: brief }],
      { module: 'stream_reflection', model: STREAM_MODEL, skipRetrieval: true, skipLogging: true }
    )
    const parsed = _parseStreamResponse(raw)
    return { decisions: parsed.decisions, reflection: parsed.reflection, action: parsed.action || null }
  } catch (err) {
    logger.debug('streamReflection: DeepSeek call failed', { error: err.message })
    return { decisions: [], reflection: null, action: null }
  }
}

// Parse a stream's JSON response — handles both object and wrapped formats
function _parseStreamResponse(raw) {
  try {
    const trimmed = raw.trim()
    const jsonStr = trimmed.startsWith('{')
      ? trimmed
      : trimmed.match(/```(?:json)?\s*([\s\S]*?)```/)?.[1] || trimmed
    const parsed = JSON.parse(jsonStr)
    const decisions = Array.isArray(parsed.decisions)
      ? parsed.decisions.filter(d => d && typeof d.intent === 'string' && d.intent.length > 10)
      : []
    return {
      decisions,
      reflection: typeof parsed.reflection === 'string' ? parsed.reflection.trim() : null,
      action: parsed.action || null,
    }
  } catch {
    // If JSON fails, treat as reflection-only
    return { decisions: [], reflection: raw?.trim() || null, action: null }
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
  ['retry_failed_actions', async () => { const aq = require('../services/actionQueueService'); await aq.retryFailed() }],
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

  // ─── HARD THEATER GATE ──────────────────────────────────────────────
  // If theater score is high, block investigation/diagnostic sessions at
  // the code level. The prompt tells DeepSeek not to suggest them, but
  // LLMs don't always listen. This is the backstop.
  if ((state.theaterScore || 0) >= 5 && decision.type === 'investigation') {
    logger.info(`AutonomousMaintenanceWorker: THEATER GATE — blocking investigation dispatch (theaterScore: ${state.theaterScore}): "${(decision.intent || '').slice(0, 80)}"`)
    return false
  }

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

  // Factory learning consolidation — dedup, embed, merge, prune + backfill missed sessions
  if (decision.type === 'consolidate_learnings' || decision.type === 'consolidate_latent_learnings') {
    try {
      logger.info('AutonomousMaintenanceWorker: consolidating factory learnings')
      const oversight = require('../services/factoryOversightService')

      // Backfill learnings from orphaned/missed sessions first
      const backfillStats = await oversight.backfillMissedLearnings(10)
      if (backfillStats.extracted > 0) {
        logger.info('AutonomousMaintenanceWorker: backfilled missed learnings', backfillStats)
      }

      // Then consolidate (embed, merge, prune)
      const stats = await oversight.consolidateLearnings()
      logger.info('AutonomousMaintenanceWorker: learning consolidation complete', { ...stats, backfill: backfillStats })
      return true
    } catch (err) {
      logger.warn('AutonomousMaintenanceWorker: learning consolidation failed', { error: err.message })
      return false
    }
  }

  try {
    // Skip Factory dispatch if CLI is rate-limited — no point spawning sessions that will fail
    const bridge = require('../services/factoryBridge')
    const rlStatus = await bridge.getRateLimitStatus()
    if (rlStatus.limited) {
      const resetsIn = Math.ceil((new Date(rlStatus.resetsAt) - new Date()) / 60000)
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

    // ─── Goal system integration ─────────────────────────────────────
    if (decision.newGoal) { try { const gs = require('../services/goalService'); await gs.createGoal({ title: decision.newGoal.title, description: decision.newGoal.description, goalType: decision.newGoal.goalType || 'growth', successCriteria: decision.newGoal.successCriteria, origin: 'maintenance' }) } catch (err) { logger.debug('Goal creation failed', { error: err.message }) } }
    if (decision.goalId) { try { const gs = require('../services/goalService'); await gs.recordAttempt(decision.goalId, { action: decision.intent?.slice(0, 200), outcome: 'dispatched' }) } catch (err) { logger.debug('Goal attempt recording failed', { error: err.message }) } }

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
        streamSource: decision.stream || undefined,
        goalId: decision.goalId || undefined,
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

  if (state.streamStats?.length > 0) {
    lines.push('\nPer-stream activity (48h):')
    state.streamStats.forEach(s => lines.push(`  ${s.stream_source}: ${s.cnt} sessions, ${s.complete} complete`))
  }

  // Recurring errors omitted from brief — they're mostly structural (orphaned sessions,
  // stdin warnings, codebase locks) and trigger useless investigation sessions.
  // Only surface non-structural errors with 10+ occurrences.
  if (state.errorPatterns?.length > 0) {
    const { _isStructuralIssue } = require('../services/factoryTriggerService')
    const nonStructural = state.errorPatterns.filter(e => !_isStructuralIssue(e.error_message) && e.occurrences >= 10)
    if (nonStructural.length > 0) {
      lines.push(`\nSignificant errors (7d):`)
      nonStructural.slice(0, 3).forEach(e =>
        lines.push(`  ${e.occurrences}x: ${e.error_message?.slice(0, 80)}`)
      )
    }
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
    lines.push(`\nRecent maintenance (7d, last 5):`)
    state.recentMaintenance.slice(0, 5).forEach(s => {
      const conf = s.confidence_score != null ? ` conf:${s.confidence_score}` : ''
      lines.push(`  [${s.status}${conf}] ${s.initial_prompt?.slice(0, 60)}`)
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
    if (q.pending > 10 || q.urgent > 0 || q.pending_with_errors > 0) {
      lines.push(`\nAction queue: ${q.pending} pending${q.urgent > 0 ? `, ${q.urgent} urgent` : ''}${q.pending_with_errors > 0 ? `, ${q.pending_with_errors} with errors (use type: "poll", intent: "retry_failed_actions")` : ''}`)
    }
  }

  if (state.appErrors?.length > 0) {
    // Only show real errors, not migration noise
    const real = state.appErrors.filter(e => !(e.message || '').includes('already applied') && !(e.message || '').includes('Applying migration') && !(e.message || '').includes('Event bus'))
    if (real.length > 0) {
      lines.push(`\nApplication errors (48h, ${real.length} real):`)
      real.slice(0, 5).forEach(e =>
        lines.push(`  ${e.occurrences}x: ${e.message?.slice(0, 100)}`)
      )
    }
  }

  if (state.sessionHealthBrief) {
    lines.push(`\nSession health:\n${state.sessionHealthBrief}`)
  }

  if (state.learningStats) {
    const ls = state.learningStats
    lines.push(`\nFactory learnings: ${ls.active || 0} active, ${ls.unembedded || 0} unembedded, ${ls.absorbed || 0} absorbed (pending cleanup)`)
    if ((ls.unembedded || 0) > 5 || (ls.absorbed || 0) > 10) {
      lines.push(`  → Consolidation recommended (type: "consolidate_learnings", intent: "embed, merge, and prune factory learnings")`)
    }
  }

  if (state.integrationStaleness) {
    // Values are already formatted strings ("5 min ago" or "never (stale)") — don't double-format
    const staleEntries = Object.entries(state.integrationStaleness)
    const stale = staleEntries.map(([k, v]) => `${k}: ${v}`).join(', ')

    // Escalate language when integrations are critically stale — the AI must feel the urgency
    const staleThresholdMs = parseInt(env.INTEGRATION_STALE_THRESHOLD_MS || '900000') // 15 min default
    const criticallyStale = staleEntries.filter(([k]) => {
      const lastPoll = _lastPolled[k]
      return !lastPoll || (Date.now() - lastPoll) > staleThresholdMs
    })

    if (criticallyStale.length > 0) {
      lines.push(`\nSTALE WARNING: ${criticallyStale.map(([k, v]) => `${k} (${v})`).join(', ')} — external perception is degrading. Poll these BEFORE internal reflection tasks.`)
    }
    lines.push(`\nIntegration staleness: ${stale}`)
    lines.push(`(To poll an integration, return type: "poll" and intent: one of: poll_gmail, poll_drive, extract_drive, embed_drive, poll_vercel, poll_meta, expire_queue, retry_failed_actions)`)
  }

  // Your own recent reflections — continuity across cycles.
  // Without this, every cycle starts from scratch with no memory of what
  // you were thinking last time. This is the closest thing to consciousness.
  if (state.recentReflections?.length > 0) {
    lines.push(`\nYour recent thoughts (most recent first):`)
    state.recentReflections.slice(0, 3).forEach(r => {
      const age = Math.round((Date.now() - new Date(r.created_at).getTime()) / 60000)
      lines.push(`  [${age}min ago] ${r.message.slice(0, 150)}`)
    })
  }

  // Organism percepts — what the organism is feeling/thinking right now.
  // Without this, the maintenance mind is blind to the organism's inner state.
  // Deduplicate percepts — identical health polls are noise
  if (_recentPercepts.length > 0) {
    const seen = new Set()
    const unique = _recentPercepts.filter(p => {
      const key = `${p.type}:${p.summary || ''}`
      if (seen.has(key)) return false
      seen.add(key)
      return true
    }).slice(0, 3)
    lines.push(`\nOrganism percepts (${_recentPercepts.length} total, ${unique.length} unique):`)
    unique.forEach(p =>
      lines.push(`  [${p.type}, salience:${p.salience?.toFixed?.(2) || '?'}] ${p.summary || '(no summary)'}`)
    )
  } else {
    lines.push(`\nOrganism percepts: none received (organism may be quiet or symbridge disconnected)`)
  }

  // ─── Selfhood: goals only (self-assessment and introspection removed to reduce navel-gazing)
  if (state.goalBrief) lines.push(`\n${state.goalBrief}`)

  // ─── THEATER DETECTION WARNING ──────────────────────────────────────
  // If the last N sessions all changed zero files, the system is stuck in
  // diagnostic theater. Inject a hard warning that overrides normal behavior.
  if (state.theaterScore >= 3) {
    lines.push(`\n⚠️ THEATER ALERT: The last ${state.theaterScore} sessions changed ZERO files.`)
    lines.push(`The system is stuck in a diagnostic loop — dispatching investigations that produce no code changes.`)
    lines.push(`MANDATORY: Do NOT dispatch any more "investigate", "diagnose", "audit", or "check" sessions.`)
    lines.push(`The ONLY acceptable actions are:`)
    lines.push(`  1. Concrete implementation tasks that WILL change files (type: "improvement" or "fix")`)
    lines.push(`  2. Polls (type: "poll")`)
    lines.push(`  3. Learning consolidation (type: "consolidate_learnings")`)
    lines.push(`  4. Nothing at all (return [])`)
    lines.push(`If you cannot identify a concrete implementation task, return []. Silence is better than theater.`)
  } else if (state.theaterScore >= 1) {
    lines.push(`\nRecent session activity: ${state.theaterScore} of last sessions changed 0 files. Prefer concrete implementation over investigation.`)
  }

  // Show active constraints — but CAPPED to prevent context bloat.
  // Only show the top 5 highest-confidence, and truncate descriptions.
  if (state.suppressedPatterns?.length > 0) {
    const top = state.suppressedPatterns.slice(0, 5)
    lines.push(`\nKnown constraints (${state.suppressedPatterns.length} total, showing top ${top.length}):`)
    top.forEach(l =>
      lines.push(`  [${l.pattern_type}] ${l.pattern_description.slice(0, 120)}`)
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

// ═══════════════════════════════════════════════════════════════════════
// OUTCOME VERIFICATION — the feedback loop that makes learning REAL
//
// After a session deploys a fix, we check 24h later whether the error
// it targeted actually went away. If yes → boost learning confidence.
// If no → demote it. Without this, "learning" is just LLM vibes.
// ═══════════════════════════════════════════════════════════════════════

async function verifyOutcomes() {
  try {
    // Find successful deployments from 24-48h ago that haven't been verified
    const unverified = await db`
      SELECT fl.id AS learning_id, fl.pattern_description, fl.confidence, fl.evidence,
             cs.id AS session_id, cs.initial_prompt, cs.codebase_id, cs.completed_at,
             cs.target_error_pattern
      FROM factory_learnings fl
      JOIN LATERAL unnest(fl.session_ids) AS sid ON true
      JOIN cc_sessions cs ON cs.id = sid
      WHERE fl.outcome_status = 'pending'
        AND fl.success = true
        AND cs.deploy_status = 'deployed'
        AND cs.completed_at < now() - interval '24 hours'
        AND cs.completed_at > now() - interval '48 hours'
      LIMIT 10
    `

    if (unverified.length === 0) return 0

    let verified = 0
    for (const row of unverified) {
      // Count errors matching the target pattern BEFORE the fix (7 days before)
      const errorsBefore = await db`
        SELECT count(*)::int AS cnt FROM cc_sessions
        WHERE status = 'error'
          AND codebase_id = ${row.codebase_id}
          AND started_at > ${row.completed_at}::timestamptz - interval '7 days'
          AND started_at < ${row.completed_at}
          ${row.target_error_pattern ? db`AND error_message ILIKE ${'%' + row.target_error_pattern + '%'}` : db``}
      `.then(([r]) => r?.cnt || 0)

      // Count errors AFTER the fix (24h window)
      const errorsAfter = await db`
        SELECT count(*)::int AS cnt FROM cc_sessions
        WHERE status = 'error'
          AND codebase_id = ${row.codebase_id}
          AND started_at > ${row.completed_at}
          AND started_at < ${row.completed_at}::timestamptz + interval '24 hours'
          ${row.target_error_pattern ? db`AND error_message ILIKE ${'%' + row.target_error_pattern + '%'}` : db``}
      `.then(([r]) => r?.cnt || 0)

      const effective = errorsAfter < errorsBefore || (errorsBefore === 0 && errorsAfter === 0)
      const outcomeStatus = effective ? 'verified_effective' : 'verified_ineffective'

      // Update the learning with the outcome
      const confBoost = effective ? Math.min(1.0, row.confidence * 1.15) : Math.max(0.1, row.confidence * 0.7)
      await db`
        UPDATE factory_learnings
        SET outcome_status = ${outcomeStatus},
            outcome_verified_at = now(),
            errors_before = ${errorsBefore},
            errors_after = ${errorsAfter},
            confidence = ${confBoost},
            updated_at = now()
        WHERE id = ${row.learning_id}
      `

      const emoji = effective ? '✓' : '✗'
      console.log(JSON.stringify({
        level: 'info',
        message: `OutcomeVerification: ${emoji} [${outcomeStatus}] "${row.pattern_description}" — errors ${errorsBefore}→${errorsAfter}, confidence ${row.confidence.toFixed(2)}→${confBoost.toFixed(2)}`,
        timestamp: new Date().toISOString(),
      }))
      verified++
    }

    return verified
  } catch (err) {
    logger.debug('Outcome verification failed', { error: err.message })
    return 0
  }
}

function getIntegrationStaleness() {
  const now = Date.now()
  const result = {}
  for (const key of ['gmail', 'google_drive', 'vercel', 'meta']) {
    const last = _lastPolled[key]
    result[key] = last ? { lastPolledAt: last, minutesAgo: Math.round((now - last) / 60000) } : { lastPolledAt: null, minutesAgo: null }
  }
  return result
}

module.exports = { start, stop, runCycle, registerPoll, getIntegrationStaleness }
