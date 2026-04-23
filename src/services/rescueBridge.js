/**
 * Rescue Bridge — Redis pub/sub between ecodia-api and ecodia-rescue.
 *
 * Pattern mirrors factoryBridge.js:
 *   ecodia-api publishes messages to rescue (rescue:message:send)
 *   ecodia-rescue publishes events back (rescue:output, rescue:status,
 *     rescue:ready, rescue:exit). ecodia-api subscribes and relays over WS
 *     to the frontend.
 *
 * Why a separate process (not in-process):
 *   The whole point of rescue is it keeps working when main is wedged. If
 *   rescue lived inside ecodia-api it would die with it. Dedicated PM2
 *   process, dedicated event loop, only coupled via Redis.
 */
const logger = require('../config/logger')
const { getRedisClient } = require('../config/redis')

const CHANNELS = {
  MESSAGE_SEND:  'rescue:message:send',   // api → rescue: new user message
  MESSAGE_ABORT: 'rescue:message:abort',  // api → rescue: abort current turn
  OUTPUT:        'rescue:output',         // rescue → api: streaming output
  STATUS:        'rescue:status',         // rescue → api: status change
  READY:         'rescue:ready',          // rescue → api: process booted
  EXIT:          'rescue:exit',           // rescue → api: session ended
  HEALTH_PING:   'rescue:health:ping',    // api → rescue: is alive?
  HEALTH_PONG:   'rescue:health:pong',    // rescue → api: alive
}

function publish(channel, data) {
  const redis = getRedisClient()
  if (!redis) {
    logger.warn('rescueBridge.publish: no Redis client — message dropped', { channel })
    return false
  }
  redis.publish(channel, JSON.stringify(data))
  return true
}

// ─── API-side: publish messages to rescue, subscribe to events ───────

function publishMessage(content) {
  return publish(CHANNELS.MESSAGE_SEND, { content, ts: Date.now() })
}

function publishAbort(reason) {
  return publish(CHANNELS.MESSAGE_ABORT, { reason, ts: Date.now() })
}

function publishHealthPing() {
  return publish(CHANNELS.HEALTH_PING, { ts: Date.now() })
}

// Subscribes the api process to rescue events. Callbacks receive parsed data.
// Returns an unsubscribe function.
async function subscribeToRescueEvents(handlers) {
  const redis = getRedisClient()
  if (!redis) {
    logger.warn('rescueBridge.subscribeToRescueEvents: no Redis client')
    return () => {}
  }

  const sub = redis.duplicate()
  await sub.connect()

  const channels = [CHANNELS.OUTPUT, CHANNELS.STATUS, CHANNELS.READY, CHANNELS.EXIT, CHANNELS.HEALTH_PONG]
  for (const channel of channels) {
    await sub.subscribe(channel, (raw) => {
      try {
        const data = JSON.parse(raw)
        const handler = handlers[channel]
        if (typeof handler === 'function') handler(data)
      } catch (err) {
        logger.warn('rescueBridge: subscribe handler threw', { channel, error: err.message })
      }
    })
  }

  return async () => {
    try { await sub.unsubscribe() } catch {}
    try { await sub.quit() } catch {}
  }
}

// ─── Rescue-side: publish events, subscribe to incoming messages ─────

function publishOutput(payload) {
  return publish(CHANNELS.OUTPUT, payload)
}

function publishStatus(status, extra = {}) {
  return publish(CHANNELS.STATUS, { status, ...extra, ts: Date.now() })
}

function publishReady() {
  return publish(CHANNELS.READY, { ts: Date.now() })
}

function publishExit(reason) {
  return publish(CHANNELS.EXIT, { reason, ts: Date.now() })
}

function publishHealthPong() {
  return publish(CHANNELS.HEALTH_PONG, { ts: Date.now() })
}

async function subscribeToApiEvents(handlers) {
  const redis = getRedisClient()
  if (!redis) {
    logger.warn('rescueBridge.subscribeToApiEvents: no Redis client')
    return () => {}
  }

  const sub = redis.duplicate()
  await sub.connect()

  const channels = [CHANNELS.MESSAGE_SEND, CHANNELS.MESSAGE_ABORT, CHANNELS.HEALTH_PING]
  for (const channel of channels) {
    await sub.subscribe(channel, (raw) => {
      try {
        const data = JSON.parse(raw)
        const handler = handlers[channel]
        if (typeof handler === 'function') handler(data)
      } catch (err) {
        logger.warn('rescueBridge: subscribe handler threw', { channel, error: err.message })
      }
    })
  }

  return async () => {
    try { await sub.unsubscribe() } catch {}
    try { await sub.quit() } catch {}
  }
}

module.exports = {
  CHANNELS,
  // api-side
  publishMessage, publishAbort, publishHealthPing, subscribeToRescueEvents,
  // rescue-side
  publishOutput, publishStatus, publishReady, publishExit, publishHealthPong, subscribeToApiEvents,
}
