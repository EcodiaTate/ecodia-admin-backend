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
  company: z.string().optional(),
  email: z.string().email().optional(),
  phone: z.string().optional(),
  linkedinUrl: z.string().optional(),
  xeroContactId: z.string().optional(),
  stage: z.enum(STAGES).default('lead'),
  priority: z.enum(['low', 'medium', 'high']).default('medium'),
  tags: z.array(z.string()).default([]),
})

router.post('/clients', validate(createClientSchema), async (req, res, next) => {
  try {
    const b = req.body
    const [client] = await db`
      INSERT INTO clients (name, company, email, phone, linkedin_url, xero_contact_id, stage, priority, tags)
      VALUES (${b.name}, ${b.company || null}, ${b.email || null}, ${b.phone || null},
              ${b.linkedinUrl || null}, ${b.xeroContactId || null}, ${b.stage}, ${b.priority}, ${b.tags})
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
    const [client] = await db`SELECT * FROM clients WHERE id = ${req.params.id}`
    if (!client) return res.status(404).json({ error: 'Client not found' })
    res.json(client)
  } catch (err) {
    next(err)
  }
})

// PATCH /api/crm/clients/:id
router.patch('/clients/:id', async (req, res, next) => {
  try {
    const allowed = ['name', 'company', 'email', 'phone', 'linkedin_url', 'xero_contact_id', 'priority', 'tags', 'meta']
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
      SELECT id, name, company, stage, priority, tags, updated_at
      FROM clients
      WHERE archived_at IS NULL
      ORDER BY updated_at DESC
    `

    const pipeline = {}
    for (const stage of STAGES) {
      pipeline[stage] = clients.filter(c => c.stage === stage)
    }

    res.json(pipeline)
  } catch (err) {
    next(err)
  }
})

// PATCH /api/crm/clients/:id/stage
const stageSchema = z.object({
  stage: z.enum(STAGES),
  note: z.string().optional(),
})

router.patch('/clients/:id/stage', validate(stageSchema), async (req, res, next) => {
  try {
    const [client] = await db`SELECT id, stage FROM clients WHERE id = ${req.params.id}`
    if (!client) return res.status(404).json({ error: 'Client not found' })

    const fromStage = client.stage
    const toStage = req.body.stage

    await db.begin(async sql => {
      await sql`
        UPDATE clients SET stage = ${toStage}, updated_at = now()
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
          content: `CRM client "${fullClient?.name || 'Unknown'}" just moved from "${fromStage}" to "${toStage}".
${req.body.note ? `Note: ${req.body.note}` : ''}

Should any follow-up action be surfaced to the human? Examples: send a congratulations email, schedule a kickoff call, update project documentation, send an invoice, etc.

Respond with JSON only:
{
  "shouldSurface": true or false,
  "actionType": "create_task" or "schedule_meeting" or "send_email" or "follow_up",
  "title": "short action title",
  "summary": "what needs to happen and why",
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

module.exports = router
