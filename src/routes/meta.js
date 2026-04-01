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

module.exports = router
