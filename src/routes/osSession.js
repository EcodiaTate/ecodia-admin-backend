/**
 * OS Session Routes — /api/os-session/*
 * Interface between frontend and the persistent CC OS session.
 */
const express = require('express')
const router = express.Router()
const osSession = require('../services/osSessionService')

// Send a message to the OS session (response streams via WebSocket)
router.post('/message', async (req, res, next) => {
  res.setTimeout(300_000) // 5 min
  try {
    const { message } = req.body
    if (!message || typeof message !== 'string') {
      return res.status(400).json({ error: 'message is required' })
    }
    // Fire and forget — response streams via WebSocket
    // But we wait for completion so the HTTP response indicates success
    const result = await osSession.sendMessage(message)
    res.json(result)
  } catch (err) {
    console.error('[OS Session /message] Error:', err.message)
    next(err)
  }
})

// Get current session status
router.get('/status', async (_req, res, next) => {
  try {
    const status = await osSession.getStatus()
    res.json(status)
  } catch (err) { next(err) }
})

// Restart the OS session (fresh conversation)
router.post('/restart', async (_req, res, next) => {
  try {
    const result = await osSession.restart()
    res.json(result)
  } catch (err) { next(err) }
})

// Get session history (recent logs)
router.get('/history', async (req, res, next) => {
  try {
    const limit = parseInt(req.query.limit || '100', 10)
    const history = await osSession.getHistory(limit)
    res.json({ history })
  } catch (err) { next(err) }
})

// Get current token usage
router.get('/tokens', (_req, res) => {
  const usage = osSession.getTokenUsage()
  res.json(usage)
})

// Compact — seamlessly transition to a new session with summary context
router.post('/compact', async (req, res, next) => {
  res.setTimeout(300_000)
  try {
    const { summary } = req.body
    if (!summary || typeof summary !== 'string') {
      return res.status(400).json({ error: 'summary is required' })
    }
    const result = await osSession.compact(summary)
    res.json(result)
  } catch (err) {
    console.error('[OS Session /compact] Error:', err.message)
    next(err)
  }
})

module.exports = router
