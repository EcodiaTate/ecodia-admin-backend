/**
 * Rescue Service (api-side) — lives in ecodia-api. Subscribes to
 * ecodia-rescue events via Redis, relays them to the frontend over WS,
 * and exposes a simple state surface for /api/rescue routes.
 */
const logger = require('../config/logger')
const bridge = require('./rescueBridge')

// In-memory state, keyed by the single rescue conversation in-flight.
// Rescue is single-session (no multi-user) — this is all the state we need.
const state = {
  ready: false,
  lastReadyAt: null,
  status: 'unknown',   // 'idle' | 'streaming' | 'error' | 'unknown'
  lastStatusAt: null,
  transcript: [],      // array of {role, content, ts} — mirrors what WS pushed
  lastActivityAt: null,
  lastHealthPongAt: null,
}

const MAX_TRANSCRIPT_ENTRIES = 500

function _appendTranscript(entry) {
  state.transcript.push({ ...entry, ts: Date.now() })
  if (state.transcript.length > MAX_TRANSCRIPT_ENTRIES) {
    state.transcript.shift()
  }
  state.lastActivityAt = Date.now()
}

async function start() {
  await bridge.subscribeToRescueEvents({
    [bridge.CHANNELS.READY]: () => {
      state.ready = true
      state.lastReadyAt = Date.now()
      state.status = 'idle'
      logger.info('rescueService: rescue process ready')
      _broadcastWS('rescue:ready', { ts: state.lastReadyAt })
    },
    [bridge.CHANNELS.STATUS]: (data) => {
      state.status = data.status || 'unknown'
      state.lastStatusAt = Date.now()
      _broadcastWS('rescue:status', data)
    },
    [bridge.CHANNELS.OUTPUT]: (data) => {
      // Accumulate text deltas into the transcript's last assistant entry.
      if (data.type === 'text_delta') {
        const last = state.transcript[state.transcript.length - 1]
        if (last && last.role === 'assistant' && last.inProgress) {
          last.content += data.content || ''
        } else {
          state.transcript.push({
            role: 'assistant', content: data.content || '', ts: Date.now(), inProgress: true,
          })
        }
        state.lastActivityAt = Date.now()
      } else if (data.type === 'turn_complete') {
        const last = state.transcript[state.transcript.length - 1]
        if (last && last.role === 'assistant') last.inProgress = false
      } else if (data.type === 'tool_use_starting' || data.type === 'tool_use_input_complete' || data.type === 'tool_result' || data.type === 'thinking_delta' || data.type === 'error') {
        _appendTranscript({ role: 'system', kind: data.type, content: data })
      }

      _broadcastWS('rescue:output', data)
    },
    [bridge.CHANNELS.EXIT]: (data) => {
      state.ready = false
      state.status = 'idle'
      logger.warn('rescueService: rescue process exited', { reason: data.reason })
      _broadcastWS('rescue:exit', data)
    },
    [bridge.CHANNELS.HEALTH_PONG]: (data) => {
      state.lastHealthPongAt = data.ts || Date.now()
    },
  })

  logger.info('rescueService: subscribed to rescue events')
}

function _broadcastWS(type, payload) {
  try {
    const { broadcast } = require('../websocket/wsManager')
    broadcast(type, payload || {})
  } catch (err) {
    logger.debug('rescueService: WS broadcast failed (non-fatal)', { error: err.message })
  }
}

// ─── Public actions called from routes ───────────────────────────────

async function sendMessage(content) {
  if (!content || typeof content !== 'string') {
    throw new Error('content required')
  }
  _appendTranscript({ role: 'user', content })
  bridge.publishMessage(content)
  return { queued: true, ts: Date.now() }
}

async function abort(reason = 'user_abort') {
  bridge.publishAbort(reason)
  return { aborted: true, reason }
}

async function healthCheck() {
  const before = state.lastHealthPongAt
  bridge.publishHealthPing()
  // Wait up to 3s for the pong
  const deadline = Date.now() + 3000
  while (Date.now() < deadline) {
    if ((state.lastHealthPongAt || 0) > (before || 0)) return { alive: true, latencyMs: Date.now() - (before || 0) }
    await new Promise(r => setTimeout(r, 100))
  }
  return { alive: false }
}

function getStatus() {
  return {
    ready: state.ready,
    status: state.status,
    lastReadyAt: state.lastReadyAt,
    lastStatusAt: state.lastStatusAt,
    lastActivityAt: state.lastActivityAt,
    transcriptLength: state.transcript.length,
  }
}

function getTranscript(limit = 100) {
  const n = Math.max(1, Math.min(MAX_TRANSCRIPT_ENTRIES, limit))
  return state.transcript.slice(-n)
}

module.exports = { start, sendMessage, abort, healthCheck, getStatus, getTranscript }
