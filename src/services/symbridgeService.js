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

  // Event bus
  try {
    const eventBus = require('./internalEventBusService')
    eventBus.emit('symbridge:message_sent', { type: messageType, correlationId })
  } catch {}

  return { messageId: message.id, delivered, results }
}

// ─── Receive & Route ────────────────────────────────────────────────

async function receiveMessage(message) {
  // Verify HMAC
  if (env.SYMBRIDGE_SECRET && !verifySignature(message.payload, message.signature)) {
    logger.warn('Symbridge: invalid signature on inbound message', { type: message.type })
    return { accepted: false, reason: 'invalid_signature' }
  }

  // Audit log — postgres driver rejects undefined, coalesce to safe defaults
  const msgType = message.type || 'unknown'
  const msgPayload = message.payload != null ? JSON.stringify(message.payload) : '{}'
  const msgSource = message.source || 'organism'
  const msgCorrelationId = message.correlationId || null

  const [record] = await db`
    INSERT INTO symbridge_messages (direction, message_type, payload, source_system, status, correlation_id)
    VALUES ('inbound', ${msgType}, ${msgPayload}, ${msgSource}, 'processing', ${msgCorrelationId})
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

  // Emit to event bus for all inbound messages
  try {
    const eventBus = require('./internalEventBusService')
    eventBus.emit('symbridge:message_received', { type: message.type, source: message.source })
  } catch {}

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
    case 'memory_sync':
    case 'memory_sync_immediate': {
      const memBridge = require('./memoryBridgeService')
      await memBridge.receiveFromOrganism(message.payload)
      break
    }
    case 'memory_query': {
      // Organism queries admin KG directly (read-only)
      const kgService = require('./knowledgeGraphService')
      const result = await kgService.getContext(message.payload.query || message.payload.q || '')
      await send('memory_query_result', { result, query: message.payload.query }, message.correlationId)
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
    case 'prediction_action':
    case 'goal_proposal': {
      // Organism sends prediction-based or autonomous goal → dispatch to Factory
      const triggers = require('./factoryTriggerService')
      await triggers.dispatchFromPrediction(message.payload)
      break
    }
    case 'factory_query': {
      // Organism queries Factory status — comprehensive snapshot
      const [active] = await db`SELECT count(*)::int AS count FROM cc_sessions WHERE status IN ('running', 'initializing')`
      const recent = await db`SELECT id, status, initial_prompt, confidence_score, started_at, trigger_source FROM cc_sessions ORDER BY started_at DESC LIMIT 5`
      const metabolismBridge = require('./metabolismBridgeService')
      const actionQueue = require('./actionQueueService')
      const aqStats = await actionQueue.getStats().catch(() => ({}))
      const [learningStats] = await db`
        SELECT count(*)::int AS total,
               count(*) FILTER (WHERE confidence > ${parseFloat(env.SYMBRIDGE_LEARNINGS_HIGH_CONFIDENCE || '0.5')})::int AS high_confidence
        FROM factory_learnings
      `.catch(() => [{}])
      await send('factory_query_result', {
        active_sessions: active.count,
        recent_sessions: recent,
        metabolic_state: metabolismBridge.getState(),
        action_queue: aqStats,
        factory_learnings: learningStats || {},
      }, message.correlationId)
      break
    }
    case 'query_factory_learnings': {
      // Organism requests Factory cross-session learnings to inform its reasoning.
      // Returns top learnings filtered by confidence, optionally by codebase.
      const codebaseFilter = message.payload?.codebase_id || null
      const limitFilter = Math.min(parseInt(message.payload?.limit, 10) || 20, 50)
      const learnings = codebaseFilter
        ? await db`
            SELECT pattern_type, pattern_description, confidence, success, times_applied, updated_at
            FROM factory_learnings
            WHERE (codebase_id = ${codebaseFilter} OR codebase_id IS NULL)
              AND confidence > ${parseFloat(env.SYMBRIDGE_LEARNINGS_CODEBASE_MIN || '0.35')}
              AND (last_applied_at IS NULL OR last_applied_at > now() - interval '90 days')
            ORDER BY confidence DESC, updated_at DESC LIMIT ${limitFilter}
          `.catch(() => [])
        : await db`
            SELECT pattern_type, pattern_description, confidence, success, times_applied, updated_at
            FROM factory_learnings
            WHERE confidence > ${parseFloat(env.SYMBRIDGE_LEARNINGS_GLOBAL_MIN || '0.4')}
              AND (last_applied_at IS NULL OR last_applied_at > now() - interval '90 days')
            ORDER BY confidence DESC, updated_at DESC LIMIT ${limitFilter}
          `.catch(() => [])
      await send('factory_learnings_result', { learnings, count: learnings.length }, message.correlationId)
      break
    }
    case 'direct_action': {
      // Organism executes integration action directly (no CC session)
      const directAction = require('./directActionService')
      const result = await directAction.execute({
        actionType: message.payload.action_type,
        params: message.payload.params || {},
        correlationId: message.correlationId,
        requestedBy: message.source || 'organism',
      })
      await send('direct_action_result', result, message.correlationId)
      break
    }
    case 'self_modification': {
      // Organism requests Factory self-modification
      const triggers = require('./factoryTriggerService')
      await triggers.dispatchSelfModification(message.payload)
      // Broadcast to frontend so UI can show self-modification proposal
      try {
        const { broadcast } = require('../websocket/wsManager')
        broadcast('self_modification', { payload: message.payload })
      } catch { /* WS may not be ready */ }
      break
    }
    case 'scaffold_integration': {
      // Organism requests new integration scaffolding
      const triggers = require('./factoryTriggerService')
      await triggers.dispatchIntegrationScaffold(message.payload)
      break
    }
    case 'cognitive_broadcast': {
      // Organism sends a cognitive percept to EcodiaOS
      // Route to internal event bus so services can react to organism's cognitive state
      logger.info(`Symbridge: processing cognitive_broadcast (${message.payload.percept_type}, salience: ${message.payload.salience})`)
      const eventBus = require('./internalEventBusService')
      eventBus.emit('organism:cognitive_broadcast', {
        percept_type: message.payload.percept_type,
        salience: message.payload.salience,
        content: message.payload.content,
        source: message.source || 'organism',
      })
      // Broadcast to frontend so UI can display organism surfacings
      try {
        const { broadcast } = require('../websocket/wsManager')
        broadcast('cognitive_broadcast', {
          payload: {
            percept_type: message.payload.percept_type,
            salience: message.payload.salience,
            content: message.payload.content,
          },
        })
      } catch { /* WS may not be ready */ }
      logger.debug(`Symbridge: received cognitive broadcast (${message.payload.percept_type}, salience: ${message.payload.salience})`)
      break
    }
    case 'rollback_request': {
      // Organism (or Factory itself) requests a git revert of a previous session
      const executionId = message.payload.execution_id || message.payload.session_id || message.correlationId
      if (!executionId) {
        logger.warn('Symbridge: rollback_request missing execution_id / session_id')
        break
      }
      const deploymentService = require('./deploymentService')
      try {
        await deploymentService.revertSession(executionId)
        logger.info(`Symbridge: rollback completed for session ${executionId}`)
        await send('rollback_result', { execution_id: executionId, status: 'reverted' }, message.correlationId)
      } catch (err) {
        logger.error(`Symbridge: rollback failed for session ${executionId}`, { error: err.message })
        await send('rollback_result', { execution_id: executionId, status: 'failed', error: err.message }, message.correlationId)
      }
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
    await redis.xgroup('CREATE', stream, consumerGroup, '$', 'MKSTREAM')
  } catch {
    // Group already exists — advance to latest so we don't replay old messages
    try { await redis.xgroup('SETID', stream, consumerGroup, '$') } catch {}
  }

  // Clean stale consumers from previous PM2 restarts
  try {
    const consumers = await redis.xinfo('CONSUMERS', stream, consumerGroup)
    for (let i = 0; i < consumers.length; i += 2) {
      // xinfo returns flat array: [name, val, name, val, ...] per consumer block
    }
    // Simpler: just delete all consumers except ours — they'll be recreated if alive
    const consumerList = await redis.call('XINFO', 'CONSUMERS', stream, consumerGroup)
    // Parse consumer names from the nested response
    if (Array.isArray(consumerList)) {
      for (const entry of consumerList) {
        const name = Array.isArray(entry) ? entry[1] : entry?.name
        if (name && name !== consumerName) {
          try { await redis.xgroup('DELCONSUMER', stream, consumerGroup, name) } catch {}
        }
      }
    }
  } catch {}

  logger.info('Symbridge Redis consumer started', { stream, consumerGroup, consumer: consumerName })

  // Dedicated connection for blocking XREADGROUP — ioredis with maxRetriesPerRequest
  // can hang on BLOCK commands when the main client retries interfere.
  const Redis = require('ioredis')
  const blockingRedis = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null })
  blockingRedis.on('error', () => {})

  async function poll() {
    try {
      const messages = await blockingRedis.xreadgroup(
        'GROUP', consumerGroup, consumerName,
        'COUNT', 10, 'BLOCK', 2000,
        'STREAMS', stream, '>'
      )

      if (messages) {
        logger.info(`Symbridge consumer: received ${messages.length} stream(s)`)
        for (const [, entries] of messages) {
          for (const [id, fields] of entries) {
            try {
              // ioredis returns fields as flat array: ['key1','val1','key2','val2',...]
              let raw
              if (Array.isArray(fields)) {
                // Find 'data' field in alternating key-value pairs
                const idx = fields.indexOf('data')
                raw = idx >= 0 ? fields[idx + 1] : fields[1]
              } else {
                raw = fields.data || fields
              }
              const data = JSON.parse(raw)
              await receiveMessage(data)
              await redis.xack(stream, consumerGroup, id)
            } catch (err) {
              logger.info('Failed to process Redis symbridge message', { error: err.message, fieldsType: typeof fields, isArray: Array.isArray(fields), sample: JSON.stringify(fields).slice(0, 200) })
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
        const payload = JSON.parse(node.payload)
        const message = {
          type: node.type,
          payload,
          source: node.source,
          correlationId: node.correlation_id || null,
          // Neo4j is an internal transport — re-sign so receiveMessage passes auth
          signature: signMessage(payload),
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
