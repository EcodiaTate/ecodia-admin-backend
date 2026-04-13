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

function broadcast(type, payload) {
  const message = JSON.stringify({ type, ...payload })
  for (const ws of clients) {
    if (ws.readyState === 1) {
      ws.send(message)
    }
  }
}

function broadcastToSession(sessionId, type, data) {
  broadcast(type, { sessionId, data })
}

module.exports = { initWS, createTicket, broadcast, broadcastToSession }
