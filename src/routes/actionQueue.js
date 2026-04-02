const express = require('express')
const router = express.Router()
const auth = require('../middleware/auth')
const actionQueue = require('../services/actionQueueService')

router.use(auth)

// GET /api/actions/ — pending actions (for dashboard)
router.get('/', async (req, res, next) => {
  try {
    const { limit } = req.query
    const actions = await actionQueue.getPending({ limit: parseInt(limit) || 20 })
    res.json(actions)
  } catch (err) { next(err) }
})

// GET /api/actions/stats
router.get('/stats', async (_req, res, next) => {
  try {
    const stats = await actionQueue.getStats()
    res.json(stats)
  } catch (err) { next(err) }
})

// GET /api/actions/recent — recently handled
router.get('/recent', async (req, res, next) => {
  try {
    const { limit } = req.query
    const actions = await actionQueue.getRecent({ limit: parseInt(limit) || 10 })
    res.json(actions)
  } catch (err) { next(err) }
})

// POST /api/actions/:id/execute — approve and execute
router.post('/:id/execute', async (req, res, next) => {
  try {
    const result = await actionQueue.execute(req.params.id)
    res.json(result)
  } catch (err) { next(err) }
})

// POST /api/actions/:id/dismiss — dismiss without executing
router.post('/:id/dismiss', async (req, res, next) => {
  try {
    await actionQueue.dismiss(req.params.id)
    res.json({ ok: true })
  } catch (err) { next(err) }
})

module.exports = router
