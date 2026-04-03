const { Router } = require('express')
const auth = require('../middleware/auth')
const cortexService = require('../services/cortexService')
const logger = require('../config/logger')

const router = Router()
router.use(auth)

// POST /api/cortex/chat — multi-turn conversational chat
// If sessionId is provided, history is loaded from DB and merged.
router.post('/chat', async (req, res, next) => {
  try {
    const { messages, sessionId } = req.body

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

    const result = await cortexService.chat(messages, { sessionId })

    // Persist the latest exchange to this session's history
    if (sessionId) {
      cortexService.persistExchange(sessionId, messages, result.blocks).catch((err) => {
        logger.debug('Cortex session persist failed', { error: err.message })
      })
    }

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
