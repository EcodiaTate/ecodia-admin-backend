const express = require('express')
const router = express.Router()
const auth = require('../middleware/auth')
const driveService = require('../services/googleDriveService')

router.use(auth)

// GET /api/drive/ — list files with search
router.get('/', async (req, res, next) => {
  try {
    const { q, limit } = req.query
    if (q) {
      const files = await driveService.searchFiles(q, { limit: parseInt(limit) || 20 })
      return res.json(files)
    }
    const stats = await driveService.getStats()
    res.json(stats)
  } catch (err) { next(err) }
})

// GET /api/drive/stats
router.get('/stats', async (_req, res, next) => {
  try {
    const stats = await driveService.getStats()
    res.json(stats)
  } catch (err) { next(err) }
})

// GET /api/drive/tree — folder tree
router.get('/tree', async (_req, res, next) => {
  try {
    const tree = await driveService.getFolderTree()
    res.json(tree)
  } catch (err) { next(err) }
})

// POST /api/drive/search
router.post('/search', async (req, res, next) => {
  try {
    const { query, limit } = req.body
    if (!query) return res.status(400).json({ error: 'query required' })
    const files = await driveService.searchFiles(query, { limit: limit || 20 })
    res.json(files)
  } catch (err) { next(err) }
})

// POST /api/drive/sync — manual sync trigger
router.post('/sync', async (_req, res, next) => {
  try {
    await driveService.pollDrive()
    res.json({ ok: true })
  } catch (err) { next(err) }
})

// POST /api/drive/extract — manual content extraction trigger
router.post('/extract', async (req, res, next) => {
  try {
    const count = await driveService.extractContent(req.body?.batchSize || 20)
    res.json({ extracted: count })
  } catch (err) { next(err) }
})

module.exports = router
