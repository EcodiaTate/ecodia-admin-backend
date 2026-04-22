/**
 * Message Queue Routes — /api/message-queue/*
 *
 * CRUD for the Tate->OS inbox, plus the signal-handoff and sweep endpoints
 * called by the MCP tool and the age-sweep cron respectively.
 */

const express = require('express')
const router = express.Router()
const db = require('../config/db')
const mq = require('../services/messageQueue')
const { broadcast } = require('../websocket/wsManager')

// GET / — list pending messages
router.get('/', async (req, res, next) => {
  try {
    const limit = parseInt(req.query.limit) || 50
    const rows = await mq.getPending({ limit })
    res.json(rows)
  } catch (err) { next(err) }
})

// POST /signal-handoff — MCP tool calls this when OS declares handoff readiness
// Must be registered before /:id routes to avoid param capture
router.post('/signal-handoff', async (req, res, next) => {
  try {
    const { summary, turn_id } = req.body || {}
    const result = await mq.deliverPending({
      summary: summary || null,
      turn_id: turn_id || null,
    })
    res.json(result)
  } catch (err) { next(err) }
})

// POST /sweep — age-sweep cron endpoint (sweeps messages past max_age_hours)
router.post('/sweep', async (req, res, next) => {
  try {
    const result = await mq.sweepAged()
    res.json(result)
  } catch (err) { next(err) }
})

// GET /:id — single message
router.get('/:id', async (req, res, next) => {
  try {
    const [row] = await db`SELECT * FROM message_queue WHERE id = ${req.params.id}`
    if (!row) return res.status(404).json({ error: 'Not found' })
    res.json(row)
  } catch (err) { next(err) }
})

// PATCH /:id — update body or max_age_hours (only while pending).
// max_age_hours is clamped to [1, 168] to match the frontend edit form.
router.patch('/:id', async (req, res, next) => {
  try {
    const { body, max_age_hours } = req.body || {}
    let clampedAge = null
    if (max_age_hours !== undefined) {
      const n = parseInt(max_age_hours)
      if (!Number.isFinite(n)) {
        return res.status(400).json({ error: 'max_age_hours must be a number' })
      }
      clampedAge = Math.min(168, Math.max(1, n))
    }
    const [row] = await db`
      UPDATE message_queue SET
        body            = COALESCE(${body !== undefined ? body : null}, body),
        max_age_hours   = COALESCE(${clampedAge}, max_age_hours)
      WHERE id = ${req.params.id}
        AND delivered_at IS NULL AND cancelled_at IS NULL
      RETURNING *
    `
    if (!row) return res.status(404).json({ error: 'Not found or already delivered/cancelled' })
    // Emit a WS event so any open drawer refetches without waiting for its poll.
    broadcast('message_queue:updated', { id: row.id })
    res.json(row)
  } catch (err) { next(err) }
})

// DELETE /:id — cancel a pending message
router.delete('/:id', async (req, res, next) => {
  try {
    const result = await mq.cancelMessage(req.params.id)
    if (!result) return res.status(404).json({ error: 'Not found or already delivered/cancelled' })
    res.json({ ok: true, cancelled: result.id })
  } catch (err) { next(err) }
})

// POST /:id/promote — deliver a specific message immediately
router.post('/:id/promote', async (req, res, next) => {
  try {
    const result = await mq.promoteNow(req.params.id)
    res.json(result)
  } catch (err) { next(err) }
})

module.exports = router
