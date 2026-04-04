const logger = require('../config/logger')
const { getRedisClient } = require('../config/redis')

// ═══════════════════════════════════════════════════════════════════════
// FACTORY BRIDGE — Redis communication between ecodia-api and ecodia-factory
//
// ecodia-api publishes session requests → ecodia-factory consumes them.
// ecodia-factory publishes session completions/status → ecodia-api consumes.
// WebSocket broadcasts relay through Redis so the API process can push
// to connected clients on behalf of the factory process.
//
// Channels:
//   factory:session:request    — new session to start (api → factory)
//   factory:session:complete   — session finished (factory → api)
//   factory:session:status     — real-time status updates (factory → api)
//   factory:ws:broadcast       — WS broadcast relay (factory → api → clients)
//   factory:session:send       — send message to running session (api → factory)
//   factory:session:stop       — stop a running session (api → factory)
//   factory:session:resume     — resume a paused session (api → factory)
// ═══════════════════════════════════════════════════════════════════════

const CHANNELS = {
  SESSION_REQUEST: 'factory:session:request',
  SESSION_COMPLETE: 'factory:session:complete',
  SESSION_STATUS: 'factory:session:status',
  WS_BROADCAST: 'factory:ws:broadcast',
  SESSION_SEND: 'factory:session:send',
  SESSION_STOP: 'factory:session:stop',
  SESSION_RESUME: 'factory:session:resume',
}

// ─── Publisher (used by both processes) ─────────────────────────────

function publish(channel, data) {
  const redis = getRedisClient()
  if (!redis) {
    logger.warn('factoryBridge.publish: no Redis client — message dropped', { channel })
    return false
  }
  redis.publish(channel, JSON.stringify(data))
  return true
}

// ─── API-side: publish session requests, subscribe to completions ───

function publishSessionRequest(sessionData) {
  return publish(CHANNELS.SESSION_REQUEST, sessionData)
}

function publishSendMessage(sessionId, content) {
  return publish(CHANNELS.SESSION_SEND, { sessionId, content })
}

function publishStopSession(sessionId) {
  return publish(CHANNELS.SESSION_STOP, { sessionId })
}

function publishResumeSession(sessionId, message) {
  return publish(CHANNELS.SESSION_RESUME, { sessionId, message })
}

// ─── Factory-side: publish completions, status, WS relay ────────────

function publishSessionComplete(sessionId, status, extra = {}) {
  return publish(CHANNELS.SESSION_COMPLETE, { sessionId, status, ...extra })
}

function publishSessionStatus(sessionId, statusType, data = {}) {
  return publish(CHANNELS.SESSION_STATUS, { sessionId, statusType, ...data })
}

function publishWsBroadcast(sessionId, type, data) {
  return publish(CHANNELS.WS_BROADCAST, { sessionId, type, data })
}

// ─── Subscriber (creates a dedicated Redis connection for sub) ──────

let _subscriber = null

function _getSubscriber() {
  if (_subscriber) return _subscriber
  const redis = getRedisClient()
  if (!redis) return null
  // ioredis: duplicate() creates a new connection for subscriptions
  // (a subscribed connection can't be used for commands)
  _subscriber = redis.duplicate()
  _subscriber.on('error', (err) => logger.debug('factoryBridge subscriber error', { error: err.message }))
  return _subscriber
}

function subscribe(channel, callback) {
  const sub = _getSubscriber()
  if (!sub) {
    logger.warn('factoryBridge.subscribe: no Redis client — subscription skipped', { channel })
    return
  }
  sub.subscribe(channel, (err) => {
    if (err) logger.warn('factoryBridge subscribe failed', { channel, error: err.message })
    else logger.info(`factoryBridge subscribed to ${channel}`)
  })
  sub.on('message', (ch, message) => {
    if (ch !== channel) return
    try {
      callback(JSON.parse(message))
    } catch (err) {
      logger.warn('factoryBridge message parse error', { channel, error: err.message })
    }
  })
}

// Convenience: subscribe to multiple channels with a handler map
function subscribeMany(handlerMap) {
  const sub = _getSubscriber()
  if (!sub) {
    logger.warn('factoryBridge.subscribeMany: no Redis client — subscriptions skipped')
    return
  }
  const channels = Object.keys(handlerMap)
  for (const channel of channels) {
    sub.subscribe(channel, (err) => {
      if (err) logger.warn('factoryBridge subscribe failed', { channel, error: err.message })
      else logger.info(`factoryBridge subscribed to ${channel}`)
    })
  }
  sub.on('message', (ch, message) => {
    const handler = handlerMap[ch]
    if (!handler) return
    try {
      handler(JSON.parse(message))
    } catch (err) {
      logger.warn('factoryBridge message parse error', { channel: ch, error: err.message })
    }
  })
}

// ─── Runner Health Check ────────────────────────────────────────────
// factoryRunner writes a heartbeat key to Redis every 30s.
// This checks if the runner is alive.

const RUNNER_HEARTBEAT_KEY = 'factory:runner:heartbeat'
const RUNNER_HEARTBEAT_TTL = 90 // seconds — stale after 90s (3 missed beats)

async function setRunnerHeartbeat() {
  const redis = getRedisClient()
  if (!redis) return
  await redis.set(RUNNER_HEARTBEAT_KEY, Date.now().toString(), 'EX', RUNNER_HEARTBEAT_TTL)
}

async function getRunnerHealth() {
  const redis = getRedisClient()
  if (!redis) return { alive: false, reason: 'no_redis' }
  const ts = await redis.get(RUNNER_HEARTBEAT_KEY)
  if (!ts) return { alive: false, reason: 'no_heartbeat' }
  const age = Date.now() - parseInt(ts, 10)
  return { alive: age < RUNNER_HEARTBEAT_TTL * 1000, lastHeartbeat: parseInt(ts, 10), ageMs: age }
}

// ─── Active session count (factory writes, api reads) ───────────────

const RUNNER_ACTIVE_KEY = 'factory:runner:active_sessions'

async function setActiveSessionCount(count) {
  const redis = getRedisClient()
  if (!redis) return
  await redis.set(RUNNER_ACTIVE_KEY, String(count), 'EX', RUNNER_HEARTBEAT_TTL)
}

async function getActiveSessionCount() {
  const redis = getRedisClient()
  if (!redis) return 0
  const val = await redis.get(RUNNER_ACTIVE_KEY)
  return parseInt(val || '0', 10)
}

// ─── Rate limit status (factory writes, api reads) ──────────────────

const RUNNER_RATELIMIT_KEY = 'factory:runner:rate_limit'

async function setRateLimitStatus(status) {
  const redis = getRedisClient()
  if (!redis) return
  if (status.limited) {
    const ttl = Math.max(1, Math.ceil((new Date(status.resetsAt) - Date.now()) / 1000))
    await redis.set(RUNNER_RATELIMIT_KEY, JSON.stringify(status), 'EX', ttl)
  } else {
    await redis.del(RUNNER_RATELIMIT_KEY)
  }
}

async function getRateLimitStatus() {
  const redis = getRedisClient()
  if (!redis) return { limited: false }
  const val = await redis.get(RUNNER_RATELIMIT_KEY)
  if (!val) return { limited: false }
  try {
    const parsed = JSON.parse(val)
    // Check if still valid
    if (parsed.resetsAt && new Date(parsed.resetsAt) < new Date()) return { limited: false }
    return parsed
  } catch {
    return { limited: false }
  }
}

// ─── Cleanup ────────────────────────────────────────────────────────

async function shutdown() {
  if (_subscriber) {
    try { _subscriber.disconnect() } catch {}
    _subscriber = null
  }
}

module.exports = {
  CHANNELS,
  publish,
  publishSessionRequest,
  publishSendMessage,
  publishStopSession,
  publishResumeSession,
  publishSessionComplete,
  publishSessionStatus,
  publishWsBroadcast,
  subscribe,
  subscribeMany,
  setRunnerHeartbeat,
  getRunnerHealth,
  setActiveSessionCount,
  getActiveSessionCount,
  setRateLimitStatus,
  getRateLimitStatus,
  shutdown,
}
