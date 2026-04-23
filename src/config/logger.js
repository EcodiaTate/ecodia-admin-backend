const { createLogger, format, transports, Transport } = require('winston')
const env = require('./env')

// ─── DB Error Transport ───────────────────────────────────────────────
// Writes error-level log events to the app_errors table so the
// autonomous maintenance worker and KG can read them.
// The system sees its own errors — self-awareness without human intervention.
//
// Uses a lazy require + fire-and-forget to avoid circular dependency issues
// and to never block the logger.

// Rate-limit + fire-and-forget hardening — 2026-04-23 incident:
// A flood of git-error logs (from factoryOversightService aborting non-
// existent cherry-picks) saturated this transport. Its setImmediate() queue
// backed up to the point where winston's backpressure wedged every subsequent
// logger.info call — which froze every new OS turn because "OS Session
// starting" couldn't log. That hung the entire queue indefinitely.
//
// Hardening:
//   1. callback() fires SYNCHRONOUSLY so winston never blocks on this transport
//   2. Rate limiter drops excess writes rather than queueing unbounded setImmediates
//   3. DB insert and WS broadcast are both fire-and-forget with internal timeouts
//   4. wsManager broadcast wrapped so it can never throw sync
const DB_TRANSPORT_RATE_LIMIT = 10     // max writes per window
const DB_TRANSPORT_RATE_WINDOW_MS = 1_000
const DB_TRANSPORT_INSERT_TIMEOUT_MS = 2_000

class DBErrorTransport extends Transport {
  constructor(opts) {
    super(opts)
    this.name = 'db-error'
    this._ready = false
    this._queue = []
    this._retryQueue = []
    this._retryTimer = null
    // Rate-limit bookkeeping
    this._rateWindowStart = Date.now()
    this._rateCount = 0
    this._rateDropped = 0

    // Defer DB require until after module graph is fully loaded
    setImmediate(() => {
      try {
        this._db = require('./db')
        this._ready = true
        // Flush any queued writes (honours rate limit)
        for (const info of this._queue) this._dispatch(info)
        this._queue = []
      } catch {
        // DB unavailable — degrade silently
      }
    })
  }

  log(info, callback) {
    // ALWAYS call callback synchronously. Winston uses this to know the
    // transport has accepted the log — any delay here accumulates backpressure
    // across every transport on every logger call.
    if (callback) callback()

    // Actual work happens on the next tick so we never block the caller.
    setImmediate(() => {
      if (!this._ready) {
        // Bounded buffer — early boot only
        if (this._queue.length < 100) this._queue.push(info)
        return
      }
      this._dispatch(info)
    })
  }

  _checkRate() {
    const now = Date.now()
    if (now - this._rateWindowStart >= DB_TRANSPORT_RATE_WINDOW_MS) {
      if (this._rateDropped > 0) {
        // Emit a summary log (via console.warn — never recurse through winston)
        // eslint-disable-next-line no-console
        console.warn(`[logger] DBErrorTransport dropped ${this._rateDropped} log(s) in last ${DB_TRANSPORT_RATE_WINDOW_MS}ms (rate limit ${DB_TRANSPORT_RATE_LIMIT}/window)`)
      }
      this._rateWindowStart = now
      this._rateCount = 0
      this._rateDropped = 0
    }
    if (this._rateCount >= DB_TRANSPORT_RATE_LIMIT) {
      this._rateDropped++
      return false
    }
    this._rateCount++
    return true
  }

  _dispatch(info) {
    if (!this._checkRate()) return
    this._write(info)
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

      // Fire-and-forget with a hard timeout so a contended pool never wedges
      // anything. If the insert doesn't complete in 2s, we drop the entry
      // rather than retry (retry-queueing was the 2026-04-23 backpressure bug).
      Promise.race([
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
        `,
        new Promise((_, reject) => setTimeout(() => reject(new Error('db insert timeout')), DB_TRANSPORT_INSERT_TIMEOUT_MS)),
      ]).catch(() => { /* drop silently — never recurse through winston */ })

      // Broadcast error to WS (also fire-and-forget, also guarded)
      setImmediate(() => {
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
          // WebSocket not initialised, or broadcast threw — ignore
        }
      })
    } catch {
      // absolutely never throw from a logger
    }
  }
}

// ─── Retrospective debug ring-buffer transport ──────────────────────
// Problem solved: production log level is 'info' so debug context is
// discarded. When an error fires we have the error but no trail leading
// up to it — useless for triage when the OS is wedged and you can't ask
// it what happened.
//
// This transport accepts ALL levels (including debug/verbose) but keeps
// them only in an in-memory circular buffer. On every `error` log, it
// flushes the current buffer to a retrospective dump file with a
// timestamped name. Net effect: zero cost during healthy operation
// (memory-only), full debug context captured around every real error.
//
// Also exposes getRecentLogs() so triage tooling (the rescue process,
// /api/triage/dump, etc) can read the current window programmatically.

const RING_BUFFER_SIZE = parseInt(process.env.LOG_RING_BUFFER_SIZE || '500', 10)
const RETRO_DUMP_DIR = process.env.LOG_RETRO_DUMP_DIR || 'logs/retro'
const _fs = require('fs')
const _path = require('path')
let _lastDumpAt = 0
const RETRO_DUMP_COOLDOWN_MS = 10_000 // one retro dump per 10s max

class RingBufferTransport extends Transport {
  constructor(opts) {
    super(opts)
    this.name = 'ring-buffer'
    this._buf = new Array(RING_BUFFER_SIZE)
    this._head = 0
    this._len = 0
  }

  log(info, callback) {
    if (callback) callback() // always sync ack

    // Normalise — winston passes info with a Symbol(level) in addition to info.level.
    const entry = {
      ts: new Date().toISOString(),
      level: info.level,
      message: info.message,
      ...Object.fromEntries(Object.entries(info).filter(([k]) => (
        k !== 'level' && k !== 'message' && k !== 'timestamp' &&
        typeof k === 'string' && !k.startsWith('Symbol')
      ))),
    }
    this._buf[this._head] = entry
    this._head = (this._head + 1) % RING_BUFFER_SIZE
    if (this._len < RING_BUFFER_SIZE) this._len++

    // On error: dump the ring buffer to disk (cooldown-gated) so there's a
    // persistent debug trail around every error. Fire-and-forget.
    if (info.level === 'error' && env.NODE_ENV === 'production') {
      const now = Date.now()
      if (now - _lastDumpAt > RETRO_DUMP_COOLDOWN_MS) {
        _lastDumpAt = now
        setImmediate(() => this._dumpToDisk(entry).catch(() => {}))
      }
    }
  }

  getRecent(limit) {
    const n = Math.min(limit || this._len, this._len)
    const out = []
    for (let i = 0; i < n; i++) {
      const idx = (this._head - n + i + RING_BUFFER_SIZE) % RING_BUFFER_SIZE
      const entry = this._buf[idx]
      if (entry) out.push(entry)
    }
    return out
  }

  async _dumpToDisk(triggerEntry) {
    try {
      _fs.mkdirSync(RETRO_DUMP_DIR, { recursive: true })
      const stamp = new Date().toISOString().replace(/[:.]/g, '-')
      const file = _path.join(RETRO_DUMP_DIR, `retro-${stamp}.jsonl`)
      const lines = []
      lines.push(JSON.stringify({ _retro_header: true, trigger: triggerEntry, ts: new Date().toISOString() }))
      for (const entry of this.getRecent(RING_BUFFER_SIZE)) {
        lines.push(JSON.stringify(entry))
      }
      _fs.writeFileSync(file, lines.join('\n') + '\n')
    } catch {
      // never throw from a logger transport
    }
  }
}

const _ringTransport = new RingBufferTransport({ level: 'silly' })

// Set logger level to 'silly' so every call reaches the transports. Each
// transport then filters to its own level, so Console/File still only get
// info+ in prod while the ring buffer catches everything.
const _consoleTransport = new transports.Console({ level: env.NODE_ENV === 'production' ? 'info' : 'debug' })
const _combinedFile = env.NODE_ENV === 'production'
  ? new transports.File({ filename: 'logs/combined.log', level: 'info' })
  : null
const _errorFile = env.NODE_ENV === 'production'
  ? new transports.File({ filename: 'logs/error.log', level: 'error' })
  : null
const _dbErrorTransport = env.NODE_ENV === 'production'
  ? new DBErrorTransport({ level: 'error' })
  : null

const logger = createLogger({
  level: 'silly', // global floor; real filtering is per-transport
  format: format.combine(
    format.timestamp(),
    format.errors({ stack: true }),
    env.NODE_ENV === 'production'
      ? format.json()
      : format.combine(format.colorize(), format.simple())
  ),
  defaultMeta: { service: 'ecodiaos' },
  transports: [
    _consoleTransport,
    ...(env.NODE_ENV === 'production'
      ? [_errorFile, _combinedFile, _dbErrorTransport]
      : []),
    _ringTransport,
  ],
})

// Expose programmatic access to the ring buffer for triage tooling.
logger.getRecentLogs = (limit) => _ringTransport.getRecent(limit)

module.exports = logger
