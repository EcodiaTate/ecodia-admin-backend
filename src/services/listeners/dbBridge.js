'use strict'

/**
 * DB event bridge - dedicated LISTEN connection that fires pg_notify events
 * from the eos_listener_events channel into the in-process listener registry
 * via wsManager broadcast.
 *
 * Uses the postgres npm package (same as the rest of the codebase).
 * The library auto-reconnects the LISTEN connection internally on network drops.
 * Manual exponential-backoff reconnect applies only when the initial connect fails.
 *
 * NOTE: LISTEN/NOTIFY requires a direct database connection. If DATABASE_URL
 * points to a pgBouncer pooled connection in transaction mode, LISTEN will fail.
 * Use a direct connection URL for this bridge.
 *
 * Exports: start(), stop()
 * Does NOT export a listener shape - this file is a bridge, not a listener.
 */

const postgres = require('postgres')
const logger = require('../../config/logger')
const env = require('../../config/env')

let _sql = null
let _stopped = false
let _reconnectDelay = 1000  // ms, doubles on each failure, capped at 30s
let _reconnectTimer = null

// Lazy-require wsManager to avoid circular deps at module load time.
function _broadcast(type, payload) {
  try {
    const { broadcast } = require('../../websocket/wsManager')
    broadcast(type, payload)
  } catch (err) {
    logger.warn('dbBridge: wsManager broadcast failed', { error: err.message })
  }
}

function _onNotification(raw) {
  try {
    let parsed
    try {
      parsed = JSON.parse(raw)
    } catch {
      logger.warn('dbBridge: bad notification JSON', {
        preview: (typeof raw === 'string' ? raw : String(raw)).slice(0, 200),
      })
      return
    }

    _broadcast('db:event', {
      data: {
        type: 'db:event',
        table: parsed.table,
        action: parsed.action,
        row: parsed.row,
        ts: parsed.ts,
      },
    })
  } catch (err) {
    logger.warn('dbBridge: notification dispatch failed', { error: err.message })
  }
}

async function _connect() {
  if (_stopped) return

  // Clean up any prior connection before creating a new one.
  if (_sql) {
    try { await _sql.end({ timeout: 3 }) } catch {}
    _sql = null
  }

  try {
    _sql = postgres(env.DATABASE_URL, {
      max: 1,
      idle_timeout: 0,    // never close idle - LISTEN connection must stay alive
      connect_timeout: 10,
      onnotice: () => {},
    })

    // postgres v3: listen(channel, onmessage, onlistening) -> Promise<unlisten_fn>
    // The library keeps the connection alive and re-runs LISTEN on reconnect.
    await _sql.listen('eos_listener_events', _onNotification, () => {
      _reconnectDelay = 1000  // reset backoff on successful connect
      logger.info('dbBridge: LISTEN established on eos_listener_events')
    })
    // If we reach here, the initial LISTEN handshake completed successfully.
    // Subsequent reconnects are handled by the postgres library internally.
  } catch (err) {
    if (_stopped) return
    logger.warn('dbBridge: LISTEN connect failed', {
      error: err.message,
      nextRetryMs: _reconnectDelay,
    })
    _scheduleReconnect()
  }
}

function _scheduleReconnect() {
  if (_stopped || _reconnectTimer) return
  const delay = _reconnectDelay
  _reconnectDelay = Math.min(_reconnectDelay * 2, 30_000)
  logger.info('dbBridge: scheduling reconnect', { delayMs: delay })
  _reconnectTimer = setTimeout(async () => {
    _reconnectTimer = null
    if (_stopped) return
    await _connect()
  }, delay)
}

/**
 * Start the LISTEN connection. Resolves when LISTEN is confirmed, or after
 * a 5s timeout (with a warn) so a slow DB never blocks server boot.
 */
async function start() {
  _stopped = false
  _reconnectDelay = 1000

  return new Promise((resolve) => {
    let settled = false
    const settle = () => {
      if (settled) return
      settled = true
      resolve()
    }

    const timeoutId = setTimeout(() => {
      logger.warn('dbBridge: LISTEN not confirmed within 5s - server will continue without db bridge')
      settle()
    }, 5000)

    _connect().then(() => {
      clearTimeout(timeoutId)
      settle()
    }).catch((err) => {
      clearTimeout(timeoutId)
      logger.warn('dbBridge: initial connect threw', { error: err.message })
      settle()
    })
  })
}

/**
 * Stop the LISTEN connection cleanly.
 */
async function stop() {
  _stopped = true
  if (_reconnectTimer) {
    clearTimeout(_reconnectTimer)
    _reconnectTimer = null
  }
  if (_sql) {
    try { await _sql.end({ timeout: 5 }) } catch {}
    _sql = null
  }
}

module.exports = { start, stop }
