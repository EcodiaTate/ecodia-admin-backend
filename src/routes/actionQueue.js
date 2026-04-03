const express = require('express')
const router = express.Router()
const auth = require('../middleware/auth')
const actionQueue = require('../services/actionQueueService')

router.use(auth)

// GET /api/actions/ — pending actions (for dashboard)
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

// GET /api/actions/stats — queue stats + decision intelligence
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

// ─── Decision Intelligence Endpoints ──────────────────────────────────

// GET /api/actions/decisions — decision history with filtering
router.get('/decisions', async (req, res, next) => {
  try {
    const { limit, source, actionType, decision } = req.query
    const decisions = await actionQueue.getDecisionHistory({
      limit: parseInt(limit) || 30,
      source: source || undefined,
      actionType: actionType || undefined,
      decision: decision || undefined,
    })
    res.json(decisions)
  } catch (err) { next(err) }
})

// GET /api/actions/decisions/stats — aggregate decision patterns
router.get('/decisions/stats', async (_req, res, next) => {
  try {
    const stats = await actionQueue.getDecisionStats()
    res.json(stats)
  } catch (err) { next(err) }
})

// GET /api/actions/sender/:email/reputation — sender decision profile
router.get('/sender/:email/reputation', async (req, res, next) => {
  try {
    const reputation = await actionQueue.getSenderReputation(req.params.email, null)
    if (!reputation) return res.json({ known: false })
    res.json({ known: true, ...reputation })
  } catch (err) { next(err) }
})

// GET /api/actions/suppress-check — check if an item would be suppressed
// Used by triage services to pre-check before enqueuing
router.get('/suppress-check', async (req, res, next) => {
  try {
    const { source, actionType, senderEmail, senderName, priority } = req.query
    if (!source || !actionType) return res.status(400).json({ error: 'source and actionType required' })
    const result = await actionQueue.evaluateSuppression({
      source, actionType, senderEmail, senderName, priority: priority || 'medium',
    })
    res.json(result)
  } catch (err) { next(err) }
})

// POST /api/actions/:id/execute — approve and execute
router.post('/:id/execute', async (req, res, next) => {
  try {
    const result = await actionQueue.execute(req.params.id)
    res.json(result)
  } catch (err) { next(err) }
})

// POST /api/actions/:id/dismiss — dismiss with structured reason
router.post('/:id/dismiss', async (req, res, next) => {
  try {
    const { reason, reasonCategory, reasonDetail } = req.body || {}
    await actionQueue.dismiss(req.params.id, { reason, reasonCategory, reasonDetail })
    res.json({ ok: true })
  } catch (err) { next(err) }
})

// POST /api/actions/batch/execute — execute multiple (resource-aware)
router.post('/batch/execute', async (req, res, next) => {
  try {
    const { ids } = req.body
    if (!Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({ error: 'ids array is required' })
    }
    if (ids.length > 20) {
      return res.status(400).json({ error: 'Maximum 20 actions per batch' })
    }
    const result = await actionQueue.batchExecute(ids)
    res.json({ succeeded: result.succeeded, failed: result.failed })
  } catch (err) { next(err) }
})

// POST /api/actions/batch/dismiss — dismiss multiple with structured reason
router.post('/batch/dismiss', async (req, res, next) => {
  try {
    const { ids, reason, reasonCategory, reasonDetail } = req.body
    if (!Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({ error: 'ids array is required' })
    }
    const dismissed = await actionQueue.batchDismiss(ids, { reason, reasonCategory, reasonDetail })
    res.json({ ok: true, dismissed })
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
