const express = require('express')
const logger = require('../config/logger')
const handsBridge = require('../services/handsBridge')

// ═══════════════════════════════════════════════════════════════════════
// /api/hands — inbound callback surface for the laptop-hands service.
//
// Hands posts here every time it has progress / partial output / final
// result / a question for the user. We verify HMAC, then hand off to
// handsBridge.handleHandsEvent which republishes to the WS broadcast
// channel so the admin chat picks it up.
// ═══════════════════════════════════════════════════════════════════════

const router = express.Router()

// We need the raw body for HMAC verification — capture it ourselves
// instead of relying on express.json which already parsed it.
const rawJson = express.raw({ type: 'application/json', limit: '5mb' })

router.post('/events', rawJson, (req, res) => {
  const ts = req.header('x-hands-timestamp')
  const sig = req.header('x-hands-auth')
  const raw = req.body instanceof Buffer ? req.body.toString('utf8') : ''

  if (!handsBridge.verifyInbound(raw, ts, sig)) {
    logger.warn('hands /events: HMAC failed', { ip: req.ip })
    return res.status(401).json({ error: 'auth' })
  }

  let event
  try {
    event = JSON.parse(raw)
  } catch {
    return res.status(400).json({ error: 'bad json' })
  }

  if (!event || typeof event.sessionId !== 'string' || typeof event.kind !== 'string') {
    return res.status(400).json({ error: 'missing required fields' })
  }

  try {
    handsBridge.handleHandsEvent(event)
  } catch (err) {
    logger.error('hands /events: handler crashed', { error: err.message })
    return res.status(500).json({ error: 'handler' })
  }

  res.json({ ok: true })
})

router.get('/health', async (_req, res) => {
  const r = await handsBridge.ping()
  res.json(r)
})

module.exports = router
