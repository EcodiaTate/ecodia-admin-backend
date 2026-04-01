const { Router } = require('express')
const { z } = require('zod')
const auth = require('../middleware/auth')
const validate = require('../middleware/validate')
const db = require('../config/db')

const router = Router()
router.use(auth)

// GET /api/gmail/threads
router.get('/threads', async (req, res, next) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 20, 200)
    const offset = parseInt(req.query.offset) || 0
    const status = req.query.status
    const priority = req.query.priority

    const threads = await db`
      SELECT * FROM email_threads
      WHERE 1=1
        ${status ? db`AND status = ${status}` : db``}
        ${priority ? db`AND triage_priority = ${priority}` : db``}
      ORDER BY received_at DESC NULLS LAST
      LIMIT ${limit} OFFSET ${offset}
    `

    const [{ count }] = await db`
      SELECT count(*)::int FROM email_threads
      WHERE 1=1
        ${status ? db`AND status = ${status}` : db``}
        ${priority ? db`AND triage_priority = ${priority}` : db``}
    `

    res.json({ threads, total: count })
  } catch (err) {
    next(err)
  }
})

// GET /api/gmail/threads/:id
router.get('/threads/:id', async (req, res, next) => {
  try {
    const [thread] = await db`SELECT * FROM email_threads WHERE id = ${req.params.id}`
    if (!thread) return res.status(404).json({ error: 'Thread not found' })
    res.json(thread)
  } catch (err) {
    next(err)
  }
})

// POST /api/gmail/threads/:id/draft-reply
router.post('/threads/:id/draft-reply', async (req, res, next) => {
  try {
    const [thread] = await db`SELECT * FROM email_threads WHERE id = ${req.params.id}`
    if (!thread) return res.status(404).json({ error: 'Thread not found' })

    const deepseekService = require('../services/deepseekService')
    const draft = await deepseekService.draftEmailReply(thread)

    const [updated] = await db`
      UPDATE email_threads SET draft_reply = ${draft}, updated_at = now()
      WHERE id = ${req.params.id}
      RETURNING *
    `
    res.json(updated)
  } catch (err) {
    next(err)
  }
})

// POST /api/gmail/threads/:id/send-draft
router.post('/threads/:id/send-draft', async (req, res, next) => {
  try {
    const [thread] = await db`SELECT * FROM email_threads WHERE id = ${req.params.id}`
    if (!thread) return res.status(404).json({ error: 'Thread not found' })
    if (!thread.draft_reply) return res.status(400).json({ error: 'No draft to send' })

    const gmailService = require('../services/gmailService')
    await gmailService.sendReply(thread.gmail_thread_id, thread.draft_reply)

    const [updated] = await db`
      UPDATE email_threads SET status = 'replied', updated_at = now()
      WHERE id = ${req.params.id}
      RETURNING *
    `
    res.json(updated)
  } catch (err) {
    next(err)
  }
})

// POST /api/gmail/sync
router.post('/sync', async (req, res, next) => {
  try {
    const gmailService = require('../services/gmailService')
    await gmailService.pollInbox()
    res.json({ status: 'ok' })
  } catch (err) {
    next(err)
  }
})

module.exports = router
