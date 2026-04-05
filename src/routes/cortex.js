const { Router } = require('express')
const auth = require('../middleware/auth')
const cortexService = require('../services/contextAwareCortexService')
const logger = require('../config/logger')

const router = Router()
router.use(auth)

// POST /api/cortex/chat — multi-turn conversational chat
// If sessionId is provided, history is loaded from DB and merged.
router.post('/chat', async (req, res, next) => {
  try {
    const { messages, sessionId, ambientEvents } = req.body

    if (!messages || !Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ error: 'messages array is required' })
    }

    // Validate message format
    for (const msg of messages) {
      if (!msg.role || !msg.content) {
        return res.status(400).json({ error: 'Each message must have role and content' })
      }
      if (!['user', 'assistant'].includes(msg.role)) {
        return res.status(400).json({ error: 'Message role must be "user" or "assistant"' })
      }
    }

    const result = await cortexService.chat(messages, { sessionId, ambientEvents })

    // persistExchange is already called inside cortexService.chat() — don't double-write
    res.json(result)
  } catch (err) {
    logger.error('Cortex chat failed', { error: err.message })
    next(err)
  }
})

// GET /api/cortex/briefing — proactive load briefing
router.get('/briefing', async (req, res, next) => {
  try {
    const result = await cortexService.getLoadBriefing()
    res.json(result)
  } catch (err) {
    logger.error('Cortex briefing failed', { error: err.message })
    next(err)
  }
})

// POST /api/cortex/do — multi-turn chat with auto-execution
// Cortex proposes actions → they auto-execute �� results fed back → Cortex continues.
// Lean mode auto-detected from content. Pass lean: true to force.
router.post('/do', async (req, res, next) => {
  try {
    const { messages, sessionId, ambientEvents, lean, maxRounds } = req.body

    if (!messages || !Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ error: 'messages array is required' })
    }

    for (const msg of messages) {
      if (!msg.role || !msg.content) {
        return res.status(400).json({ error: 'Each message must have role and content' })
      }
    }

    const result = await cortexService.chatAndExecute(messages, {
      sessionId, ambientEvents, lean, maxRounds: maxRounds || 5,
    })
    res.json(result)
  } catch (err) {
    logger.error('Cortex do failed', { error: err.message })
    next(err)
  }
})

// POST /api/cortex/action — execute an approved action
router.post('/action', async (req, res, next) => {
  try {
    const { action, params } = req.body

    if (!action) {
      return res.status(400).json({ error: 'action is required' })
    }

    const result = await cortexService.executeAction(action, params || {})
    res.json(result)
  } catch (err) {
    logger.error('Cortex action failed', { error: err.message, action: req.body?.action })
    next(err)
  }
})

module.exports = router
