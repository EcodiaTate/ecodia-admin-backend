const express = require('express')
const router = express.Router()
const auth = require('../middleware/auth')
const vercelService = require('../services/vercelService')

router.use(auth)

// GET /api/vercel/projects
router.get('/projects', async (_req, res, next) => {
  try {
    const projects = await vercelService.getProjects()
    res.json(projects)
  } catch (err) { next(err) }
})

// GET /api/vercel/deployments
router.get('/deployments', async (req, res, next) => {
  try {
    const { projectId, state, limit } = req.query
    const deployments = await vercelService.getDeployments({
      projectId, state, limit: parseInt(limit) || 30,
    })
    res.json(deployments)
  } catch (err) { next(err) }
})

// GET /api/vercel/deployments/:id/logs
router.get('/deployments/:id/logs', async (req, res, next) => {
  try {
    const logs = await vercelService.getBuildLogs(req.params.id)
    res.json(logs)
  } catch (err) { next(err) }
})

// GET /api/vercel/stats
router.get('/stats', async (_req, res, next) => {
  try {
    const stats = await vercelService.getStats()
    res.json(stats)
  } catch (err) { next(err) }
})

// POST /api/vercel/sync — manual sync
router.post('/sync', async (_req, res, next) => {
  try {
    await vercelService.poll()
    res.json({ ok: true })
  } catch (err) { next(err) }
})

module.exports = router
