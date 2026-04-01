const { Router } = require('express')
const { z } = require('zod')
const auth = require('../middleware/auth')
const validate = require('../middleware/validate')
const db = require('../config/db')

const router = Router()
router.use(auth)

// GET /api/tasks
router.get('/', async (req, res, next) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 50, 200)
    const offset = parseInt(req.query.offset) || 0
    const status = req.query.status
    const clientId = req.query.clientId

    const tasks = await db`
      SELECT t.*, c.name AS client_name, p.name AS project_name
      FROM tasks t
      LEFT JOIN clients c ON t.client_id = c.id
      LEFT JOIN projects p ON t.project_id = p.id
      WHERE 1=1
        ${status ? db`AND t.status = ${status}` : db``}
        ${clientId ? db`AND t.client_id = ${clientId}` : db``}
      ORDER BY
        CASE t.priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END,
        t.created_at DESC
      LIMIT ${limit} OFFSET ${offset}
    `

    const [{ count }] = await db`
      SELECT count(*)::int FROM tasks
      WHERE 1=1
        ${status ? db`AND status = ${status}` : db``}
        ${clientId ? db`AND client_id = ${clientId}` : db``}
    `

    res.json({ tasks, total: count })
  } catch (err) {
    next(err)
  }
})

// POST /api/tasks
const createTaskSchema = z.object({
  title: z.string().min(1),
  description: z.string().optional(),
  source: z.enum(['gmail', 'linkedin', 'crm', 'manual', 'cc']).default('manual'),
  sourceRefId: z.string().optional(),
  clientId: z.string().uuid().optional(),
  projectId: z.string().uuid().optional(),
  priority: z.enum(['low', 'medium', 'high', 'urgent']).default('medium'),
  dueDate: z.string().optional(),
})

router.post('/', validate(createTaskSchema), async (req, res, next) => {
  try {
    const b = req.body
    const [task] = await db`
      INSERT INTO tasks (title, description, source, source_ref_id, client_id, project_id, priority, due_date)
      VALUES (${b.title}, ${b.description || null}, ${b.source}, ${b.sourceRefId || null},
              ${b.clientId || null}, ${b.projectId || null}, ${b.priority}, ${b.dueDate || null})
      RETURNING *
    `
    res.status(201).json(task)
  } catch (err) {
    next(err)
  }
})

// PATCH /api/tasks/:id
router.patch('/:id', async (req, res, next) => {
  try {
    const allowed = ['title', 'description', 'priority', 'status', 'due_date', 'client_id', 'project_id']
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
      UPDATE tasks SET ${db(updates, ...Object.keys(updates))}, updated_at = now()
      WHERE id = ${req.params.id}
      RETURNING *
    `
    if (!updated) return res.status(404).json({ error: 'Task not found' })
    res.json(updated)
  } catch (err) {
    next(err)
  }
})

// DELETE /api/tasks/:id
router.delete('/:id', async (req, res, next) => {
  try {
    const [deleted] = await db`DELETE FROM tasks WHERE id = ${req.params.id} RETURNING id`
    if (!deleted) return res.status(404).json({ error: 'Task not found' })
    res.json({ status: 'deleted' })
  } catch (err) {
    next(err)
  }
})

module.exports = router
