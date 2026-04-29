/**
 * Scheduler Poller — persistent, runs inside ecodia-api 24/7.
 *
 * The scheduler MCP server exposes tools for CREATING tasks, but its polling
 * loop only runs during active Claude Code sessions (stdio process lifetime).
 * This service fills that gap: it polls os_scheduled_tasks every 30 seconds
 * regardless of whether any session is active, ensuring crons fire on schedule
 * even while Tate is in Fiji.
 */

const db = require('../config/db')
const logger = require('../config/logger')
const usageEnergy = require('./usageEnergyService')
const doctrineSurface = require('./doctrineSurface')

const POLL_INTERVAL_MS = 30_000
const TZ_OFFSET_HOURS = 10 // AEST (UTC+10, no DST)
const API_PORT = process.env.PORT || 3001

// Crons that must fire even at critical energy (>=90% quota). Watchdogs and
// the blocked-work nudge stay on - if these defer, silent stall goes
// undetected and Tate loses the one signal that tells him autonomy flatlined.
const ESSENTIAL_CRON_NAMES = new Set(['silent-loop-detector', 'system-health', 'tate-blocked-nudge-weekly'])

let _timeout = null
let _running = false
let _stopped = false

// ── Schedule parsing (mirrors mcp-servers/scheduler/index.js) ──

function computeNextRun(cronExpr) {
  const everyMatch = cronExpr.match(/^every\s+(\d+)(m|h)$/i)
  if (everyMatch) {
    const val = parseInt(everyMatch[1])
    const unit = everyMatch[2].toLowerCase()
    const ms = unit === 'm' ? val * 60_000 : val * 3_600_000
    return new Date(Date.now() + ms)
  }
  const dailyMatch = cronExpr.match(/^daily\s+(\d{1,2}):(\d{2})$/i)
  if (dailyMatch) {
    let utcHour = parseInt(dailyMatch[1]) - TZ_OFFSET_HOURS
    if (utcHour < 0) utcHour += 24
    const minute = parseInt(dailyMatch[2])
    const next = new Date()
    next.setUTCHours(utcHour, minute, 0, 0)
    if (next <= new Date()) next.setUTCDate(next.getUTCDate() + 1)
    return next
  }
  return null
}

// ── Check if OS session is currently streaming ──

async function isSessionBusy() {
  // Prefer in-process atomic check to avoid the HTTP-then-fire race.
  try {
    const osSession = require('./osSessionService')
    if (typeof osSession._isQueueBusy === 'function' && osSession._isQueueBusy()) {
      return true
    }
  } catch {}
  try {
    const res = await fetch(`http://127.0.0.1:${API_PORT}/api/os-session/status`, {
      signal: AbortSignal.timeout(5_000),
    })
    const body = await res.json().catch(() => ({}))
    return body.active === true || body.status === 'streaming'
  } catch {
    return false
  }
}

// ── Fire a single task ──

async function fireTask(task) {
  // No pre-gate. Trust /api/os-session/message with source:'scheduler' to queue
  // behind in-flight turns or initialise an idle session. See
  // patterns/scheduler-no-pregate-trust-os-message-queue.md.
  try {
    // Doctrine surface: keyword-grep ~/ecodiaos/{patterns,clients,docs/secrets}
    // for files whose triggers: frontmatter matches tokens in this prompt, and
    // prepend a <doctrine_surface> block so the conductor sees relevant durable
    // doctrine before acting. Fail-open: any error here is logged and the
    // un-surfaced prompt is sent. See drafts/context-surface-injection-points-
    // recon-2026-04-29.md and patterns/decision-quality-self-optimization-
    // architecture.md (Layer 1 expansion to cron-fire ingress).
    let surfaceBlock = null
    let surfaceMatches = []
    try {
      surfaceBlock = doctrineSurface.surfaceDoctrineBlock(task.prompt)
      surfaceMatches = doctrineSurface.matchedFiles(task.prompt)
    } catch (err) {
      logger.warn('Scheduler: doctrine surface failed (skipping)', { name: task.name, error: err.message })
    }
    const prompt = surfaceBlock
      ? `[SCHEDULED: ${task.name}]\n\n${surfaceBlock}\n\n${task.prompt}`
      : `[SCHEDULED: ${task.name}] ${task.prompt}`
    if (surfaceMatches.length > 0) {
      logger.info('Scheduler: doctrine surfaces injected for cron prompt', {
        name: task.name,
        source: 'cron-fire',
        surfaces: surfaceMatches.map(s => s.base),
      })
    }
    const res = await fetch(`http://127.0.0.1:${API_PORT}/api/os-session/message`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: prompt, source: 'scheduler' }),
      signal: AbortSignal.timeout(1_800_000), // 30 min
    })
    const result = await res.json().catch(() => ({}))

    const now = new Date()
    if (task.type === 'cron') {
      const nextRun = computeNextRun(task.cron_expression)
      await db`
        UPDATE os_scheduled_tasks
        SET last_run_at = ${now}, next_run_at = ${nextRun},
            run_count = run_count + 1, result = ${JSON.stringify(result).slice(0, 500)}
        WHERE id = ${task.id}
      `
    } else {
      await db`
        UPDATE os_scheduled_tasks
        SET last_run_at = ${now}, run_count = run_count + 1,
            status = 'completed', result = ${JSON.stringify(result).slice(0, 500)}
        WHERE id = ${task.id}
      `
      // Fire any chained tasks
      const chained = await db`
        SELECT * FROM os_scheduled_tasks
        WHERE chain_after = ${task.id} AND status = 'active'
      `
      for (const c of chained) await fireTask(c)
    }

    logger.info('Scheduler fired task', { name: task.name, type: task.type })
  } catch (err) {
    logger.warn('Scheduler failed to fire task', { name: task.name, error: err.message })
    // Reschedule cron to next interval so it doesn't stack
    if (task.type === 'cron') {
      const nextRun = computeNextRun(task.cron_expression)
      if (nextRun) {
        await db`UPDATE os_scheduled_tasks SET next_run_at = ${nextRun}, result = ${err.message} WHERE id = ${task.id}`
          .catch(() => {})
      }
    }
  }
}

// ── Poll cycle ──

async function pollOnce() {
  if (_running) return // don't stack if previous poll is slow
  _running = true
  try {
    const now = new Date()
    const due = await db`
      SELECT * FROM os_scheduled_tasks
      WHERE status = 'active' AND next_run_at IS NOT NULL AND next_run_at <= ${now}
      ORDER BY next_run_at
    `
    if (due.length === 0) return

    const busy = await isSessionBusy()
    if (busy) {
      logger.debug('Scheduler: session busy, skipping poll', { dueTasks: due.length })
      return
    }

    // Energy-aware gating: at critical level, only fire tasks flagged as critical
    // (or high-priority). Below critical, run everything. We keep this permissive
    // for low/conserve because the scheduleMultiplier already spaces out polls.
    let energyLevel = 'healthy'
    try {
      const energy = await usageEnergy.getEnergy()
      energyLevel = energy?.level || 'healthy'
    } catch {}

    if (energyLevel === 'critical') {
      // Critical: defer all non-essential crons by 1h. Only run tasks whose
      // metadata marks them critical (backup jobs, health checks).
      const essentialTasks = due.filter(t => ESSENTIAL_CRON_NAMES.has(t.name))
      if (essentialTasks.length === 0) {
        logger.info('Scheduler: critical energy, deferring all non-essential tasks', { deferred: due.length })
        for (const t of due) {
          if (t.type === 'cron') {
            const deferred = new Date(Date.now() + 60 * 60 * 1000)
            await db`UPDATE os_scheduled_tasks SET next_run_at = ${deferred} WHERE id = ${t.id}`
              .catch(() => {})
          }
        }
        return
      }
      logger.info('Scheduler: critical energy, firing only essential tasks', { essential: essentialTasks.length, deferred: due.length - essentialTasks.length })
      await fireTask(essentialTasks[0])
      return
    }

    // Fire one task per cycle, reschedule the rest to avoid flooding
    await fireTask(due[0])

    for (const t of due.slice(1)) {
      if (t.type === 'cron') {
        const requeue = new Date(Date.now() + 60_000)
        await db`UPDATE os_scheduled_tasks SET next_run_at = ${requeue} WHERE id = ${t.id}`
          .catch(() => {})
        logger.debug('Scheduler: requeued overdue cron for next cycle', { name: t.name, requeueAt: requeue })
      }
    }
  } catch (err) {
    logger.warn('Scheduler poll error', { error: err.message })
  } finally {
    _running = false
  }
}

// Self-scheduling loop — uses energy-adjusted intervals instead of a fixed
// setInterval. When energy is low we stretch the poll cadence via
// scheduleMultiplier (0.75 conserve => 40s, 0.5 low => 60s, 0.25 critical => 120s).
// This way the poller itself burns less quota when quota is scarce.
async function _scheduleNextPoll() {
  if (_stopped) return
  let multiplier = 1.0
  try {
    const energy = await usageEnergy.getEnergy()
    multiplier = energy?.scheduleMultiplier || 1.0
  } catch {}
  const delay = Math.round(POLL_INTERVAL_MS / multiplier)  // lower multiplier = longer delay
  _timeout = setTimeout(async () => {
    try { await pollOnce() } catch (err) { logger.warn('Scheduler: pollOnce crashed', { error: err.message }) }
    _scheduleNextPoll()
  }, delay)
  if (typeof _timeout.unref === 'function') _timeout.unref()
}

// ── Public API ──

function start() {
  if (_timeout) return
  _stopped = false
  // First poll in 5s to catch overdue tasks quickly on boot.
  _timeout = setTimeout(async () => {
    try { await pollOnce() } catch (err) { logger.warn('Scheduler: initial pollOnce crashed', { error: err.message }) }
    _scheduleNextPoll()
  }, 5_000)
  logger.info('Scheduler poller started (energy-adjusted cadence)')
}

function stop() {
  _stopped = true
  if (_timeout) {
    clearTimeout(_timeout)
    _timeout = null
    logger.info('Scheduler poller stopped')
  }
}

module.exports = { start, stop, fireTask }
