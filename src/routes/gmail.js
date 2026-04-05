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
    const inbox = req.query.inbox

    const threads = await db`
      SELECT * FROM email_threads
      WHERE 1=1
        ${status ? db`AND status = ${status}` : db``}
        ${priority ? db`AND triage_priority = ${priority}` : db``}
        ${inbox ? db`AND inbox = ${inbox}` : db``}
      ORDER BY received_at DESC NULLS LAST
      LIMIT ${limit} OFFSET ${offset}
    `

    const [{ count }] = await db`
      SELECT count(*)::int FROM email_threads
      WHERE 1=1
        ${status ? db`AND status = ${status}` : db``}
        ${priority ? db`AND triage_priority = ${priority}` : db``}
        ${inbox ? db`AND inbox = ${inbox}` : db``}
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

// POST /api/gmail/threads/:id/archive
router.post('/threads/:id/archive', async (req, res, next) => {
  try {
    const gmailService = require('../services/gmailService')
    await gmailService.archiveThread(req.params.id)
    res.json({ status: 'archived' })
  } catch (err) {
    next(err)
  }
})

// POST /api/gmail/threads/:id/read
router.post('/threads/:id/read', async (req, res, next) => {
  try {
    const gmailService = require('../services/gmailService')
    await gmailService.markRead(req.params.id)
    res.json({ status: 'read' })
  } catch (err) {
    next(err)
  }
})

// POST /api/gmail/threads/:id/trash
router.post('/threads/:id/trash', async (req, res, next) => {
  try {
    const gmailService = require('../services/gmailService')
    await gmailService.trashThread(req.params.id)
    res.json({ status: 'trashed' })
  } catch (err) {
    next(err)
  }
})

// POST /api/gmail/threads/:id/triage — manually trigger triage for one thread
router.post('/threads/:id/triage', async (req, res, next) => {
  try {
    await db`UPDATE email_threads SET triage_status = 'pending', triage_attempts = 0 WHERE id = ${req.params.id}`
    const gmailService = require('../services/gmailService')
    await gmailService.triagePendingEmails()
    const [updated] = await db`SELECT * FROM email_threads WHERE id = ${req.params.id}`
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

// GET /api/gmail/stats — inbox overview
router.get('/stats', async (req, res, next) => {
  try {
    const gmailService = require('../services/gmailService')
    res.json(await gmailService.getInboxStats())
  } catch (err) {
    next(err)
  }
})

// GET /api/gmail/search — search threads
router.get('/search', async (req, res, next) => {
  try {
    const gmailService = require('../services/gmailService')
    const threads = await gmailService.searchThreads(req.query.q, parseInt(req.query.limit) || 20)
    res.json({ threads })
  } catch (err) { next(err) }
})

// POST /api/gmail/threads/:id/label — add label
router.post('/threads/:id/label', async (req, res, next) => {
  try {
    const gmailService = require('../services/gmailService')
    res.json(await gmailService.labelThread(req.params.id, req.body.label))
  } catch (err) { next(err) }
})

// POST /api/gmail/threads/:id/unlabel — remove label
router.post('/threads/:id/unlabel', async (req, res, next) => {
  try {
    const gmailService = require('../services/gmailService')
    res.json(await gmailService.removeLabel(req.params.id, req.body.label))
  } catch (err) { next(err) }
})

// POST /api/gmail/threads/:id/star
router.post('/threads/:id/star', async (req, res, next) => {
  try {
    const gmailService = require('../services/gmailService')
    res.json(await gmailService.starThread(req.params.id))
  } catch (err) { next(err) }
})

// POST /api/gmail/threads/:id/unstar
router.post('/threads/:id/unstar', async (req, res, next) => {
  try {
    const gmailService = require('../services/gmailService')
    res.json(await gmailService.unstarThread(req.params.id))
  } catch (err) { next(err) }
})

// POST /api/gmail/threads/:id/forward
router.post('/threads/:id/forward', async (req, res, next) => {
  try {
    if (!req.body.to) return res.status(400).json({ error: 'to is required' })
    const gmailService = require('../services/gmailService')
    res.json(await gmailService.forwardThread(req.params.id, req.body.to))
  } catch (err) { next(err) }
})

// POST /api/gmail/threads/:id/followup — create task from email
router.post('/threads/:id/followup', async (req, res, next) => {
  try {
    const gmailService = require('../services/gmailService')
    res.json(await gmailService.createFollowUpTask(req.params.id, req.body.title, req.body.description, req.body.priority))
  } catch (err) { next(err) }
})

// POST /api/gmail/threads/:id/unsubscribe
router.post('/threads/:id/unsubscribe', async (req, res, next) => {
  try {
    const gmailService = require('../services/gmailService')
    res.json(await gmailService.unsubscribe(req.params.id))
  } catch (err) { next(err) }
})

// POST /api/gmail/batch/archive
router.post('/batch/archive', async (req, res, next) => {
  try {
    const gmailService = require('../services/gmailService')
    if (typeof req.body.threadIds === 'string') req.body.threadIds = JSON.parse(req.body.threadIds)
    res.json(await gmailService.batchArchive(req.body.threadIds))
  } catch (err) { next(err) }
})

// POST /api/gmail/batch/trash
router.post('/batch/trash', async (req, res, next) => {
  try {
    const gmailService = require('../services/gmailService')
    if (typeof req.body.threadIds === 'string') req.body.threadIds = JSON.parse(req.body.threadIds)
    res.json(await gmailService.batchTrash(req.body.threadIds))
  } catch (err) { next(err) }
})

// POST /api/gmail/send — send new email (not reply)
router.post('/send', async (req, res, next) => {
  try {
    const { to, subject, body, inbox } = req.body
    if (!to || !subject || !body) return res.status(400).json({ error: 'to, subject, and body are required' })
    const gmailService = require('../services/gmailService')
    res.json(await gmailService.sendNewEmail(inbox, to, subject, body))
  } catch (err) { next(err) }
})

// GET /api/gmail/labels — list labels
router.get('/labels', async (req, res, next) => {
  try {
    const gmailService = require('../services/gmailService')
    res.json(await gmailService.listLabels(req.query.inbox))
  } catch (err) { next(err) }
})

module.exports = router
