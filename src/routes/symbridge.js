const { Router } = require('express')
const auth = require('../middleware/auth')
const symbridge = require('../services/symbridgeService')
const vitals = require('../services/vitalSignsService')

const router = Router()

// POST /api/symbridge/inbound — HTTP fallback for organism (HMAC auth, no JWT)
router.post('/inbound', async (req, res, next) => {
  try {
    const signature = req.headers['x-symbridge-signature']
    const result = await symbridge.receiveMessage({
      ...req.body,
      signature,
    })
    res.json(result)
  } catch (err) { next(err) }
})

// All other endpoints require JWT (human dashboard access)
router.use(auth)

// GET /api/symbridge/status — bridge health
router.get('/status', async (_req, res, next) => {
  try {
    const status = await symbridge.getStatus()
    res.json(status)
  } catch (err) { next(err) }
})

// GET /api/symbridge/health — combined health of both bodies
router.get('/health', async (_req, res, next) => {
  try {
    const health = await vitals.getVitals()
    res.json(health)
  } catch (err) { next(err) }
})

// GET /api/symbridge/queue — pending messages
router.get('/queue', async (req, res, next) => {
  try {
    const db = require('../config/db')
    const messages = await db`
      SELECT id, direction, message_type, source_system, status, created_at
      FROM symbridge_messages
      WHERE status IN ('pending', 'processing')
      ORDER BY created_at DESC
      LIMIT 50
    `
    res.json(messages)
  } catch (err) { next(err) }
})

module.exports = router
