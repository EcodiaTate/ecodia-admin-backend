const env = require('./env')
const logger = require('./logger')

// ═══════════════════════════════════════════════════════════════════════
// REDIS CLIENT — Shared singleton for all services
//
// Lazy-initialised on first getRedisClient() call. Returns null if
// REDIS_URL is not configured — callers must handle this gracefully.
// ═══════════════════════════════════════════════════════════════════════

let client = null

function getRedisClient() {
  if (client && client.status !== 'end') return client
  if (!env.REDIS_URL) return null

  // If we had a dead client from a previous drop, force-drop refs before reconnecting.
  if (client) {
    try { client.removeAllListeners() } catch {}
    client = null
  }

  try {
    const Redis = require('ioredis')
    client = new Redis(env.REDIS_URL, {
      maxRetriesPerRequest: null,          // null = retry forever on reconnect (vs bail after 3)
      enableOfflineQueue: true,            // queue commands while reconnecting instead of erroring
      retryStrategy: (times) => Math.min(times * 200, 5000),
      reconnectOnError: (err) => {
        // Reconnect on READONLY, ETIMEDOUT, ECONNRESET, anything network-y.
        logger.debug('Redis reconnectOnError', { error: err.message })
        return true
      },
      lazyConnect: true,
    })
    client.connect().catch((err) => {
      logger.warn('Redis initial connection failed — ioredis will retry', { error: err.message })
    })
    client.on('error',     (err) => logger.debug('Redis client error', { error: err.message }))
    client.on('connect',   ()    => logger.info('Redis shared client connected'))
    client.on('reconnecting', () => logger.info('Redis reconnecting...'))
    // 'end' = client permanently closed. Null the singleton so next getRedisClient()
    // creates a fresh instance instead of handing back a corpse.
    client.on('end',       ()    => {
      logger.warn('Redis client ended — will recreate on next getRedisClient()')
      client = null
    })
    return client
  } catch (err) {
    logger.warn('Failed to create Redis client', { error: err.message })
    return null
  }
}

module.exports = { getRedisClient }
