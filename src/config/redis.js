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
  if (client) return client
  if (!env.REDIS_URL) return null

  try {
    const Redis = require('ioredis')
    client = new Redis(env.REDIS_URL, {
      maxRetriesPerRequest: 3,
      retryStrategy: (times) => Math.min(times * 200, 5000),
      lazyConnect: true,
    })
    client.connect().catch((err) => {
      logger.warn('Redis connection failed', { error: err.message })
      client = null
    })
    client.on('error', (err) => logger.debug('Redis client error', { error: err.message }))
    client.on('connect', () => logger.info('Redis shared client connected'))
    return client
  } catch (err) {
    logger.warn('Failed to create Redis client', { error: err.message })
    return null
  }
}

module.exports = { getRedisClient }
