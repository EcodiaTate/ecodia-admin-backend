const { Router } = require('express')
const auth = require('../middleware/auth')
const db = require('../config/db')

const router = Router()
router.use(auth)

// ── Dashboard: workspace snapshot ──

router.get('/dashboard', async (_req, res, next) => {
  try {
    const [active] = await db`SELECT count(*)::int AS count FROM cc_sessions WHERE status IN ('running', 'initializing')`
    const [pending] = await db`SELECT count(*)::int AS count FROM code_requests WHERE status = 'pending'`
    const [today] = await db`SELECT count(*)::int AS count FROM cc_sessions WHERE status = 'complete' AND completed_at > now() - interval '24 hours'`
    const codebases = await db`SELECT id, name, language, repo_path FROM codebases ORDER BY name`
    const recentSessions = await db`
      SELECT cs.id, cs.initial_prompt, cs.status, cs.pipeline_stage,
             cs.confidence_score, cs.triggered_by, cs.started_at, cs.completed_at,
             cb.name AS codebase_name, c.name AS client_name
      FROM cc_sessions cs
      LEFT JOIN codebases cb ON cs.codebase_id = cb.id
      LEFT JOIN clients c ON cs.client_id = c.id
      ORDER BY cs.started_at DESC LIMIT 10
    `
    res.json({ activeSessions: active.count, pendingRequests: pending.count, todayCompletions: today.count, codebases, recentSessions })
  } catch (err) { next(err) }
})

// ── Code Requests ──

router.get('/requests', async (req, res, next) => {
  try {
    const status = req.query.status || null
    const limit = Math.min(parseInt(req.query.limit) || 50, 200)
    const offset = parseInt(req.query.offset) || 0
    const requests = status
      ? await db`
          SELECT cr.*, c.name AS client_name, p.name AS project_name, cb.name AS codebase_name
          FROM code_requests cr
          LEFT JOIN clients c ON cr.client_id = c.id
          LEFT JOIN projects p ON cr.project_id = p.id
          LEFT JOIN codebases cb ON cr.codebase_id = cb.id
          WHERE cr.status = ${status}
          ORDER BY cr.created_at DESC LIMIT ${limit} OFFSET ${offset}
        `
      : await db`
          SELECT cr.*, c.name AS client_name, p.name AS project_name, cb.name AS codebase_name
          FROM code_requests cr
          LEFT JOIN clients c ON cr.client_id = c.id
          LEFT JOIN projects p ON cr.project_id = p.id
          LEFT JOIN codebases cb ON cr.codebase_id = cb.id
          ORDER BY cr.created_at DESC LIMIT ${limit} OFFSET ${offset}
        `
    res.json({ requests })
  } catch (err) { next(err) }
})

router.get('/requests/:id', async (req, res, next) => {
  try {
    const [request] = await db`
      SELECT cr.*, c.name AS client_name, p.name AS project_name, cb.name AS codebase_name
      FROM code_requests cr
      LEFT JOIN clients c ON cr.client_id = c.id
      LEFT JOIN projects p ON cr.project_id = p.id
      LEFT JOIN codebases cb ON cr.codebase_id = cb.id
      WHERE cr.id = ${req.params.id}
    `
    if (!request) return res.status(404).json({ error: 'Not found' })
    res.json(request)
  } catch (err) { next(err) }
})

// ── Session Analytics ──

router.get('/analytics', async (req, res, next) => {
  try {
    const days = Math.min(parseInt(req.query.days) || 7, 90)
    const sessions = await db`
      SELECT
        date_trunc('day', started_at) AS day,
        count(*)::int AS total,
        count(*) FILTER (WHERE status = 'complete')::int AS completed,
        count(*) FILTER (WHERE pipeline_stage = 'deployed')::int AS deployed,
        avg(confidence_score) FILTER (WHERE confidence_score IS NOT NULL) AS avg_confidence
      FROM cc_sessions
      WHERE started_at > now() - make_interval(days => ${days})
      GROUP BY day ORDER BY day
    `
    const [totals] = await db`
      SELECT
        count(*)::int AS total_sessions,
        count(*) FILTER (WHERE status = 'complete')::int AS completed,
        count(*) FILTER (WHERE pipeline_stage = 'deployed')::int AS deployed,
        avg(confidence_score) FILTER (WHERE confidence_score IS NOT NULL) AS avg_confidence
      FROM cc_sessions
      WHERE started_at > now() - make_interval(days => ${days})
    `
    res.json({ days, daily: sessions, totals })
  } catch (err) { next(err) }
})

module.exports = router
