const { Router } = require('express')
const { z } = require('zod')
const auth = require('../middleware/auth')
const validate = require('../middleware/validate')
const db = require('../config/db')
const { broadcast } = require('../websocket/wsManager')
const kgHooks = require('../services/kgIngestionHooks')
const logger = require('../config/logger')

const router = Router()
router.use(auth)

const STAGES = ['lead', 'proposal', 'contract', 'development', 'live', 'ongoing', 'archived']

// GET /api/crm/clients
router.get('/clients', async (req, res, next) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 50, 200)
    const offset = parseInt(req.query.offset) || 0

    const clients = await db`
      SELECT * FROM clients
      WHERE archived_at IS NULL
      ORDER BY updated_at DESC
      LIMIT ${limit} OFFSET ${offset}
    `

    const [{ count }] = await db`
      SELECT count(*)::int FROM clients WHERE archived_at IS NULL
    `

    res.json({ clients, total: count })
  } catch (err) {
    next(err)
  }
})

// POST /api/crm/clients
const createClientSchema = z.object({
  name: z.string().min(1),
  contactName: z.string().optional(),
  contactEmail: z.string().email().optional(),
  contactPhone: z.string().optional(),
  status: z.enum(STAGES).default('lead'),
  source: z.string().optional(),
  tags: z.array(z.string()).default([]),
})

router.post('/clients', validate(createClientSchema), async (req, res, next) => {
  try {
    const b = req.body
    const [client] = await db`
      INSERT INTO clients (name, contact_name, contact_email, contact_phone, status, source, tags)
      VALUES (${b.name}, ${b.contactName || null}, ${b.contactEmail || null}, ${b.contactPhone || null},
              ${b.status}, ${b.source || null}, ${b.tags})
      RETURNING *
    `

    // Fire-and-forget KG ingestion
    kgHooks.onClientUpdated({ client }).catch(() => {})

    res.status(201).json(client)
  } catch (err) {
    next(err)
  }
})

// GET /api/crm/clients/:id
router.get('/clients/:id', async (req, res, next) => {
  try {
    const [client] = await db`
      SELECT c.*,
        (SELECT count(*)::int FROM email_threads WHERE client_id = c.id) AS email_count,
        (SELECT count(*)::int FROM tasks WHERE client_id = c.id AND completed_at IS NULL) AS open_tasks,
        (SELECT count(*)::int FROM cc_sessions WHERE client_id = c.id) AS total_sessions,
        (SELECT count(*)::int FROM projects WHERE client_id = c.id AND status = 'active') AS active_projects
      FROM clients c WHERE c.id = ${req.params.id}
    `
    if (!client) return res.status(404).json({ error: 'Client not found' })
    res.json(client)
  } catch (err) {
    next(err)
  }
})

// PATCH /api/crm/clients/:id
router.patch('/clients/:id', async (req, res, next) => {
  try {
    const allowed = ['name', 'contact_name', 'contact_email', 'contact_phone', 'tags', 'source', 'notes', 'email_domains']
    const updates = {}
    for (const key of allowed) {
      const camel = key.replace(/_([a-z])/g, (_, c) => c.toUpperCase())
      if (req.body[camel] !== undefined) updates[key] = req.body[camel]
      if (req.body[key] !== undefined) updates[key] = req.body[key]
    }

    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ error: 'No valid fields to update' })
    }

    const [updated] = await db`
      UPDATE clients SET ${db(updates, ...Object.keys(updates))}, updated_at = now()
      WHERE id = ${req.params.id}
      RETURNING *
    `
    if (!updated) return res.status(404).json({ error: 'Client not found' })
    res.json(updated)
  } catch (err) {
    next(err)
  }
})

// DELETE /api/crm/clients/:id (soft-delete)
router.delete('/clients/:id', async (req, res, next) => {
  try {
    const [archived] = await db`
      UPDATE clients SET archived_at = now(), updated_at = now()
      WHERE id = ${req.params.id} AND archived_at IS NULL
      RETURNING id
    `
    if (!archived) return res.status(404).json({ error: 'Client not found' })
    res.json({ status: 'archived' })
  } catch (err) {
    next(err)
  }
})

// GET /api/crm/pipeline
router.get('/pipeline', async (req, res, next) => {
  try {
    const clients = await db`
      SELECT c.id, c.name, c.contact_name, c.contact_email, c.status, c.tags,
             c.source, c.health_score, c.total_revenue_aud, c.last_contact_at,
             c.updated_at, c.created_at,
             (SELECT count(*)::int FROM tasks WHERE client_id = c.id AND completed_at IS NULL) AS open_tasks,
             (SELECT count(*)::int FROM projects WHERE client_id = c.id AND status = 'active') AS active_projects,
             (SELECT COALESCE(SUM(deal_value_aud), 0) FROM projects WHERE client_id = c.id AND deal_value_aud IS NOT NULL) AS pipeline_value
      FROM clients c
      WHERE c.archived_at IS NULL
      ORDER BY c.updated_at DESC
    `

    const pipeline = {}
    for (const stage of STAGES) {
      pipeline[stage] = clients.filter(c => c.status === stage)
    }

    res.json(pipeline)
  } catch (err) {
    next(err)
  }
})

// PATCH /api/crm/clients/:id/status
const statusSchema = z.object({
  status: z.enum(STAGES),
  note: z.string().optional(),
})

router.patch('/clients/:id/status', validate(statusSchema), async (req, res, next) => {
  try {
    const [client] = await db`SELECT id, status FROM clients WHERE id = ${req.params.id}`
    if (!client) return res.status(404).json({ error: 'Client not found' })

    const fromStage = client.status
    const toStage = req.body.status

    await db.begin(async sql => {
      await sql`
        UPDATE clients SET status = ${toStage}, updated_at = now()
        WHERE id = ${req.params.id}
      `
      await sql`
        INSERT INTO pipeline_events (client_id, from_stage, to_stage, note)
        VALUES (${req.params.id}, ${fromStage}, ${toStage}, ${req.body.note || null})
      `
    })

    broadcast('notification', {
      payload: {
        type: 'crm',
        message: `Client moved from ${fromStage} to ${toStage}`,
        link: `/crm/${req.params.id}`,
      },
    })

    // Fire-and-forget: KG ingestion for stage change
    const [fullClient] = await db`SELECT * FROM clients WHERE id = ${req.params.id}`
    if (fullClient) {
      kgHooks.onClientUpdated({ client: fullClient, previousStage: fromStage }).catch(() => {})
    }

    // Fire-and-forget: AI-driven CRM stage automation (CC sessions, follow-up actions)
    const triggers = require('../services/factoryTriggerService')
    triggers.dispatchFromCRM({
      clientId: req.params.id,
      previousStage: fromStage,
      newStage: toStage,
      clientName: fullClient?.name,
    }).catch(err => logger.debug('CRM dispatch failed (non-blocking)', { error: err.message }))

    // Fire-and-forget: Enqueue follow-up action for AI to decide
    const actionQueue = require('../services/actionQueueService')
    const deepseekService = require('../services/deepseekService')
    ;(async () => {
      try {
        const response = await deepseekService.callDeepSeek([{
          role: 'user',
          content: `"${fullClient?.name || 'Unknown'}" moved from "${fromStage}" to "${toStage}".${req.body.note ? `\nNote: ${req.body.note}` : ''}

Is there a follow-up action worth surfacing?

Respond as JSON:
{
  "shouldSurface": true/false,
  "actionType": "create_task|schedule_meeting|send_email|follow_up",
  "title": "action title",
  "summary": "what and why",
  "priority": "low|medium|high"
}`
        }], { module: 'crm', skipRetrieval: true })

        const parsed = JSON.parse(response.replace(/```json?\s*/g, '').replace(/```/g, '').trim())
        if (parsed.shouldSurface) {
          await actionQueue.enqueue({
            source: 'crm',
            sourceRefId: req.params.id,
            actionType: parsed.actionType || 'follow_up',
            title: parsed.title,
            summary: parsed.summary,
            preparedData: { clientName: fullClient?.name, fromStage, toStage, note: req.body.note },
            context: { clientId: req.params.id, fromStage, toStage },
            priority: parsed.priority || 'medium',
          })
        }
      } catch (err) {
        logger.debug('CRM stage action queue failed (non-blocking)', { error: err.message })
      }
    })()

    res.json({ status: 'ok', from: fromStage, to: toStage })
  } catch (err) {
    next(err)
  }
})

// POST /api/crm/clients/:id/notes
const noteSchema = z.object({
  content: z.string().min(1),
  source: z.string().default('manual'),
})

router.post('/clients/:id/notes', validate(noteSchema), async (req, res, next) => {
  try {
    const [client] = await db`SELECT id, notes FROM clients WHERE id = ${req.params.id}`
    if (!client) return res.status(404).json({ error: 'Client not found' })

    const notes = [...(client.notes || []), {
      content: req.body.content,
      source: req.body.source,
      createdAt: new Date().toISOString(),
    }]

    const [updated] = await db`
      UPDATE clients SET notes = ${JSON.stringify(notes)}, updated_at = now()
      WHERE id = ${req.params.id}
      RETURNING *
    `
    res.json(updated)
  } catch (err) {
    next(err)
  }
})

// GET /api/crm/clients/:id/projects
router.get('/clients/:id/projects', async (req, res, next) => {
  try {
    const projects = await db`
      SELECT * FROM projects
      WHERE client_id = ${req.params.id} AND archived_at IS NULL
      ORDER BY created_at DESC
    `
    res.json(projects)
  } catch (err) {
    next(err)
  }
})

// POST /api/crm/projects
const createProjectSchema = z.object({
  clientId: z.string().uuid(),
  name: z.string().min(1),
  description: z.string().optional(),
  repoPath: z.string().optional(),
  repoUrl: z.string().optional(),
  techStack: z.array(z.string()).default([]),
  budgetAud: z.number().optional(),
  hourlyRate: z.number().optional(),
})

router.post('/projects', validate(createProjectSchema), async (req, res, next) => {
  try {
    const b = req.body
    const [project] = await db`
      INSERT INTO projects (client_id, name, description, repo_path, repo_url, tech_stack, budget_aud, hourly_rate)
      VALUES (${b.clientId}, ${b.name}, ${b.description || null}, ${b.repoPath || null},
              ${b.repoUrl || null}, ${b.techStack}, ${b.budgetAud || null}, ${b.hourlyRate || null})
      RETURNING *
    `

    // Fire-and-forget KG ingestion
    const [ownerClient] = await db`SELECT name FROM clients WHERE id = ${b.clientId}`
    kgHooks.onProjectCreated({ project, clientName: ownerClient?.name }).catch(() => {})

    res.status(201).json(project)
  } catch (err) {
    next(err)
  }
})

// GET /api/crm/projects/:id
router.get('/projects/:id', async (req, res, next) => {
  try {
    const [project] = await db`SELECT * FROM projects WHERE id = ${req.params.id}`
    if (!project) return res.status(404).json({ error: 'Project not found' })
    res.json(project)
  } catch (err) {
    next(err)
  }
})

// PATCH /api/crm/projects/:id
router.patch('/projects/:id', async (req, res, next) => {
  try {
    const allowed = ['name', 'description', 'status', 'repo_path', 'repo_url', 'tech_stack', 'budget_aud', 'hourly_rate', 'meta']
    const updates = {}
    for (const key of allowed) {
      const camel = key.replace(/_([a-z])/g, (_, c) => c.toUpperCase())
      if (req.body[camel] !== undefined) updates[key] = req.body[camel]
      if (req.body[key] !== undefined) updates[key] = req.body[key]
    }

    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ error: 'No valid fields to update' })
    }

    const [updated] = await db`
      UPDATE projects SET ${db(updates, ...Object.keys(updates))}, updated_at = now()
      WHERE id = ${req.params.id}
      RETURNING *
    `
    if (!updated) return res.status(404).json({ error: 'Project not found' })
    res.json(updated)
  } catch (err) {
    next(err)
  }
})

// GET /api/crm/clients/:id/sessions — CC sessions for a client (coding workspace integration)
router.get('/clients/:id/sessions', async (req, res, next) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 20, 100)
    const sessions = await db`
      SELECT cs.id, cs.initial_prompt, cs.status, cs.pipeline_stage,
             cs.confidence_score, cs.triggered_by, cs.trigger_source,
             cs.started_at, cs.completed_at, cs.error_message,
             cb.name AS codebase_name, p.name AS project_name
      FROM cc_sessions cs
      LEFT JOIN codebases cb ON cs.codebase_id = cb.id
      LEFT JOIN projects p ON cs.project_id = p.id
      WHERE cs.client_id = ${req.params.id}
      ORDER BY cs.started_at DESC
      LIMIT ${limit}
    `
    // Also fetch code requests for this client
    const codeRequests = await db`
      SELECT id, source, summary, code_work_type, status, confidence, session_id, created_at
      FROM code_requests
      WHERE client_id = ${req.params.id}
      ORDER BY created_at DESC
      LIMIT ${limit}
    `
    res.json({ sessions, codeRequests })
  } catch (err) { next(err) }
})

// GET /api/crm/clients/:id/coding-summary — Quick summary for CRM UI
router.get('/clients/:id/coding-summary', async (req, res, next) => {
  try {
    const [stats] = await db`
      SELECT
        count(*) FILTER (WHERE status IN ('running', 'initializing'))::int AS active_sessions,
        count(*) FILTER (WHERE status = 'complete' AND completed_at > now() - interval '30 days')::int AS completed_30d,
        count(*) FILTER (WHERE status = 'error' AND started_at > now() - interval '30 days')::int AS errors_30d
      FROM cc_sessions WHERE client_id = ${req.params.id}
    `
    const [requests] = await db`
      SELECT
        count(*) FILTER (WHERE status = 'pending')::int AS pending,
        count(*) FILTER (WHERE status = 'dispatched')::int AS active,
        count(*) FILTER (WHERE status = 'completed')::int AS completed
      FROM code_requests WHERE client_id = ${req.params.id}
    `
    res.json({ sessions: stats, codeRequests: requests })
  } catch (err) { next(err) }
})

// ─── Activity Timeline ──────────────────────────────────────────────

router.get('/clients/:id/timeline', async (req, res, next) => {
  try {
    const crmService = require('../services/crmService')
    const limit = Math.min(parseInt(req.query.limit) || 50, 200)
    const offset = Math.max(parseInt(req.query.offset) || 0, 0)
    const types = req.query.types ? req.query.types.split(',') : undefined
    const result = await crmService.getClientTimeline(req.params.id, { limit, offset, types })
    res.json(result)
  } catch (err) { next(err) }
})

// ─── Client Intelligence ────────────────────────────────────────────

router.get('/clients/:id/intelligence', async (req, res, next) => {
  try {
    const crmService = require('../services/crmService')
    const intel = await crmService.getClientIntelligence(req.params.id)
    if (!intel) return res.status(404).json({ error: 'Client not found' })
    res.json(intel)
  } catch (err) { next(err) }
})

// ─── Contacts ───────────────────────────────────────────────────────

router.get('/clients/:id/contacts', async (req, res, next) => {
  try {
    const crmService = require('../services/crmService')
    const contacts = await crmService.getContacts(req.params.id)
    res.json(contacts)
  } catch (err) { next(err) }
})

router.post('/clients/:id/contacts', async (req, res, next) => {
  try {
    const crmService = require('../services/crmService')
    const contact = await crmService.addContact({ clientId: req.params.id, ...req.body })
    res.status(201).json(contact)
  } catch (err) { next(err) }
})

// ─── Tasks ──────────────────────────────────────────────────────────

router.get('/clients/:id/tasks', async (req, res, next) => {
  try {
    const crmService = require('../services/crmService')
    const includeCompleted = req.query.includeCompleted === 'true'
    const tasks = await crmService.getClientTasks(req.params.id, { includeCompleted })
    res.json(tasks)
  } catch (err) { next(err) }
})

router.post('/tasks/:id/complete', async (req, res, next) => {
  try {
    const crmService = require('../services/crmService')
    const task = await crmService.completeTask(req.params.id, 'human')
    if (!task) return res.status(404).json({ error: 'Task not found or already completed' })
    res.json(task)
  } catch (err) { next(err) }
})

// ─── Search ─────────────────────────────────────────────────────────

router.get('/search', async (req, res, next) => {
  try {
    const crmService = require('../services/crmService')
    const results = await crmService.searchClients(req.query.q)
    res.json({ results })
  } catch (err) { next(err) }
})

// ─── Pipeline Analytics ─────────────────────────────────────────────

router.get('/analytics', async (req, res, next) => {
  try {
    const crmService = require('../services/crmService')
    res.json(await crmService.getPipelineAnalytics())
  } catch (err) { next(err) }
})

// ─── Revenue ────────────────────────────────────────────────────────

router.get('/revenue', async (req, res, next) => {
  try {
    const crmService = require('../services/crmService')
    res.json(await crmService.getRevenueOverview({ clientId: req.query.clientId }))
  } catch (err) { next(err) }
})

// ─── CRM Dashboard ─────────────────────────────────────────────────

router.get('/dashboard', async (req, res, next) => {
  try {
    const db = require('../config/db')
    const crmService = require('../services/crmService')

    const pipeline = await crmService.getPipelineAnalytics()
    const revenue = await crmService.getRevenueOverview()

    const [taskStats] = await db`
      SELECT
        count(*) FILTER (WHERE completed_at IS NULL)::int AS open,
        count(*) FILTER (WHERE completed_at IS NULL AND due_date < now())::int AS overdue,
        count(*) FILTER (WHERE completed_at IS NULL AND priority IN ('urgent','high'))::int AS high_priority
      FROM tasks
    `

    const recentActivity = await db`
      SELECT al.*, c.name AS client_name
      FROM crm_activity_log al
      JOIN clients c ON al.client_id = c.id
      ORDER BY al.created_at DESC LIMIT 15
    `

    res.json({ pipeline, revenue, taskStats, recentActivity })
  } catch (err) { next(err) }
})

module.exports = router
