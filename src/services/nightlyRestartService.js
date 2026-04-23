/**
 * Nightly Restart — scheduled `pm2 restart ecodia-api` with OS heads-up.
 *
 * Why: guaranteed daily reset absorbs slow leaks (RAM creep, orphan sockets,
 * stuck MCP stdio, stale pools). The OS itself survives restarts cleanly
 * thanks to sessionHandoff + seq/epoch recovery + zombie-session auto-heal.
 *
 * Flow:
 *   T-5min (02:55 AEST by default):
 *     - broadcast `os-session:pending_restart` to WS (frontend banner)
 *     - inject a [SYSTEM] message into the OS inbox so it sees the warning
 *       in-turn and can checkpoint/finish gracefully
 *   T-0min (03:00 AEST):
 *     - snapshot handoff state (fire-and-forget)
 *     - if OS is busy, wait up to NIGHTLY_RESTART_GRACE_MIN minutes for idle
 *     - spawn `pm2 restart ecodia-api` detached + unref
 *
 * Disable with NIGHTLY_RESTART_ENABLED=false.
 */

const { spawn } = require('child_process')
const logger = require('../config/logger')

const TZ_OFFSET_HOURS = 10 // AEST (matches schedulerPollerService)
const API_PORT = process.env.PORT || 3001

const ENABLED = (process.env.NIGHTLY_RESTART_ENABLED || 'true').toLowerCase() !== 'false'
const HOUR_AEST = parseInt(process.env.NIGHTLY_RESTART_HOUR_AEST || '3', 10)
const MINUTE_AEST = parseInt(process.env.NIGHTLY_RESTART_MINUTE_AEST || '0', 10)
const WARN_MIN = parseInt(process.env.NIGHTLY_RESTART_WARN_MIN || '5', 10)
const GRACE_MIN = parseInt(process.env.NIGHTLY_RESTART_GRACE_MIN || '10', 10)
const PM2_PROCESS = process.env.NIGHTLY_RESTART_PM2_NAME || 'ecodia-api'

let _warnTimer = null
let _restartTimer = null
let _stopped = false

function _nextRestartAt() {
  let utcHour = HOUR_AEST - TZ_OFFSET_HOURS
  if (utcHour < 0) utcHour += 24
  const next = new Date()
  next.setUTCHours(utcHour, MINUTE_AEST, 0, 0)
  if (next <= new Date()) next.setUTCDate(next.getUTCDate() + 1)
  return next
}

async function _sendWarning(scheduledFor) {
  // WS broadcast — frontend banner. Never throw.
  try {
    const { broadcast } = require('../websocket/wsManager')
    broadcast('os-session:pending_restart', {
      minutes: WARN_MIN,
      process: PM2_PROCESS,
      scheduledFor: scheduledFor.toISOString(),
    })
  } catch (err) {
    logger.debug('nightlyRestart: WS warn broadcast failed', { error: err.message })
  }

  // In-turn message so the OS sees it and can wrap up. Posted via the normal
  // /message endpoint so it queues behind any active turn (priority:false
  // default in the route) — we do NOT want to preempt mid-stream work.
  try {
    const body = JSON.stringify({
      message: `[SYSTEM: nightly_restart] ecodia-api will restart in ${WARN_MIN} minutes at ${scheduledFor.toISOString()}. If you're mid-turn, finish or checkpoint now — your handoff state will be saved and you resume automatically on the new process.`,
    })
    await fetch(`http://127.0.0.1:${API_PORT}/api/os-session/message`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      signal: AbortSignal.timeout(10_000),
    })
  } catch (err) {
    logger.warn('nightlyRestart: system-message warn failed', { error: err.message })
  }

  logger.info('nightlyRestart: T-minus warning sent', {
    warnMin: WARN_MIN, scheduledFor: scheduledFor.toISOString(),
  })
}

async function _snapshotHandoff() {
  try {
    const { saveHandoffState } = require('./sessionHandoff')
    await saveHandoffState({
      current_work: 'nightly scheduled restart',
      active_plan: null,
      tate_last_direction: null,
      deliverables_status: null,
    })
  } catch (err) {
    logger.debug('nightlyRestart: handoff snapshot failed', { error: err.message })
  }
}

function _isBusy() {
  try {
    const osSession = require('./osSessionService')
    if (typeof osSession._isQueueBusy === 'function') return !!osSession._isQueueBusy()
  } catch {}
  return false
}

async function _waitForIdle(maxMs) {
  const deadline = Date.now() + maxMs
  const pollMs = 30_000
  while (Date.now() < deadline) {
    if (!_isBusy()) return { idle: true, waitedMs: maxMs - (deadline - Date.now()) }
    await new Promise(r => setTimeout(r, pollMs))
  }
  return { idle: false, waitedMs: maxMs }
}

function _doRestart(reason) {
  logger.warn('nightlyRestart: firing pm2 restart', { process: PM2_PROCESS, reason })
  try {
    // Detached + unref so the current process can die without stranding the
    // child. Mirrors the self-mod restart pattern in deploymentService.js.
    const child = spawn('pm2', ['restart', PM2_PROCESS], {
      detached: true, stdio: 'ignore',
    })
    child.unref()
  } catch (err) {
    logger.error('nightlyRestart: spawn pm2 restart failed', { error: err.message })
  }
}

async function _onRestartTime(scheduledFor) {
  if (_stopped) return
  logger.info('nightlyRestart: T-0 reached, beginning restart sequence', {
    scheduledFor: scheduledFor.toISOString(),
  })

  await _snapshotHandoff()

  if (_isBusy()) {
    logger.info('nightlyRestart: OS busy at T-0, waiting for idle window', { graceMin: GRACE_MIN })
    const { idle, waitedMs } = await _waitForIdle(GRACE_MIN * 60_000)
    if (idle) {
      _doRestart(`idle_after_${Math.round(waitedMs / 1000)}s`)
    } else {
      _doRestart('force_restart_busy_grace_exhausted')
    }
  } else {
    _doRestart('idle')
  }
}

function _scheduleNext() {
  if (_stopped) return
  if (_warnTimer) { clearTimeout(_warnTimer); _warnTimer = null }
  if (_restartTimer) { clearTimeout(_restartTimer); _restartTimer = null }

  const scheduledFor = _nextRestartAt()
  const now = Date.now()
  const warnAt = scheduledFor.getTime() - WARN_MIN * 60_000
  const msToWarn = Math.max(0, warnAt - now)
  const msToRestart = Math.max(0, scheduledFor.getTime() - now)

  _warnTimer = setTimeout(() => {
    _sendWarning(scheduledFor).catch(err => logger.warn('nightlyRestart: warn threw', { error: err.message }))
  }, msToWarn)
  if (typeof _warnTimer.unref === 'function') _warnTimer.unref()

  _restartTimer = setTimeout(() => {
    _onRestartTime(scheduledFor).catch(err => logger.error('nightlyRestart: restart handler threw', { error: err.message }))
  }, msToRestart)
  if (typeof _restartTimer.unref === 'function') _restartTimer.unref()

  logger.info('nightlyRestart: scheduled', {
    scheduledFor: scheduledFor.toISOString(),
    warnInMs: msToWarn,
    restartInMs: msToRestart,
    process: PM2_PROCESS,
  })
}

function start() {
  if (!ENABLED) {
    logger.info('nightlyRestart: disabled via NIGHTLY_RESTART_ENABLED=false')
    return
  }
  _stopped = false
  _scheduleNext()
}

function stop() {
  _stopped = true
  if (_warnTimer) { clearTimeout(_warnTimer); _warnTimer = null }
  if (_restartTimer) { clearTimeout(_restartTimer); _restartTimer = null }
}

module.exports = { start, stop }
