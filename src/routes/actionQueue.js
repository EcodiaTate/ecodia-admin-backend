const express = require('express')
const router = express.Router()
const auth = require('../middleware/auth')
const actionQueue = require('../services/actionQueueService')

router.use(auth)

// GET /api/actions/ — pending actions (for dashboard)
// Supports: ?limit, ?priority, ?source, ?expires (only return non-expired)
router.get('/', async (req, res, next) => {
  try {
    const { limit, priority, source } = req.query
    const actions = await actionQueue.getPending({
      limit: parseInt(limit) || 20,
      priority: priority || undefined,
      source: source || undefined,
    })
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

// POST /api/actions/batch/execute — execute multiple actions
router.post('/batch/execute', async (req, res, next) => {
  try {
    const { ids } = req.body
    if (!Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({ error: 'ids array is required' })
    }
    if (ids.length > 20) {
      return res.status(400).json({ error: 'Maximum 20 actions per batch' })
    }
    const results = await Promise.allSettled(ids.map(id => actionQueue.execute(id)))
    const succeeded = results.filter(r => r.status === 'fulfilled').length
    const failed = results.filter(r => r.status === 'rejected').length
    res.json({ succeeded, failed })
  } catch (err) { next(err) }
})

// POST /api/actions/batch/dismiss — dismiss multiple actions
router.post('/batch/dismiss', async (req, res, next) => {
  try {
    const { ids } = req.body
    if (!Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({ error: 'ids array is required' })
    }
    await Promise.allSettled(ids.map(id => actionQueue.dismiss(id)))
    res.json({ ok: true, dismissed: ids.length })
  } catch (err) { next(err) }
})

// POST /api/actions/expire — manually purge expired items
router.post('/expire', async (_req, res, next) => {
  try {
    const count = await actionQueue.purgeExpired()
    res.json({ purged: count })
  } catch (err) { next(err) }
})

module.exports = router
