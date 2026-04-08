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

const POLL_INTERVAL_MS = 30_000
const TZ_OFFSET_HOURS = 10 // AEST (UTC+10, no DST)
const API_PORT = process.env.PORT || 3001

let _interval = null
let _running = false

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
  try {
    const prompt = `[SCHEDULED: ${task.name}] ${task.prompt}`
    const res = await fetch(`http://127.0.0.1:${API_PORT}/api/os-session/message`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: prompt }),
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

    // Fire one task per cycle, reschedule the rest to avoid flooding
    await fireTask(due[0])

    for (const t of due.slice(1)) {
      if (t.type === 'cron') {
        const nextRun = computeNextRun(t.cron_expression)
        if (nextRun) {
          await db`UPDATE os_scheduled_tasks SET next_run_at = ${nextRun} WHERE id = ${t.id}`
            .catch(() => {})
          logger.debug('Scheduler: rescheduled overdue cron', { name: t.name, nextRun })
        }
      }
    }
  } catch (err) {
    logger.warn('Scheduler poll error', { error: err.message })
  } finally {
    _running = false
  }
}

// ── Public API ──

function start() {
  if (_interval) return
  _interval = setInterval(pollOnce, POLL_INTERVAL_MS)
  // Catch overdue tasks quickly on startup
  setTimeout(pollOnce, 5_000)
  logger.info('Scheduler poller started (every 30s)')
}

function stop() {
  if (_interval) {
    clearInterval(_interval)
    _interval = null
    logger.info('Scheduler poller stopped')
  }
}

module.exports = { start, stop }
