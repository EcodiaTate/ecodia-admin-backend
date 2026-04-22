/**
 * WebSocket manager for the EcodiaOS frontend.
 *
 * Event envelope shape (ALL broadcast messages, Pinnacle P1):
 *   { seq: <int>, ts: <iso_string>, type: <string>, ...payload_fields }
 *
 * seq: monotonic integer per OS session, assigned at emission time.
 *   Resets to 0 when a new OS session begins (call resetSessionSeq()).
 *   Frontend uses this to detect gaps and request replay via
 *   GET /api/os-session/recover?since_seq=N.
 * ts:  ISO 8601 timestamp at emission time.
 *
 * Text delta coalescing: consecutive text_delta events within a 20ms
 * window are merged into a single WS packet. All other event types flush
 * pending coalesced deltas first to preserve ordering. Call
 * flushDeltasForTurnComplete() before emitting turn_complete so no deltas
 * are stranded in the buffer when the turn ends.
 *
 * Event ring buffer: last 100 events are kept in memory for reconnect
 * recovery via GET /api/os-session/recover?since_seq=N.
 */
const expressWs = require('express-ws')
const jwt = require('jsonwebtoken')
const crypto = require('crypto')
const logger = require('../config/logger')
const env = require('../config/env')

// In-memory ticket store - tickets are single-use and expire after 90s.
// Bumped from 30s because African wifi reconnects can take 10-20s and were
// causing false logouts (frontend had to re-auth when ticket expired mid-
// handshake). 90s is still short enough that stolen tickets are low-risk.
const WS_TICKET_TTL_MS = 90_000
const wsTickets = new Map()

// All active WS connections
const clients = new Set()

function initWS(app, server) {
  expressWs(app, server)

  app.ws('/ws', (ws, req) => {
    const ticket = req.query.ticket
    if (!ticket || !wsTickets.has(ticket)) {
      ws.close(4001, 'Invalid or expired ticket')
      return
    }

    const { userId, createdAt } = wsTickets.get(ticket)
    wsTickets.delete(ticket) // single-use

    if (Date.now() - createdAt > WS_TICKET_TTL_MS) {
      ws.close(4001, 'Ticket expired')
      return
    }

    clients.add(ws)
    ws._isAlive = true
    logger.info('WS client connected', { userId })

    ws.on('pong', () => { ws._isAlive = true })

    ws.on('close', () => {
      clients.delete(ws)
      logger.info('WS client disconnected', { userId })
    })

    ws.on('error', (err) => {
      logger.error('WS error', { error: err.message })
      clients.delete(ws)
    })
  })

  // Ping every 10s - detects dead connections faster (Pinnacle P1).
  // Proxies idle-close at 60s+; 10s catches dead sockets in ~20s.
  // Without this, the server keeps broadcasting to dead sockets and the
  // client never knows it disconnected (no close event fires).
  setInterval(() => {
    for (const ws of clients) {
      if (!ws._isAlive) {
        logger.debug('WS client unresponsive - terminating')
        clients.delete(ws)
        ws.terminate()
        continue
      }
      ws._isAlive = false
      ws.ping()
    }
  }, 10_000)
}

function createTicket(userId) {
  const ticket = crypto.randomBytes(32).toString('hex')
  wsTickets.set(ticket, { userId, createdAt: Date.now() })
  // Cleanup after TTL regardless (single-use means this is just janitorial)
  setTimeout(() => wsTickets.delete(ticket), WS_TICKET_TTL_MS)
  return ticket
}

function _sendRaw(message) {
  for (const ws of clients) {
    if (ws.readyState === 1) {
      ws.send(message)
    }
  }
}

// ─── Seq counter + epoch (per OS session) ─────────────────────────────────
// Monotonic integer stamped on every emitted WS message. Resets to 0 when a
// new OS session begins OR when the Node process restarts. Pair it with a
// UUID epoch so the frontend can distinguish "new session, seq=0" from
// "same session, process restarted mid-turn" — both look like seq going down
// but only one warrants silent re-sync. (crypto already required at top.)
let _sessionSeq = 0
let _sessionEpoch = crypto.randomUUID()

function resetSessionSeq() {
  _sessionSeq = 0
  _sessionEpoch = crypto.randomUUID()
}

function getSessionEpoch() {
  return _sessionEpoch
}

// ─── Event ring buffer (last 500 events for reconnect recovery) ───────────
// Populated by every broadcast call. Supports GET /api/os-session/recover?since_seq=N.
// Bumped from 100 to 500 — a tool-heavy turn can emit 40-60 events, so 100
// aged out mid-conversation if a tab was backgrounded for more than a turn.
const RING_BUFFER_SIZE = 500
const _eventRing = []

function _addToRing(envelope) {
  _eventRing.push(envelope)
  if (_eventRing.length > RING_BUFFER_SIZE) _eventRing.shift()
}

function getEventsSince(sinceSeq) {
  if (sinceSeq == null || !Number.isFinite(Number(sinceSeq))) return [..._eventRing]
  const since = Number(sinceSeq)
  return _eventRing.filter(e => e.seq > since)
}

// ─── Text-delta coalescer (10ms window) ─────────────────────────────────────
// Every text_delta from the SDK used to go out as its own WS packet. At 100+
// deltas per response over a high-latency network (mobile / Africa), each
// packet is a separate RTT - streams felt stuttery and tripled the packet
// count for no benefit.
//
// Coalescer: within a 10ms window, concatenate deltas for the same session.
// Flush on window expiry OR when any non-delta event arrives (to preserve
// ordering - tool_use, status, complete must flush pending text first).
// Terminal events (turn_complete, os-session:complete) also flush via the
// TERMINAL_EVENT_TYPES list below — no explicit flush call needed.
const COALESCE_WINDOW_MS = 10
let _pendingDeltas = null   // { extra, extraKey, parts: [] }
let _coalesceTimer = null

// Event types that must force-flush pending deltas before emission so
// terminal turn events never leave text stranded in the coalescer buffer.
const TERMINAL_EVENT_TYPES = new Set([
  'os-session:complete',
])

// Output-inner-types that are terminal (carried inside os-session:output
// envelopes). A turn_complete with buffered deltas would otherwise arrive
// before the final text.
const TERMINAL_OUTPUT_INNER_TYPES = new Set([
  'turn_complete',
])

function _flushDeltas() {
  if (_coalesceTimer) { clearTimeout(_coalesceTimer); _coalesceTimer = null }
  if (!_pendingDeltas || _pendingDeltas.parts.length === 0) { _pendingDeltas = null; return }
  const { extra, parts } = _pendingDeltas
  _pendingDeltas = null
  const combined = parts.join('')
  const seq = ++_sessionSeq
  const ts = new Date().toISOString()
  const envelope = {
    seq,
    ts,
    epoch: _sessionEpoch,
    type: 'os-session:output',
    ...extra,
    data: { type: 'text_delta', content: combined },
  }
  _addToRing(envelope)
  _sendRaw(JSON.stringify(envelope))
}

// Force-flush the coalescer before turn_complete - retained for backwards
// compat with callers that still invoke this explicitly. The broadcast()
// function now force-flushes on terminal events automatically, so this is
// effectively a no-op in current callers but remains safe to call.
function flushDeltasForTurnComplete() {
  _flushDeltas()
}

function _isCoalescibleDelta(type, payload) {
  return type === 'os-session:output' &&
         payload?.data?.type === 'text_delta' &&
         typeof payload.data.content === 'string'
}

function _isTerminalEvent(type, payload) {
  if (TERMINAL_EVENT_TYPES.has(type)) return true
  if (type === 'os-session:output' && payload?.data?.type &&
      TERMINAL_OUTPUT_INNER_TYPES.has(payload.data.type)) return true
  return false
}

function broadcast(type, payload) {
  // Only text_delta output gets coalesced. All other events flush pending
  // deltas first so ordering across event types is preserved.
  if (_isCoalescibleDelta(type, payload)) {
    // Capture non-data fields (sessionId, etc.) so we can reattach on flush.
    const { data, ...extra } = payload
    // Cache a stringified key of `extra` so we're not re-JSON-stringifying
    // on every delta (these fire hundreds of times per turn).
    const extraKey = JSON.stringify(extra)
    if (_pendingDeltas && _pendingDeltas.extraKey !== extraKey) _flushDeltas()
    if (!_pendingDeltas) _pendingDeltas = { extra, extraKey, parts: [] }
    _pendingDeltas.parts.push(data.content)
    if (!_coalesceTimer) {
      _coalesceTimer = setTimeout(_flushDeltas, COALESCE_WINDOW_MS)
    }
    return
  }

  // Non-delta event - flush any pending deltas first to keep ordering sane.
  // Terminal events additionally guarantee no text is stranded mid-turn.
  if (_pendingDeltas) _flushDeltas()

  const seq = ++_sessionSeq
  const ts = new Date().toISOString()
  const envelope = { seq, ts, epoch: _sessionEpoch, type, ...payload }
  _addToRing(envelope)
  _sendRaw(JSON.stringify(envelope))

  // If this was a terminal event, assert-flush afterwards too — catches the
  // edge case where a late delta lands in the same tick but after us.
  if (_isTerminalEvent(type, payload) && _pendingDeltas) _flushDeltas()
}

function broadcastToSession(sessionId, type, data) {
  broadcast(type, { sessionId, data })
}

module.exports = {
  initWS,
  createTicket,
  broadcast,
  broadcastToSession,
  flushDeltasForTurnComplete,
  resetSessionSeq,
  getSessionEpoch,
  getEventsSince,
}
