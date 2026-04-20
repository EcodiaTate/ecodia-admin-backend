const { EventEmitter } = require('events')
const logger = require('../config/logger')
const env = require('../config/env')

// ═══════════════════════════════════════════════════════════════════════
// INTERNAL EVENT BUS — The Nervous System Between Services
//
// In-process EventEmitter + optional Redis pub/sub for cross-worker.
// This is how services talk to each other. KG finds a pattern →
// Factory hears about it. Factory deploys → Memory bridge syncs.
// Metabolism shifts → Everyone adapts.
//
// Modeled after the organism's Synapse event bus.
//
// Event types:
//   kg:*             — Knowledge graph events (prediction, pattern, dedup)
//   factory:*        — Factory session lifecycle events
//   memory:*         — High-importance node events
//   metabolism:*     — Metabolic pressure changes
//   action:*         — Action queue events
//   direct:*         — Direct action events
//   symbridge:*      — Symbridge message events
// ═══════════════════════════════════════════════════════════════════════

const emitter = new EventEmitter()
emitter.setMaxListeners(50) // many services subscribe

let redis = null
let redisSub = null
const REDIS_CHANNEL = 'ecodiaos:internal_events'
const persistByDefault = (env.EVENT_BUS_PERSIST_DEFAULT || 'false') === 'true'

// ─── Initialize Redis (optional, for cross-worker events) ───────────

async function initRedis() {
  if (!env.REDIS_URL) return

  try {
    // Publisher reuses the shared singleton so we're not doubling connection count.
    // Subscriber needs its own client — ioredis holds sub clients in blocking mode
    // so they can't run regular commands. Give it the same resilient retry config
    // as the singleton so a brief network blip doesn't permanently stop events.
    const Redis = require('ioredis')
    const { getRedisClient } = require('../config/redis')
    redis = getRedisClient()
    redisSub = new Redis(env.REDIS_URL, {
      maxRetriesPerRequest: null,
      enableOfflineQueue: true,
      retryStrategy: (times) => Math.min(times * 200, 5000),
      reconnectOnError: () => true,
    })

    redisSub.subscribe(REDIS_CHANNEL, (err) => {
      if (err) {
        logger.debug('Event bus Redis subscribe failed', { error: err.message })
        return
      }
      logger.info('Internal event bus: Redis pub/sub connected')
    })

    redisSub.on('message', (channel, message) => {
      if (channel !== REDIS_CHANNEL) return
      try {
        const { type, payload, _source } = JSON.parse(message)
        // Emit locally but mark as from-redis to prevent re-publish loops
        emitter.emit(type, payload, { fromRedis: true })
      } catch {}
    })

    redis.on('error', (err) => logger.debug('Event bus Redis error', { error: err.message }))
    redisSub.on('error', (err) => logger.debug('Event bus Redis sub error', { error: err.message }))
  } catch (err) {
    logger.debug('Event bus Redis init failed', { error: err.message })
  }
}

// ─── Emit Event ─────────────────────────────────────────────────────

function emit(type, payload = {}, { persist, fromRedis } = {}) {
  // Emit in-process
  emitter.emit(type, payload)

  // Publish to Redis if available and not already from Redis
  if (redis && !fromRedis) {
    redis.publish(REDIS_CHANNEL, JSON.stringify({ type, payload, _source: process.pid })).catch(() => {})
  }

  // Persist to DB if requested (or if default is on)
  if (persist || (persist === undefined && persistByDefault)) {
    const db = require('../config/db')
    db`
      INSERT INTO event_bus_log (event_type, payload, source_service)
      VALUES (${type}, ${JSON.stringify(payload)}, ${payload._source || 'unknown'})
    `.catch(() => {})
  }

  logger.debug(`Event bus: ${type}`, { payloadKeys: Object.keys(payload) })
}

// ─── Subscribe ──────────────────────────────────────────────────────

function on(type, handler) {
  emitter.on(type, handler)
}

function off(type, handler) {
  emitter.off(type, handler)
}

function once(type, handler) {
  emitter.once(type, handler)
}

// ─── Query: Recent Events (from DB log) ─────────────────────────────

async function getRecentEvents({ type, limit = 20, since } = {}) {
  const db = require('../config/db')
  if (type) {
    return db`
      SELECT * FROM event_bus_log
      WHERE event_type = ${type}
        ${since ? db`AND created_at > ${since}` : db``}
      ORDER BY created_at DESC
      LIMIT ${limit}
    `
  }
  return db`
    SELECT * FROM event_bus_log
    ${since ? db`WHERE created_at > ${since}` : db``}
    ORDER BY created_at DESC
    LIMIT ${limit}
  `
}

module.exports = {
  initRedis,
  emit,
  on,
  off,
  once,
  getRecentEvents,
}
