const crypto = require('crypto')
const axios = require('axios')
const db = require('../config/db')
const env = require('../config/env')
const logger = require('../config/logger')
const { runWrite, runQuery } = require('../config/neo4j')

// ═══════════════════════════════════════════════════════════════════════
// SYMBRIDGE SERVICE — Nervous System Between Two Bodies
//
// 3-layer redundant communication:
//   Layer 1: Redis Streams (primary, ~1ms)
//   Layer 2: Neo4j nodes (secondary, ~100ms, persistent)
//   Layer 3: HTTP REST (tertiary, fallback)
//
// Every message travels all 3 layers simultaneously.
// HMAC-SHA256 authenticated. Full Postgres audit trail.
// ═══════════════════════════════════════════════════════════════════════

let redis = null

// ─── Redis Setup ────────────────────────────────────────────────────

async function initRedis() {
  if (!env.REDIS_URL) {
    logger.debug('Symbridge Redis disabled — no REDIS_URL')
    return null
  }

  try {
    const Redis = require('ioredis')
    redis = new Redis(env.REDIS_URL, {
      maxRetriesPerRequest: 3,
      retryStrategy: (times) => Math.min(times * 200, 5000),
    })
    redis.on('error', (err) => logger.warn('Symbridge Redis error', { error: err.message }))
    redis.on('connect', () => logger.info('Symbridge Redis connected'))
    return redis
  } catch (err) {
    logger.warn('Failed to initialize Redis for symbridge', { error: err.message })
    return null
  }
}

// ─── HMAC Authentication ────────────────────────────────────────────

function signMessage(payload) {
  if (!env.SYMBRIDGE_SECRET) return null
  const hmac = crypto.createHmac('sha256', env.SYMBRIDGE_SECRET)
  hmac.update(JSON.stringify(payload))
  return hmac.digest('hex')
}

function verifySignature(payload, signature) {
  if (!env.SYMBRIDGE_SECRET) {
    logger.warn('Symbridge: SYMBRIDGE_SECRET not configured — accepting message without auth')
    return true
  }
  if (!signature) return false
  const expected = signMessage(payload)
  if (!expected) return false
  if (signature.length !== expected.length) return false
  return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))
}

// ─── Send (all 3 layers simultaneously) ─────────────────────────────

async function send(messageType, payload, correlationId = null) {
  const message = {
    id: crypto.randomUUID(),
    type: messageType,
    payload,
    source: 'ecodiaos',
    correlationId,
    timestamp: new Date().toISOString(),
    signature: signMessage(payload),
  }

  // Postgres audit (always)
  await db`
    INSERT INTO symbridge_messages (direction, message_type, payload, source_system, status, correlation_id)
    VALUES ('outbound', ${messageType}, ${JSON.stringify(payload)}, 'ecodiaos', 'completed', ${correlationId})
  `

  const results = { redis: false, neo4j: false, http: false }

  // Layer 1: Redis
  if (redis) {
    try {
      await redis.xadd('symbridge:ecodiaos_to_organism', '*',
        'data', JSON.stringify(message))
      results.redis = true
    } catch (err) {
      logger.debug('Symbridge Redis send failed', { error: err.message })
    }
  }

  // Layer 2: Neo4j
  try {
    await runWrite(
      `CREATE (m:SymbridgeMessage {
        message_id: $id, type: $type, payload: $payload,
        source: 'ecodiaos', correlation_id: $correlationId,
        created_at: datetime(), processed: false
      })`,
      { id: message.id, type: messageType, payload: JSON.stringify(payload), correlationId: correlationId || '' }
    )
    results.neo4j = true
  } catch (err) {
    logger.debug('Symbridge Neo4j send failed', { error: err.message })
  }

  // Layer 3: HTTP
  if (env.ORGANISM_API_URL) {
    try {
      await axios.post(`${env.ORGANISM_API_URL}/api/v1/symbridge/inbound`, message, {
        timeout: 5000,
        headers: { 'X-Symbridge-Signature': message.signature },
      })
      results.http = true
    } catch (err) {
      logger.debug('Symbridge HTTP send failed', { error: err.message })
    }
  }

  const delivered = Object.values(results).some(Boolean)
  if (!delivered) {
    logger.error('Symbridge: message failed ALL 3 layers', { messageType, correlationId })
  }

  // KG ingestion — fire-and-forget
  const kgHooks = require('./kgIngestionHooks')
  kgHooks.onSymbridgeMessage({
    direction: 'outbound', messageType, payload, sourceSystem: 'ecodiaos', correlationId,
  }).catch(() => {})

  return { messageId: message.id, delivered, results }
}

// ─── Receive & Route ────────────────────────────────────────────────

async function receiveMessage(message) {
  // Verify HMAC
  if (env.SYMBRIDGE_SECRET && !verifySignature(message.payload, message.signature)) {
    logger.warn('Symbridge: invalid signature on inbound message', { type: message.type })
    return { accepted: false, reason: 'invalid_signature' }
  }

  // Audit log
  const [record] = await db`
    INSERT INTO symbridge_messages (direction, message_type, payload, source_system, status, correlation_id)
    VALUES ('inbound', ${message.type}, ${JSON.stringify(message.payload)}, ${message.source || 'organism'}, 'processing', ${message.correlationId || null})
    RETURNING id
  `

  try {
    await routeMessage(message)
    await db`UPDATE symbridge_messages SET status = 'completed', processed_at = now() WHERE id = ${record.id}`
    return { accepted: true, messageId: record.id }
  } catch (err) {
    await db`UPDATE symbridge_messages SET status = 'failed', error_message = ${err.message}, processed_at = now() WHERE id = ${record.id}`
    logger.error('Symbridge: failed to process message', { type: message.type, error: err.message })
    return { accepted: false, reason: err.message }
  }
}

async function routeMessage(message) {
  // KG ingestion for all inbound messages
  const kgHooks = require('./kgIngestionHooks')
  kgHooks.onSymbridgeMessage({
    direction: 'inbound', messageType: message.type, payload: message.payload,
    sourceSystem: message.source || 'organism', correlationId: message.correlationId,
  }).catch(() => {})

  switch (message.type) {
    case 'proposal':
    case 'simula_proposal': {
      const triggers = require('./factoryTriggerService')
      await triggers.dispatchFromSimula(message.payload)
      break
    }
    case 'thymos_incident': {
      const triggers = require('./factoryTriggerService')
      await triggers.dispatchFromThymos(message.payload)
      break
    }
    case 'capability_request': {
      const triggers = require('./factoryTriggerService')
      await triggers.dispatchFromCapabilityRequest(message.payload)
      break
    }
    case 'memory_sync': {
      const memBridge = require('./memoryBridgeService')
      await memBridge.receiveFromOrganism(message.payload)
      break
    }
    case 'metabolism': {
      const metaBridge = require('./metabolismBridgeService')
      await metaBridge.receiveFromOrganism(message.payload)
      break
    }
    case 'health': {
      const vitals = require('./vitalSignsService')
      await vitals.receiveOrganismHealth(message.payload)
      break
    }
    default:
      logger.warn(`Symbridge: unknown message type: ${message.type}`)
  }
}

// ─── Redis Consumer ─────────────────────────────────────────────────

async function startRedisConsumer() {
  if (!redis) return

  const consumerGroup = 'ecodiaos_consumers'
  const consumerName = `ecodiaos_${process.pid}`
  const stream = 'symbridge:organism_to_ecodiaos'

  // Create consumer group (ignore if exists)
  try {
    await redis.xgroup('CREATE', stream, consumerGroup, '0', 'MKSTREAM')
  } catch {
    // Group may already exist
  }

  logger.info('Symbridge Redis consumer started', { stream, consumerGroup })

  async function poll() {
    try {
      const messages = await redis.xreadgroup(
        'GROUP', consumerGroup, consumerName,
        'COUNT', 10, 'BLOCK', 5000,
        'STREAMS', stream, '>'
      )

      if (messages) {
        for (const [, entries] of messages) {
          for (const [id, fields] of entries) {
            try {
              const data = JSON.parse(fields[1]) // fields = ['data', '...json...']
              await receiveMessage(data)
              await redis.xack(stream, consumerGroup, id)
            } catch (err) {
              logger.debug('Failed to process Redis symbridge message', { error: err.message })
            }
          }
        }
      }
    } catch (err) {
      if (!err.message.includes('NOGROUP')) {
        logger.debug('Redis consumer poll error', { error: err.message })
      }
    }

    // Continue polling
    setImmediate(poll)
  }

  poll()
}

// ─── Neo4j Poller (fallback) ────────────────────────────────────────

async function pollNeo4jMessages() {
  try {
    const records = await runQuery(
      `MATCH (m:SymbridgeMessage)
       WHERE m.source = 'organism' AND m.processed = false
       RETURN m ORDER BY m.created_at ASC LIMIT 10`
    )

    for (const record of records) {
      const node = record.get('m').properties
      try {
        const message = {
          type: node.type,
          payload: JSON.parse(node.payload),
          source: node.source,
          correlationId: node.correlation_id || null,
        }
        await receiveMessage(message)
        await runWrite(
          'MATCH (m:SymbridgeMessage {message_id: $id}) SET m.processed = true',
          { id: node.message_id }
        )
      } catch (err) {
        logger.debug('Failed to process Neo4j symbridge message', { error: err.message })
      }
    }
  } catch (err) {
    logger.debug('Neo4j symbridge poll failed', { error: err.message })
  }
}

// ─── Heartbeat ──────────────────────────────────────────────────────

async function sendHeartbeat(healthData = {}) {
  await send('heartbeat', {
    status: 'alive',
    timestamp: new Date().toISOString(),
    ...healthData,
  })
}

// ─── Status ─────────────────────────────────────────────────────────

async function getStatus() {
  const [counts] = await db`
    SELECT
      count(*) FILTER (WHERE status = 'pending')::int AS pending,
      count(*) FILTER (WHERE status = 'processing')::int AS processing,
      count(*) FILTER (WHERE status = 'completed' AND created_at > now() - interval '1 hour')::int AS completed_1h,
      count(*) FILTER (WHERE status = 'failed' AND created_at > now() - interval '1 hour')::int AS failed_1h
    FROM symbridge_messages
  `

  return {
    redisConnected: redis?.status === 'ready',
    counts,
    organismUrl: env.ORGANISM_API_URL || null,
  }
}

module.exports = {
  initRedis,
  send,
  receiveMessage,
  startRedisConsumer,
  pollNeo4jMessages,
  sendHeartbeat,
  getStatus,
  verifySignature,
}
