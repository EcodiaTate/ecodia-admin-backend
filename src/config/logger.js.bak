const { createLogger, format, transports, Transport } = require('winston')
const env = require('./env')

// ─── DB Error Transport ───────────────────────────────────────────────
// Writes error-level log events to the app_errors table so the
// autonomous maintenance worker and KG can read them.
// The system sees its own errors — self-awareness without human intervention.
//
// Uses a lazy require + fire-and-forget to avoid circular dependency issues
// and to never block the logger.

class DBErrorTransport extends Transport {
  constructor(opts) {
    super(opts)
    this.name = 'db-error'
    this._ready = false
    this._queue = []
    this._retryQueue = [] // errors that failed to write to DB
    this._retryTimer = null

    // Defer DB require until after module graph is fully loaded
    setImmediate(() => {
      try {
        this._db = require('./db')
        this._ready = true
        // Flush any queued writes
        for (const info of this._queue) this._write(info)
        this._queue = []
      } catch {
        // DB unavailable — degrade silently
      }
    })
  }

  log(info, callback) {
    setImmediate(() => {
      if (!this._ready) {
        this._queue.push(info)
      } else {
        this._write(info)
      }
    })
    callback()
  }

  _write(info) {
    try {
      const db = this._db
      if (!db) return

      // Extract useful fields from the log metadata
      const meta = { ...info }
      delete meta.level
      delete meta.message
      delete meta.timestamp
      delete meta.service
      delete meta.stack

      db`
        INSERT INTO app_errors (level, message, service, module, path, method, stack, meta)
        VALUES (
          ${info.level || 'error'},
          ${(info.message || '').slice(0, 2000)},
          ${info.service || null},
          ${info.module || meta.domain || null},
          ${info.path || null},
          ${info.method || null},
          ${info.stack ? String(info.stack).slice(0, 5000) : null},
          ${JSON.stringify(meta)}
        )
      `.catch(() => {
          // DB write failed — queue for retry (keep last 50 to avoid unbounded growth)
          if (this._retryQueue.length < 50) {
            this._retryQueue.push(info)
            this._scheduleRetry()
          }
        })

      // Broadcast error to WebSocket so Cortex sees it immediately,
      // not on the next 15-min maintenance worker poll cycle.
      try {
        const wsManager = require('../websocket/wsManager')
        wsManager.broadcast('app:error', {
          level: info.level || 'error',
          message: (info.message || '').slice(0, 500),
          module: info.module || meta.domain || null,
          service: info.service || null,
          timestamp: info.timestamp || new Date().toISOString(),
        })
      } catch {
        // WebSocket may not be initialised yet during startup
      }
    } catch {
      // absolutely never throw from a logger
    }
  }

  _scheduleRetry() {
    if (this._retryTimer) return
    this._retryTimer = setTimeout(() => {
      this._retryTimer = null
      const batch = this._retryQueue.splice(0)
      for (const info of batch) this._write(info)
    }, 30_000) // retry after 30s
  }
}

const logger = createLogger({
  level: env.NODE_ENV === 'production' ? 'info' : 'debug',
  format: format.combine(
    format.timestamp(),
    format.errors({ stack: true }),
    env.NODE_ENV === 'production'
      ? format.json()
      : format.combine(format.colorize(), format.simple())
  ),
  defaultMeta: { service: 'ecodiaos' },
  transports: [
    new transports.Console(),
    ...(env.NODE_ENV === 'production'
      ? [
          new transports.File({ filename: 'logs/error.log', level: 'error' }),
          new transports.File({ filename: 'logs/combined.log' }),
          // Persist errors to DB so the system can see its own failures
          new DBErrorTransport({ level: 'error' }),
        ]
      : []),
  ],
})

module.exports = logger
