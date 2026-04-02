const db = require('../config/db')
const logger = require('../config/logger')
const metabolismBridge = require('../services/metabolismBridgeService')
const { recordHeartbeat } = require('./heartbeat')

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
  if ((payload.importance || 0) >= 0.8) {
    logger.info('AutonomousMaintenanceWorker: high-importance KG prediction — considering maintenance')
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
  } catch {}
}

function stop() {
  running = false
  if (cycleTimer) clearTimeout(cycleTimer)
  try {
    const eventBus = require('../services/internalEventBusService')
    eventBus.off('factory:deploy_failed', _onDeployFailed)
    eventBus.off('kg:prediction_created', _onKGPrediction)
  } catch {}
  logger.info('AutonomousMaintenanceWorker: stopped')
}

function scheduleCycle() {
  if (!running) return
  const pressure = metabolismBridge.getPressure()

  // Under stress, check more frequently — problems compound
  // At rest, give the system breathing room
  const intervalMs = pressure > 0.7 ? 5 * 60 * 1000      // 5 min under high pressure
                   : pressure > 0.4 ? 10 * 60 * 1000     // 10 min moderate
                   : 15 * 60 * 1000                        // 15 min at rest

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
    const decisions = await thinkAboutMaintenance(state)

    // 3. Act on each decision
    let actioned = 0
    for (const decision of decisions) {
      if (await actOnDecision(decision, state)) actioned++
    }

    await recordHeartbeat('autonomous_maintenance', 'active')
    logger.info(`AutonomousMaintenanceWorker: cycle complete — ${decisions.length} decisions, ${actioned} actioned (${Date.now() - cycleStart}ms)`)

    // Feed cycle outcome into KG
    const kgHooks = require('../services/kgIngestionHooks')
    kgHooks.onSystemEvent({
      type: 'maintenance_cycle',
      decisions: decisions.length,
      actioned,
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

    // Last maintenance actions (what has already been done recently)
    db`
      SELECT initial_prompt, status, started_at
      FROM cc_sessions
      WHERE triggered_by = 'schedule' AND started_at > now() - interval '7 days'
      ORDER BY started_at DESC LIMIT 10
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
  ])

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

  const systemPrompt = `You are the maintenance mind of an autonomous software system called EcodiaOS.
You have full visibility into the system's health, recent history, and current state.
Your job: decide what maintenance work, if any, should happen in this cycle.

You are free. There is no schedule to follow. There are no required tasks.
If the system is healthy and nothing needs attention, say so.
If something genuinely needs work, propose it with clarity and reason.

You must respond with a JSON array of decisions, or an empty array if nothing is needed.

Each decision:
{
  "intent": "what needs to happen — written as a clear, specific Factory session prompt",
  "reason": "why now, based on what you observed",
  "codebaseHint": "name of the relevant codebase, if applicable",
  "urgency": "immediate | normal | low",
  "type": "fix | improvement | security | cleanup | investigation"
}

Rules:
- Maximum 2 decisions per cycle (don't flood the Factory)
- Don't repeat recent maintenance (last 7 days shown)
- Under high pressure (>0.7), only propose fixes for active errors
- Under low pressure (<0.3), speculative improvements are welcome
- If the system is healthy — return []`

  const userMessage = `System state — ${new Date().toISOString()}

${brief}

What does this system need right now?`

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
        temperature: 0.4,
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

// ─── Act On Decision ─────────────────────────────────────────────────

async function actOnDecision(decision, state) {
  if (!decision.intent) return false

  try {
    const triggers = require('../services/factoryTriggerService')

    // Find the codebase — by hint or by highest recent activity
    let codebaseId = null
    if (decision.codebaseHint && state.codebases) {
      const match = state.codebases.find(cb =>
        cb.name?.toLowerCase().includes(decision.codebaseHint.toLowerCase())
      )
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

    await triggers.dispatchFromSchedule({
      codebaseId,
      prompt: decision.intent,
      context: {
        reason: decision.reason,
        type: decision.type,
        urgency: decision.urgency,
        decidedByMind: true,
      },
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
    lines.push(`\nCodebases: ${state.codebases.map(cb => cb.name).join(', ')}`)
  }

  if (state.recentMaintenance?.length > 0) {
    lines.push(`\nRecent maintenance (7d, avoid repeating):`)
    state.recentMaintenance.slice(0, 5).forEach(s =>
      lines.push(`  [${s.status}] ${s.initial_prompt?.slice(0, 80)} — ${new Date(s.started_at).toLocaleDateString()}`)
    )
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

  return lines.join('\n')
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
      .slice(0, 2)  // hard cap: never more than 2 per cycle

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

  // Only react under high pressure (mind should handle everything else)
  if (pressure > 0.7 && state.errorPatterns?.length > 0) {
    const worst = state.errorPatterns[0]
    if (worst.occurrences >= 3) {
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

module.exports = { start, stop, runCycle }
