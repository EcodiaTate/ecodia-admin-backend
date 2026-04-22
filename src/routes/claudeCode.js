const { Router } = require('express')
const { z } = require('zod')
const auth = require('../middleware/auth')
const validate = require('../middleware/validate')
const db = require('../config/db')

const router = Router()
router.use(auth)

// GET /api/cc/sessions
router.get('/sessions', async (req, res, next) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 20, 200)
    const offset = parseInt(req.query.offset) || 0
    const status = req.query.status
    const clientId = req.query.clientId
    const codebaseId = req.query.codebaseId

    const sessions = await db`
      SELECT cs.*, p.name AS project_name, c.name AS client_name, cb.name AS codebase_name
      FROM cc_sessions cs
      LEFT JOIN projects p ON cs.project_id = p.id
      LEFT JOIN clients c ON cs.client_id = c.id
      LEFT JOIN codebases cb ON cs.codebase_id = cb.id
      WHERE 1=1
        ${status ? db`AND cs.status = ${status}` : db``}
        ${clientId ? db`AND cs.client_id = ${clientId}` : db``}
        ${codebaseId ? db`AND cs.codebase_id = ${codebaseId}` : db``}
      ORDER BY cs.started_at DESC
      LIMIT ${limit} OFFSET ${offset}
    `

    const [{ count }] = await db`
      SELECT count(*)::int FROM cc_sessions
      WHERE 1=1
        ${status ? db`AND status = ${status}` : db``}
        ${clientId ? db`AND client_id = ${clientId}` : db``}
        ${codebaseId ? db`AND codebase_id = ${codebaseId}` : db``}
    `

    res.json({ sessions, total: count })
  } catch (err) {
    next(err)
  }
})

// POST /api/cc/sessions — start new CC session
const createSessionSchema = z.object({
  projectId: z.string().uuid().optional(),
  clientId: z.string().uuid().optional(),
  codebaseId: z.string().uuid().optional(),
  triggeredBy: z.enum(['crm_stage', 'manual', 'task', 'simula', 'thymos', 'scheduled', 'cortex', 'self_modification', 'self_diagnosis', 'kg_insight', 'kg_prediction', 'proactive', 'email', 'os-session']).default('manual'),
  triggerRefId: z.string().optional(),
  triggerSource: z.enum(['manual', 'crm_stage', 'kg_insight', 'simula_proposal', 'thymos_incident', 'scheduled', 'cortex', 'self_modification', 'proactive_improvement', 'gmail', 'os-session']).optional(),
  initialPrompt: z.string().min(1),
  codebaseName: z.string().nullable().optional(),
  workingDir: z.string().nullable().optional(),
})

router.post('/sessions', validate(createSessionSchema), async (req, res, next) => {
  try {
    const b = req.body
    const { resolveCodebase } = require('../services/factoryTriggerService')

    const codebaseId = await resolveCodebase({
      codebaseId: b.codebaseId,
      codebaseName: b.codebaseName,
      prompt: b.initialPrompt,
    })

    const [session] = await db`
      INSERT INTO cc_sessions (project_id, client_id, codebase_id, triggered_by, trigger_ref_id, trigger_source, initial_prompt, working_dir)
      VALUES (${b.projectId || null}, ${b.clientId || null}, ${codebaseId}, ${b.triggeredBy},
              ${b.triggerRefId || null}, ${b.triggerSource || 'manual'}, ${b.initialPrompt}, ${b.workingDir || null})
      RETURNING *
    `

    // Broadcast session creation so all clients can track it
    const { broadcast } = require('../websocket/wsManager')
    broadcast('cc:session_created', {
      data: {
        id: session.id,
        prompt: session.initial_prompt?.slice(0, 120),
        triggered_by: session.triggered_by,
        codebase_id: session.codebase_id,
        status: session.status,
        pipeline_stage: session.pipeline_stage || 'queued',
      },
    })

    // Publish to factoryRunner via Redis
    const bridge = require('../services/factoryBridge')
    const published = bridge.publishSessionRequest(session)
    if (!published) {
      db`UPDATE cc_sessions SET status = 'error', error_message = 'Failed to publish to factory runner (no Redis)', completed_at = now()
         WHERE id = ${session.id}`.catch(() => {})
    }

    res.status(201).json(session)
  } catch (err) {
    next(err)
  }
})

// GET /api/cc/sessions/:id
router.get('/sessions/:id', async (req, res, next) => {
  try {
    const [session] = await db`
      SELECT cs.*, p.name AS project_name, c.name AS client_name
      FROM cc_sessions cs
      LEFT JOIN projects p ON cs.project_id = p.id
      LEFT JOIN clients c ON cs.client_id = c.id
      WHERE cs.id = ${req.params.id}
    `
    if (!session) return res.status(404).json({ error: 'Session not found' })
    res.json(session)
  } catch (err) {
    next(err)
  }
})

// GET /api/cc/sessions/:id/logs
router.get('/sessions/:id/logs', async (req, res, next) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 100, 500)
    const offset = parseInt(req.query.offset) || 0

    const logs = await db`
      SELECT chunk, created_at FROM cc_session_logs
      WHERE session_id = ${req.params.id}
      ORDER BY created_at ASC
      LIMIT ${limit} OFFSET ${offset}
    `

    const [{ count }] = await db`
      SELECT count(*)::int FROM cc_session_logs WHERE session_id = ${req.params.id}
    `

    res.json({ logs, total: count })
  } catch (err) {
    next(err)
  }
})

// POST /api/cc/sessions/:id/message
const messageSchema = z.object({
  content: z.string().min(1),
})

router.post('/sessions/:id/message', validate(messageSchema), async (req, res, next) => {
  try {
    const bridge = require('../services/factoryBridge')
    bridge.publishSendMessage(req.params.id, req.body.content)
    res.json({ status: 'ok' })
  } catch (err) {
    next(err)
  }
})

// GET /api/cc/sessions/:id/pipeline
router.get('/sessions/:id/pipeline', async (req, res, next) => {
  try {
    const [session] = await db`
      SELECT pipeline_stage, confidence_score, deploy_status, files_changed, commit_sha
      FROM cc_sessions WHERE id = ${req.params.id}
    `
    if (!session) return res.status(404).json({ error: 'Session not found' })

    // Active session info now lives in factoryRunner — query via DB heartbeat
    const isActive = session.pipeline_stage === 'executing' &&
      session.last_heartbeat_at && (Date.now() - new Date(session.last_heartbeat_at).getTime() < 120_000)

    res.json({ ...session, active: isActive ? { sessionId: req.params.id } : null })
  } catch (err) { next(err) }
})

// POST /api/cc/sessions/:id/resume — resume a completed/paused session with a new message
const resumeSchema = z.object({
  content: z.string().min(1),
})

router.post('/sessions/:id/resume', validate(resumeSchema), async (req, res, next) => {
  try {
    const bridge = require('../services/factoryBridge')
    bridge.publishResumeSession(req.params.id, req.body.content)
    res.json({ status: 'resumed', sessionId: req.params.id })
  } catch (err) {
    next(err)
  }
})

// POST /api/cc/sessions/:id/stop
router.post('/sessions/:id/stop', async (req, res, next) => {
  try {
    const bridge = require('../services/factoryBridge')
    bridge.publishStopSession(req.params.id)

    const [updated] = await db`
      UPDATE cc_sessions SET status = 'complete', completed_at = now()
      WHERE id = ${req.params.id}
      RETURNING *
    `
    res.json(updated)
  } catch (err) {
    next(err)
  }
})

// GET /api/cc/health — session health monitoring (stall detection)
router.get('/health', async (_req, res, next) => {
  try {
    const bridge = require('../services/factoryBridge')

    // Get runner-level health
    const runnerHealth = await bridge.getRunnerHealth()

    // Get per-session health snapshot from Redis (published by factoryRunner watchdog)
    const sessionHealth = await bridge.getSessionHealth()

    // Also check for orphaned DB sessions (marked running but no heartbeat)
    const orphanedDb = await db`
      SELECT id, started_at, initial_prompt, codebase_id, last_heartbeat_at
      FROM cc_sessions
      WHERE status IN ('running', 'initializing')
        AND (
          (last_heartbeat_at IS NULL AND started_at < now() - interval '5 minutes')
          OR (last_heartbeat_at IS NOT NULL AND last_heartbeat_at < now() - interval '3 minutes')
        )
      ORDER BY started_at ASC
    `

    res.json({
      runner: runnerHealth,
      sessions: sessionHealth || { activeSessions: 0, stalledSessions: 0, healthySessions: 0, sessions: [] },
      orphanedDbSessions: orphanedDb.length,
      orphanedSessions: orphanedDb.map(s => ({
        sessionId: s.id,
        startedAt: s.started_at,
        lastHeartbeat: s.last_heartbeat_at,
        codebaseId: s.codebase_id,
        prompt: (s.initial_prompt || '').slice(0, 120),
      })),
    })
  } catch (err) {
    next(err)
  }
})

// GET /api/cc/analytics — Factory performance analytics
router.get('/analytics', async (req, res, next) => {
  try {
    const days = Math.min(parseInt(req.query.days) || 30, 90)
    const analytics = {}

    await Promise.allSettled([
      // Overall success rates
      db`
        SELECT
          count(*)::int AS total,
          count(*) FILTER (WHERE status = 'complete')::int AS complete,
          count(*) FILTER (WHERE status = 'error')::int AS errored,
          count(*) FILTER (WHERE deploy_status = 'deployed')::int AS deployed,
          count(*) FILTER (WHERE deploy_status = 'failed')::int AS deploy_failed,
          count(*) FILTER (WHERE deploy_status = 'reverted')::int AS reverted,
          round(avg(confidence_score)::numeric, 3) AS avg_confidence,
          round(avg(CASE WHEN status = 'complete' THEN confidence_score END)::numeric, 3) AS avg_success_confidence,
          round(avg(CASE WHEN status = 'error' THEN confidence_score END)::numeric, 3) AS avg_failure_confidence
        FROM cc_sessions
        WHERE started_at > now() - make_interval(days => ${days})
      `.then(([r]) => { analytics.summary = r }),

      // Confidence trend (daily buckets)
      db`
        SELECT
          date_trunc('day', started_at)::date AS day,
          count(*)::int AS sessions,
          count(*) FILTER (WHERE status = 'complete')::int AS complete,
          count(*) FILTER (WHERE status = 'error')::int AS errored,
          count(*) FILTER (WHERE deploy_status = 'deployed')::int AS deployed,
          round(avg(confidence_score)::numeric, 3) AS avg_confidence
        FROM cc_sessions
        WHERE started_at > now() - make_interval(days => ${days})
        GROUP BY 1 ORDER BY 1
      `.then(rows => { analytics.confidenceTrend = rows }),

      // Per-stream breakdown
      db`
        SELECT
          coalesce(stream_source, 'manual') AS stream,
          count(*)::int AS total,
          count(*) FILTER (WHERE status = 'complete')::int AS complete,
          count(*) FILTER (WHERE status = 'error')::int AS errored,
          count(*) FILTER (WHERE deploy_status = 'deployed')::int AS deployed,
          round(avg(confidence_score)::numeric, 3) AS avg_confidence,
          round(avg(CASE WHEN status = 'complete' THEN confidence_score END)::numeric, 3) AS avg_success_confidence
        FROM cc_sessions
        WHERE started_at > now() - make_interval(days => ${days})
        GROUP BY 1 ORDER BY total DESC
      `.then(rows => { analytics.byStream = rows }),

      // Per-trigger-source breakdown
      db`
        SELECT
          coalesce(trigger_source, 'unknown') AS source,
          count(*)::int AS total,
          count(*) FILTER (WHERE status = 'complete')::int AS complete,
          count(*) FILTER (WHERE status = 'error')::int AS errored,
          count(*) FILTER (WHERE deploy_status = 'deployed')::int AS deployed,
          round(avg(confidence_score)::numeric, 3) AS avg_confidence
        FROM cc_sessions
        WHERE started_at > now() - make_interval(days => ${days})
        GROUP BY 1 ORDER BY total DESC
      `.then(rows => { analytics.byTriggerSource = rows }),

      // Per-codebase breakdown
      db`
        SELECT
          coalesce(cb.name, 'unknown') AS codebase,
          count(*)::int AS total,
          count(*) FILTER (WHERE cs.status = 'complete')::int AS complete,
          count(*) FILTER (WHERE cs.status = 'error')::int AS errored,
          count(*) FILTER (WHERE cs.deploy_status = 'deployed')::int AS deployed,
          round(avg(cs.confidence_score)::numeric, 3) AS avg_confidence
        FROM cc_sessions cs
        LEFT JOIN codebases cb ON cs.codebase_id = cb.id
        WHERE cs.started_at > now() - make_interval(days => ${days})
        GROUP BY 1 ORDER BY total DESC
      `.then(rows => { analytics.byCodebase = rows }),

      // Pipeline stage distribution (where sessions get stuck/fail)
      db`
        SELECT
          coalesce(pipeline_stage, 'unknown') AS stage,
          count(*)::int AS total,
          count(*) FILTER (WHERE status = 'error')::int AS failed_at_stage
        FROM cc_sessions
        WHERE started_at > now() - make_interval(days => ${days})
        GROUP BY 1 ORDER BY total DESC
      `.then(rows => { analytics.pipelineStages = rows }),

      // Learning effectiveness
      db`
        SELECT
          count(*)::int AS total_learnings,
          count(*) FILTER (WHERE outcome_status = 'verified_effective')::int AS effective,
          count(*) FILTER (WHERE outcome_status = 'verified_ineffective')::int AS ineffective,
          count(*) FILTER (WHERE outcome_status = 'pending')::int AS pending,
          count(*) FILTER (WHERE pattern_type = 'dont_try')::int AS dont_try,
          count(*) FILTER (WHERE absorbed_into IS NOT NULL)::int AS consolidated,
          round(avg(confidence)::numeric, 3) AS avg_learning_confidence
        FROM factory_learnings
      `.then(([r]) => { analytics.learnings = r }),

      // Self-modification stats
      db`
        SELECT
          count(*)::int AS total,
          count(*) FILTER (WHERE status = 'complete')::int AS complete,
          count(*) FILTER (WHERE deploy_status = 'deployed')::int AS deployed,
          round(avg(confidence_score)::numeric, 3) AS avg_confidence
        FROM cc_sessions
        WHERE self_modification = true
          AND started_at > now() - make_interval(days => ${days})
      `.then(([r]) => { analytics.selfModification = r }),

      // Hourly activity heatmap (last 7 days)
      db`
        SELECT
          extract(dow FROM started_at) AS day_of_week,
          extract(hour FROM started_at) AS hour,
          count(*)::int AS sessions
        FROM cc_sessions
        WHERE started_at > now() - interval '7 days'
        GROUP BY 1, 2 ORDER BY 1, 2
      `.then(rows => { analytics.activityHeatmap = rows }),
    ])

    analytics.period = { days, generated_at: new Date().toISOString() }
    res.json(analytics)
  } catch (err) {
    next(err)
  }
})

// ── Factory Review / Approve / Reject — called by Factory MCP server ──

// GET /api/cc/sessions/:id/review
router.get('/sessions/:id/review', async (req, res, next) => {
  try {
    const oversight = require('../services/factoryOversightService')
    const context = await oversight.prepareReviewContext(req.params.id)
    res.json(context)
  } catch (err) { next(err) }
})

// POST /api/cc/sessions/:id/approve
router.post('/sessions/:id/approve', async (req, res, next) => {
  try {
    const oversight = require('../services/factoryOversightService')
    const result = await oversight.runDeployFromOSApproval(req.params.id, {
      notes: req.body?.notes || '',
      confidence: req.body?.confidence ?? null,
      force: req.body?.force === true,
    })
    res.json(result)
  } catch (err) { next(err) }
})

// POST /api/cc/sessions/:id/reject
router.post('/sessions/:id/reject', async (req, res, next) => {
  try {
    const oversight = require('../services/factoryOversightService')
    const result = await oversight.runRejectFromOS(req.params.id, {
      reason: req.body?.reason || 'Rejected by OS session',
    })
    // Optionally re-dispatch with corrected prompt
    if (req.body?.redispatch && req.body?.correctedPrompt) {
      const triggers = require('../services/factoryTriggerService')
      const [original] = await require('../config/db')`SELECT codebase_id, working_dir FROM cc_sessions WHERE id = ${req.params.id}`
      const newSession = await triggers.dispatchFromCortex(req.body.correctedPrompt, {
        codebaseId: original?.codebase_id || null,
        workingDir: original?.working_dir || null,
      })
      return res.json({ ...result, redispatched: true, newSessionId: newSession?.id })
    }
    res.json(result)
  } catch (err) { next(err) }
})

module.exports = router
