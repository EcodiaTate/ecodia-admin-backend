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
 *
 * ioredis subscriber model:
 *   - A subscribed connection can't be used for commands → duplicate()
 *   - sub.subscribe(channel, ackCb) — ackCb receives subscription ack, not messages
 *   - sub.on('message', (channel, raw)) — actual dispatch
 *   - This is DIFFERENT from node-redis v4's `subscribe(channel, handler)` pattern
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
  redis.publish(channel, JSON.stringify(data)).catch(err => {
    logger.warn('rescueBridge.publish failed', { channel, error: err.message })
  })
  return true
}

// ─── Subscriber singleton (one connection per process, not per subscribe) ─

let _subscriber = null

function _getSubscriber() {
  if (_subscriber) return _subscriber
  const redis = getRedisClient()
  if (!redis) return null
  _subscriber = redis.duplicate()
  _subscriber.on('error', (err) => logger.debug('rescueBridge subscriber error', { error: err.message }))
  return _subscriber
}

// Subscribes to a map of { channel: handler } on the shared subscriber.
// Messages are dispatched by channel name. Returns a cleanup function.
function subscribeMany(handlerMap) {
  const sub = _getSubscriber()
  if (!sub) {
    logger.warn('rescueBridge.subscribeMany: no Redis client — subscriptions skipped')
    return () => {}
  }
  const channels = Object.keys(handlerMap)
  for (const channel of channels) {
    sub.subscribe(channel, (err) => {
      if (err) logger.warn('rescueBridge subscribe failed', { channel, error: err.message })
      else logger.info(`rescueBridge subscribed to ${channel}`)
    })
  }
  // Listener is additive — multiple subscribeMany calls layer handlers by channel,
  // so only one global 'message' listener is needed.
  if (!sub._rescueBridgeListenerAttached) {
    sub._rescueBridgeListenerAttached = true
    sub._rescueBridgeHandlers = {}
    sub.on('message', (ch, raw) => {
      const handler = sub._rescueBridgeHandlers[ch]
      if (!handler) return
      try {
        handler(JSON.parse(raw))
      } catch (err) {
        logger.warn('rescueBridge message parse error', { channel: ch, error: err.message })
      }
    })
  }
  // Register handlers for this call (channel → handler map stored on subscriber)
  for (const [channel, handler] of Object.entries(handlerMap)) {
    sub._rescueBridgeHandlers[channel] = handler
  }
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

function subscribeToRescueEvents(handlers) {
  subscribeMany({
    [CHANNELS.OUTPUT]:      handlers[CHANNELS.OUTPUT]      || (() => {}),
    [CHANNELS.STATUS]:      handlers[CHANNELS.STATUS]      || (() => {}),
    [CHANNELS.READY]:       handlers[CHANNELS.READY]       || (() => {}),
    [CHANNELS.EXIT]:        handlers[CHANNELS.EXIT]        || (() => {}),
    [CHANNELS.HEALTH_PONG]: handlers[CHANNELS.HEALTH_PONG] || (() => {}),
  })
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

function subscribeToApiEvents(handlers) {
  subscribeMany({
    [CHANNELS.MESSAGE_SEND]:  handlers[CHANNELS.MESSAGE_SEND]  || (() => {}),
    [CHANNELS.MESSAGE_ABORT]: handlers[CHANNELS.MESSAGE_ABORT] || (() => {}),
    [CHANNELS.HEALTH_PING]:   handlers[CHANNELS.HEALTH_PING]   || (() => {}),
  })
}

module.exports = {
  CHANNELS,
  // api-side
  publishMessage, publishAbort, publishHealthPing, subscribeToRescueEvents,
  // rescue-side
  publishOutput, publishStatus, publishReady, publishExit, publishHealthPong, subscribeToApiEvents,
}
