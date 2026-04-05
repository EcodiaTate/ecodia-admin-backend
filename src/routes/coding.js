const { Router } = require('express')
const auth = require('../middleware/auth')
const db = require('../config/db')

const router = Router()
router.use(auth)

const VALID_STATUSES = new Set(['pending', 'confirmed', 'dispatched', 'completed', 'rejected'])
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// ── Dashboard: workspace snapshot ──

router.get('/dashboard', async (_req, res, next) => {
  try {
    const [active] = await db`SELECT count(*)::int AS count FROM cc_sessions WHERE status IN ('running', 'initializing', 'completing', 'queued')`
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
    // Include stuck requests so the dashboard can alert
    const [stuck] = await db`
      SELECT count(*)::int AS count FROM code_requests
      WHERE status IN ('confirmed', 'pending')
        AND session_id IS NULL
        AND created_at < now() - interval '5 minutes'
        AND COALESCE(dispatch_attempts, 0) < 3
    `
    res.json({
      activeSessions: active.count,
      pendingRequests: pending.count,
      todayCompletions: today.count,
      stuckRequests: stuck.count,
      codebases,
      recentSessions,
    })
  } catch (err) { next(err) }
})

// ── Code Requests ──

router.get('/requests', async (req, res, next) => {
  try {
    const status = VALID_STATUSES.has(req.query.status) ? req.query.status : null
    const limit = Math.min(Math.max(parseInt(req.query.limit) || 50, 1), 200)
    const offset = Math.max(parseInt(req.query.offset) || 0, 0)
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
    res.json({ requests, count: requests.length })
  } catch (err) { next(err) }
})

router.get('/requests/:id', async (req, res, next) => {
  try {
    if (!UUID_RE.test(req.params.id)) return res.status(400).json({ error: 'Invalid ID format' })
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

// ── Confirm / Reject Code Requests ──

router.post('/requests/:id/confirm', async (req, res, next) => {
  try {
    if (!UUID_RE.test(req.params.id)) return res.status(400).json({ error: 'Invalid ID format' })
    const codeRequestService = require('../services/codeRequestService')
    const session = await codeRequestService.confirmAndDispatch(req.params.id, req.body.promptOverride)
    res.json({ status: 'confirmed', sessionId: session?.id || null })
  } catch (err) {
    if (err.message?.includes('not found')) return res.status(404).json({ error: err.message })
    if (err.message?.includes('Already dispatched')) return res.status(409).json({ error: err.message })
    next(err)
  }
})

router.post('/requests/:id/reject', async (req, res, next) => {
  try {
    if (!UUID_RE.test(req.params.id)) return res.status(400).json({ error: 'Invalid ID format' })
    const [existing] = await db`SELECT id, status FROM code_requests WHERE id = ${req.params.id}`
    if (!existing) return res.status(404).json({ error: 'Not found' })
    if (existing.status === 'dispatched') return res.status(409).json({ error: 'Cannot reject — already dispatched' })
    if (existing.status === 'completed') return res.status(409).json({ error: 'Cannot reject — already completed' })

    await db`
      UPDATE code_requests
      SET status = 'rejected', resolved_at = now(),
          metadata = metadata || ${JSON.stringify({ rejectionReason: req.body.reason || null })}::jsonb
      WHERE id = ${req.params.id}
    `
    res.json({ status: 'rejected' })
  } catch (err) { next(err) }
})

// ── Session Analytics ──

router.get('/analytics', async (req, res, next) => {
  try {
    const days = Math.min(Math.max(parseInt(req.query.days) || 7, 1), 90)
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

// ── Health check for session observation ──

router.get('/health', async (_req, res, next) => {
  try {
    const observation = require('../services/sessionObservationService')
    const health = await observation.checkSessionHealth()
    res.json(health)
  } catch (err) { next(err) }
})

module.exports = router
