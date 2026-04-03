const express = require('express')
const router = express.Router()
const auth = require('../middleware/auth')
const driveService = require('../services/googleDriveService')

router.use(auth)

// GET /api/drive/stats
router.get('/stats', async (_req, res, next) => {
  try {
    const stats = await driveService.getStats()
    res.json(stats)
  } catch (err) { next(err) }
})

// GET /api/drive/search
router.get('/search', async (req, res, next) => {
  try {
    const { q, limit } = req.query
    if (!q) return res.status(400).json({ error: 'query required' })
    const files = await driveService.searchFiles(q, { limit: parseInt(limit) || 20 })
    res.json(files)
  } catch (err) { next(err) }
})

module.exports = router
