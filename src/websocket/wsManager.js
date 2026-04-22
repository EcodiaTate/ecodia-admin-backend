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

// ─── Seq counter (per OS session) ───────────────────────────────────────────
// Monotonic integer stamped on every emitted WS message. Resets to 0 when a
// new OS session begins. The frontend uses seq to detect out-of-order or
// missed events and can request replay via the recover endpoint.
let _sessionSeq = 0

function resetSessionSeq() {
  _sessionSeq = 0
}

// ─── Event ring buffer (last 100 events for reconnect recovery) ─────────────
// Populated by every broadcast call. Supports GET /api/os-session/recover?since_seq=N.
const RING_BUFFER_SIZE = 100
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

// ─── Text-delta coalescer (20ms window) ─────────────────────────────────────
// Every text_delta from the SDK used to go out as its own WS packet. At 100+
// deltas per response over a high-latency network (mobile / Africa), each
// packet is a separate RTT - streams felt stuttery and tripled the packet
// count for no benefit.
//
// Coalescer: within a 20ms window, concatenate deltas for the same session.
// Flush on window expiry OR when any non-delta event arrives (to preserve
// ordering - tool_use, status, complete must flush pending text first).
// Call flushDeltasForTurnComplete() explicitly before emitting turn_complete
// to ensure no deltas are stranded when the turn ends.
const COALESCE_WINDOW_MS = 20
let _pendingDeltas = null   // { extra, parts: [] }
let _coalesceTimer = null

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
    type: 'os-session:output',
    ...extra,
    data: { type: 'text_delta', content: combined },
  }
  _addToRing(envelope)
  _sendRaw(JSON.stringify(envelope))
}

// Force-flush the coalescer before turn_complete - ensures no text deltas are
// stranded in the 20ms buffer when the turn ends. Called from osSessionService.
function flushDeltasForTurnComplete() {
  _flushDeltas()
}

function _isCoalescibleDelta(type, payload) {
  return type === 'os-session:output' &&
         payload?.data?.type === 'text_delta' &&
         typeof payload.data.content === 'string'
}

function broadcast(type, payload) {
  // Only text_delta output gets coalesced. All other events flush pending
  // deltas first so ordering across event types is preserved.
  if (_isCoalescibleDelta(type, payload)) {
    // Capture non-data fields (sessionId, etc.) so we can reattach on flush.
    const { data, ...extra } = payload
    // If extra fields change mid-stream (e.g. session change - shouldn't happen
    // in practice) flush what we have and start a new buffer.
    const prevExtra = _pendingDeltas?.extra
    const sameExtra = prevExtra && JSON.stringify(prevExtra) === JSON.stringify(extra)
    if (_pendingDeltas && !sameExtra) _flushDeltas()
    if (!_pendingDeltas) _pendingDeltas = { extra, parts: [] }
    _pendingDeltas.parts.push(data.content)
    if (!_coalesceTimer) {
      _coalesceTimer = setTimeout(_flushDeltas, COALESCE_WINDOW_MS)
    }
    return
  }

  // Non-delta event - flush any pending deltas first to keep ordering sane.
  if (_pendingDeltas) _flushDeltas()

  const seq = ++_sessionSeq
  const ts = new Date().toISOString()
  const envelope = { seq, ts, type, ...payload }
  _addToRing(envelope)
  _sendRaw(JSON.stringify(envelope))
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
  getEventsSince,
}
