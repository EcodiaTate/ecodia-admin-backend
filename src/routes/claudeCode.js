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

    const sessions = await db`
      SELECT cs.*, p.name AS project_name, c.name AS client_name
      FROM cc_sessions cs
      LEFT JOIN projects p ON cs.project_id = p.id
      LEFT JOIN clients c ON cs.client_id = c.id
      WHERE 1=1
        ${status ? db`AND cs.status = ${status}` : db``}
      ORDER BY cs.started_at DESC
      LIMIT ${limit} OFFSET ${offset}
    `

    const [{ count }] = await db`
      SELECT count(*)::int FROM cc_sessions
      WHERE 1=1
        ${status ? db`AND status = ${status}` : db``}
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
  triggeredBy: z.enum(['crm_stage', 'manual', 'task', 'simula', 'thymos', 'scheduled', 'cortex']).default('manual'),
  triggerRefId: z.string().optional(),
  triggerSource: z.enum(['manual', 'crm_stage', 'kg_insight', 'simula_proposal', 'thymos_incident', 'scheduled', 'cortex']).optional(),
  initialPrompt: z.string().min(1),
  workingDir: z.string().optional(),
})

router.post('/sessions', validate(createSessionSchema), async (req, res, next) => {
  try {
    const b = req.body
    const { resolveCodebase } = require('../services/factoryTriggerService')

    const codebaseId = await resolveCodebase({
      codebaseId: b.codebaseId,
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

module.exports = router
