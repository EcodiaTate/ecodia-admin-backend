const express = require('express')
const router = express.Router()
const auth = require('../middleware/auth')
const metaService = require('../services/metaService')

router.use(auth)

// GET /api/meta/pages
router.get('/pages', async (_req, res, next) => {
  try {
    const pages = await metaService.getPages()
    res.json(pages)
  } catch (err) { next(err) }
})

// GET /api/meta/posts
router.get('/posts', async (req, res, next) => {
  try {
    const { pageId, limit } = req.query
    const posts = await metaService.getPosts({ pageId, limit: parseInt(limit) || 30 })
    res.json(posts)
  } catch (err) { next(err) }
})

// GET /api/meta/conversations
router.get('/conversations', async (req, res, next) => {
  try {
    const { pageId, limit } = req.query
    const conversations = await metaService.getConversations({ pageId, limit: parseInt(limit) || 30 })
    res.json(conversations)
  } catch (err) { next(err) }
})

// GET /api/meta/stats
router.get('/stats', async (_req, res, next) => {
  try {
    const stats = await metaService.getStats()
    res.json(stats)
  } catch (err) { next(err) }
})

// POST /api/meta/posts — publish post
router.post('/posts', async (req, res, next) => {
  try {
    const { pageId, message, link, imageUrl } = req.body
    if (!pageId || !message) return res.status(400).json({ error: 'pageId and message required' })
    res.json(await metaService.publishPost(pageId, { message, link, imageUrl }))
  } catch (err) { next(err) }
})

// DELETE /api/meta/posts/:id
router.delete('/posts/:id', async (req, res, next) => {
  try { res.json(await metaService.deletePost(req.params.id)) } catch (err) { next(err) }
})

// POST /api/meta/conversations/:id/message — send message
router.post('/conversations/:id/message', async (req, res, next) => {
  try {
    if (!req.body.message) return res.status(400).json({ error: 'message required' })
    res.json(await metaService.sendMessage(req.params.id, req.body.message))
  } catch (err) { next(err) }
})

// GET /api/meta/conversations/:id/messages — get messages
router.get('/conversations/:id/messages', async (req, res, next) => {
  try {
    const db = require('../config/db')
    const limit = parseInt(req.query.limit) || 30
    const messages = await db`
      SELECT * FROM meta_messages WHERE conversation_id = ${req.params.id}
      ORDER BY created_time DESC LIMIT ${limit}`
    res.json({ messages })
  } catch (err) { next(err) }
})

// POST /api/meta/comments/:id/reply
router.post('/comments/:id/reply', async (req, res, next) => {
  try {
    if (!req.body.pageId || !req.body.message) return res.status(400).json({ error: 'pageId and message required' })
    await metaService.replyToComment(req.params.id, req.body.pageId, req.body.message)
    res.json({ replied: true })
  } catch (err) { next(err) }
})

// POST /api/meta/sync — trigger full sync
router.post('/sync', async (_req, res, next) => {
  try {
    await metaService.poll()
    res.json(await metaService.getStats())
  } catch (err) { next(err) }
})

// POST /api/meta/triage — triage pending conversations
router.post('/triage', async (_req, res, next) => {
  try {
    await metaService.triagePendingConversations()
    res.json({ triaged: true })
  } catch (err) { next(err) }
})

module.exports = router
