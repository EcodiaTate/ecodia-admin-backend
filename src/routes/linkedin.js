const { Router } = require('express')
const { z } = require('zod')
const auth = require('../middleware/auth')
const validate = require('../middleware/validate')
const db = require('../config/db')

const router = Router()
router.use(auth)

// GET /api/linkedin/dms
router.get('/dms', async (req, res, next) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 15, 200)
    const offset = parseInt(req.query.offset) || 0
    const status = req.query.status

    const dms = await db`
      SELECT * FROM linkedin_dms
      WHERE 1=1
        ${status ? db`AND status = ${status}` : db``}
      ORDER BY last_message_at DESC NULLS LAST
      LIMIT ${limit} OFFSET ${offset}
    `

    const [{ count }] = await db`
      SELECT count(*)::int FROM linkedin_dms
      WHERE 1=1
        ${status ? db`AND status = ${status}` : db``}
    `

    res.json({ dms, total: count })
  } catch (err) {
    next(err)
  }
})

// GET /api/linkedin/dms/:id
router.get('/dms/:id', async (req, res, next) => {
  try {
    const [dm] = await db`SELECT * FROM linkedin_dms WHERE id = ${req.params.id}`
    if (!dm) return res.status(404).json({ error: 'DM not found' })
    res.json(dm)
  } catch (err) {
    next(err)
  }
})

// POST /api/linkedin/dms/:id/draft-reply
router.post('/dms/:id/draft-reply', async (req, res, next) => {
  try {
    const [dm] = await db`SELECT * FROM linkedin_dms WHERE id = ${req.params.id}`
    if (!dm) return res.status(404).json({ error: 'DM not found' })

    const deepseekService = require('../services/deepseekService')
    const draft = await deepseekService.draftLinkedInReply(dm)

    const [updated] = await db`
      UPDATE linkedin_dms SET draft_reply = ${draft}, status = 'drafting', updated_at = now()
      WHERE id = ${req.params.id}
      RETURNING *
    `
    res.json(updated)
  } catch (err) {
    next(err)
  }
})

// POST /api/linkedin/dms/:id/send
router.post('/dms/:id/send', async (req, res, next) => {
  try {
    const [dm] = await db`SELECT * FROM linkedin_dms WHERE id = ${req.params.id}`
    if (!dm) return res.status(404).json({ error: 'DM not found' })
    if (!dm.draft_reply) return res.status(400).json({ error: 'No draft to send' })

    const linkedinService = require('../services/linkedinService')
    await linkedinService.sendMessage(dm.conversation_id, dm.draft_reply)

    const [updated] = await db`
      UPDATE linkedin_dms SET status = 'replied', updated_at = now()
      WHERE id = ${req.params.id}
      RETURNING *
    `
    res.json(updated)
  } catch (err) {
    next(err)
  }
})

// GET /api/linkedin/posts/scheduled
router.get('/posts/scheduled', async (req, res, next) => {
  try {
    const posts = await db`
      SELECT * FROM linkedin_posts
      WHERE status IN ('draft', 'scheduled')
      ORDER BY scheduled_at ASC NULLS LAST
    `
    res.json(posts)
  } catch (err) {
    next(err)
  }
})

// POST /api/linkedin/posts/schedule
const schedulePostSchema = z.object({
  content: z.string().min(1),
  mediaPaths: z.array(z.string()).optional(),
  scheduledAt: z.string().datetime().optional(),
})

router.post('/posts/schedule', validate(schedulePostSchema), async (req, res, next) => {
  try {
    const [post] = await db`
      INSERT INTO linkedin_posts (content, media_paths, scheduled_at, status)
      VALUES (${req.body.content}, ${req.body.mediaPaths || []},
              ${req.body.scheduledAt || null},
              ${req.body.scheduledAt ? 'scheduled' : 'draft'})
      RETURNING *
    `
    res.status(201).json(post)
  } catch (err) {
    next(err)
  }
})

// GET /api/linkedin/worker/status
router.get('/worker/status', async (req, res, next) => {
  try {
    // Worker status tracked via a simple file or DB flag
    const linkedinService = require('../services/linkedinService')
    const status = await linkedinService.getWorkerStatus()
    res.json(status)
  } catch (err) {
    next(err)
  }
})

// POST /api/linkedin/worker/resume
router.post('/worker/resume', async (req, res, next) => {
  try {
    const linkedinService = require('../services/linkedinService')
    await linkedinService.resumeWorker()
    res.json({ status: 'ok' })
  } catch (err) {
    next(err)
  }
})

module.exports = router
