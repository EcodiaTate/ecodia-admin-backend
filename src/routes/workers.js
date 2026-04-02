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

module.exports = router
