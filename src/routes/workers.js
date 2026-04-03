const express = require('express')
const auth = require('../middleware/auth')
const db = require('../config/db')

const router = express.Router()
router.use(auth)

// GET /api/workers/status — returns last-run timestamps for all workers
router.get('/status', async (_req, res, next) => {
  try {
    const rows = await db`
      SELECT worker_name, last_run_at, status, error_msg
      FROM worker_heartbeats
      ORDER BY worker_name
    `
    const workers = {}
    for (const row of rows) {
      workers[row.worker_name] = {
        worker: row.worker_name,
        lastSync: row.last_run_at,
        status: row.status,
        error: row.error_msg,
      }
    }
    res.json(workers)
  } catch (err) {
    next(err)
  }
})

// GET /api/workers/vitals — full system vitals (DB, Neo4j, memory, CPU, PM2, event loop lag)
router.get('/vitals', async (_req, res, next) => {
  try {
    const vitals = require('../services/vitalSignsService')
    res.json(await vitals.getVitals())
  } catch (err) {
    next(err)
  }
})

// GET /api/workers/errors — recent application errors grouped by pattern
router.get('/errors', async (req, res, next) => {
  try {
    const hours = Math.min(parseInt(req.query.hours) || 24, 168)
    const limit = Math.min(parseInt(req.query.limit) || 20, 100)

    const errors = await db`
      SELECT message, module, path, level,
             count(*)::int AS occurrences,
             max(created_at) AS last_seen,
             min(created_at) AS first_seen,
             max(stack) AS sample_stack
      FROM app_errors
      WHERE created_at > now() - make_interval(hours => ${hours})
      GROUP BY message, module, path, level
      ORDER BY occurrences DESC
      LIMIT ${limit}
    `
    const [{ total }] = await db`
      SELECT count(*)::int AS total FROM app_errors
      WHERE created_at > now() - make_interval(hours => ${hours})
    `

    res.json({ errors, total, hoursBack: hours })
  } catch (err) {
    next(err)
  }
})

// GET /api/workers/pm2 — PM2 process state
router.get('/pm2', async (_req, res, next) => {
  try {
    const vitals = require('../services/vitalSignsService')
    res.json({ processes: await vitals.getPM2Processes() })
  } catch (err) {
    next(err)
  }
})

module.exports = router
