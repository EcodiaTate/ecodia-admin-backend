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

// POST /api/meta/sync — manual sync
router.post('/sync', async (_req, res, next) => {
  try {
    await metaService.poll()
    res.json({ ok: true })
  } catch (err) { next(err) }
})

// POST /api/meta/discover — discover pages from user token
router.post('/discover', async (_req, res, next) => {
  try {
    const pages = await metaService.discoverPages()
    res.json(pages)
  } catch (err) { next(err) }
})

// ─── Write Operations ──────────────────────────────────────────────────

// POST /api/meta/pages/:pageId/post — publish a post
router.post('/pages/:pageId/post', async (req, res, next) => {
  try {
    const { message, link, imageUrl } = req.body
    if (!message && !imageUrl) return res.status(400).json({ error: 'message or imageUrl required' })
    const result = await metaService.publishPost(req.params.pageId, { message, link, imageUrl })
    res.json(result)
  } catch (err) { next(err) }
})

// DELETE /api/meta/posts/:postId
router.delete('/posts/:postId', async (req, res, next) => {
  try {
    const result = await metaService.deletePost(req.params.postId)
    res.json(result)
  } catch (err) { next(err) }
})

// POST /api/meta/comments/:commentId/reply — reply to a comment
router.post('/comments/:commentId/reply', async (req, res, next) => {
  try {
    const { pageId, message } = req.body
    if (!pageId || !message) return res.status(400).json({ error: 'pageId and message required' })
    const result = await metaService.replyToComment(req.params.commentId, pageId, message)
    res.json(result)
  } catch (err) { next(err) }
})

// POST /api/meta/conversations/:id/send — send a Messenger message
router.post('/conversations/:id/send', async (req, res, next) => {
  try {
    const { message } = req.body
    if (!message) return res.status(400).json({ error: 'message required' })
    const result = await metaService.sendMessage(req.params.id, message)
    res.json(result)
  } catch (err) { next(err) }
})

module.exports = router
