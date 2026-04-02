const express = require('express')
const router = express.Router()
const auth = require('../middleware/auth')
const env = require('../config/env')
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

// ─── Write Operations ──────────────────────────────────────────────────

// POST /api/drive/doc — create a Google Doc
router.post('/doc', async (req, res, next) => {
  try {
    const { title, content, folderId, account } = req.body
    if (!title) return res.status(400).json({ error: 'title required' })
    const doc = await driveService.createDocument(account || env.GOOGLE_PRIMARY_ACCOUNT, { title, content, folderId })
    res.json(doc)
  } catch (err) { next(err) }
})

// POST /api/drive/doc/:id/append — append to a Google Doc
router.post('/doc/:id/append', async (req, res, next) => {
  try {
    const { content, account } = req.body
    if (!content) return res.status(400).json({ error: 'content required' })
    const result = await driveService.appendToDocument(account || env.GOOGLE_PRIMARY_ACCOUNT, req.params.id, content)
    res.json(result)
  } catch (err) { next(err) }
})

// POST /api/drive/sheet — create a Google Sheet
router.post('/sheet', async (req, res, next) => {
  try {
    const { title, sheets, folderId, account } = req.body
    if (!title) return res.status(400).json({ error: 'title required' })
    const sheet = await driveService.createSpreadsheet(account || env.GOOGLE_PRIMARY_ACCOUNT, { title, sheets, folderId })
    res.json(sheet)
  } catch (err) { next(err) }
})

// PUT /api/drive/sheet/:id — write to a Google Sheet
router.put('/sheet/:id', async (req, res, next) => {
  try {
    const { range, values, account } = req.body
    if (!range || !values) return res.status(400).json({ error: 'range and values required' })
    const result = await driveService.writeToSheet(account || env.GOOGLE_PRIMARY_ACCOUNT, req.params.id, { range, values })
    res.json(result)
  } catch (err) { next(err) }
})

// POST /api/drive/sheet/:id/append — append rows to a Google Sheet
router.post('/sheet/:id/append', async (req, res, next) => {
  try {
    const { range, values, account } = req.body
    if (!range || !values) return res.status(400).json({ error: 'range and values required' })
    const result = await driveService.appendToSheet(account || env.GOOGLE_PRIMARY_ACCOUNT, req.params.id, { range, values })
    res.json(result)
  } catch (err) { next(err) }
})

// POST /api/drive/upload — upload a file
router.post('/upload', async (req, res, next) => {
  try {
    const { name, mimeType, content, folderId, account } = req.body
    if (!name || !content) return res.status(400).json({ error: 'name and content required' })
    const file = await driveService.uploadFile(account || env.GOOGLE_PRIMARY_ACCOUNT, { name, mimeType, content, folderId })
    res.json(file)
  } catch (err) { next(err) }
})

// POST /api/drive/folder — create a folder
router.post('/folder', async (req, res, next) => {
  try {
    const { name, parentFolderId, account } = req.body
    if (!name) return res.status(400).json({ error: 'name required' })
    const folder = await driveService.createFolder(account || env.GOOGLE_PRIMARY_ACCOUNT, { name, parentFolderId })
    res.json(folder)
  } catch (err) { next(err) }
})

// PATCH /api/drive/:id/move — move a file to a folder
router.patch('/:id/move', async (req, res, next) => {
  try {
    const { folderId, account } = req.body
    if (!folderId) return res.status(400).json({ error: 'folderId required' })
    const result = await driveService.moveFile(account || env.GOOGLE_PRIMARY_ACCOUNT, req.params.id, folderId)
    res.json(result)
  } catch (err) { next(err) }
})

// PATCH /api/drive/:id/rename — rename a file
router.patch('/:id/rename', async (req, res, next) => {
  try {
    const { name, account } = req.body
    if (!name) return res.status(400).json({ error: 'name required' })
    const result = await driveService.renameFile(account || env.GOOGLE_PRIMARY_ACCOUNT, req.params.id, name)
    res.json(result)
  } catch (err) { next(err) }
})

// DELETE /api/drive/:id — delete a file
router.delete('/:id', async (req, res, next) => {
  try {
    await driveService.deleteFile(req.query.account || env.GOOGLE_PRIMARY_ACCOUNT, req.params.id)
    res.json({ ok: true })
  } catch (err) { next(err) }
})

// POST /api/drive/:id/share — share a file
router.post('/:id/share', async (req, res, next) => {
  try {
    const { email, role, type, account } = req.body
    if (!email) return res.status(400).json({ error: 'email required' })
    const result = await driveService.shareFile(account || env.GOOGLE_PRIMARY_ACCOUNT, req.params.id, { email, role, type })
    res.json(result)
  } catch (err) { next(err) }
})

module.exports = router
