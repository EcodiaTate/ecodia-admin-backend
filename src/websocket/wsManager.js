const expressWs = require('express-ws')
const jwt = require('jsonwebtoken')
const crypto = require('crypto')
const logger = require('../config/logger')
const env = require('../config/env')

// In-memory ticket store — tickets are single-use and expire after 30s
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

    if (Date.now() - createdAt > 30_000) {
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

  // Ping every 30s — detects dead connections (NAT timeout, proxy drop).
  // Without this, the server keeps broadcasting to dead sockets and the
  // client never knows it disconnected (no close event fires).
  setInterval(() => {
    for (const ws of clients) {
      if (!ws._isAlive) {
        logger.debug('WS client unresponsive — terminating')
        clients.delete(ws)
        ws.terminate()
        continue
      }
      ws._isAlive = false
      ws.ping()
    }
  }, 30_000)
}

function createTicket(userId) {
  const ticket = crypto.randomBytes(32).toString('hex')
  wsTickets.set(ticket, { userId, createdAt: Date.now() })
  // Cleanup after 30s regardless
  setTimeout(() => wsTickets.delete(ticket), 30_000)
  return ticket
}

function _sendRaw(message) {
  for (const ws of clients) {
    if (ws.readyState === 1) {
      ws.send(message)
    }
  }
}

// ─── Text-delta coalescer ────────────────────────────────────────────────
// Every text_delta from the SDK used to go out as its own WS packet. At 100+
// deltas per response over a high-latency network (mobile / Africa), each
// packet is a separate RTT — streams felt stuttery and tripled the packet
// count for no benefit.
//
// Coalescer: within a 50ms window, concatenate deltas for the same session.
// Flush on window expiry OR when any non-delta event arrives (to preserve
// ordering — tool_use, status, complete must flush pending text first).
const COALESCE_WINDOW_MS = 50
let _pendingDeltas = null   // { sessionId, parts: [], firstAt }
let _coalesceTimer = null

function _flushDeltas() {
  if (_coalesceTimer) { clearTimeout(_coalesceTimer); _coalesceTimer = null }
  if (!_pendingDeltas || _pendingDeltas.parts.length === 0) { _pendingDeltas = null; return }
  const { extra, parts } = _pendingDeltas
  _pendingDeltas = null
  const combined = parts.join('')
  _sendRaw(JSON.stringify({
    type: 'os-session:output',
    ...extra,
    data: { type: 'text_delta', content: combined },
  }))
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
    // If extra fields change mid-stream (e.g. session change — shouldn't happen
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

  // Non-delta event — flush any pending deltas first to keep ordering sane.
  if (_pendingDeltas) _flushDeltas()
  _sendRaw(JSON.stringify({ type, ...payload }))
}

function broadcastToSession(sessionId, type, data) {
  broadcast(type, { sessionId, data })
}

module.exports = { initWS, createTicket, broadcast, broadcastToSession }
