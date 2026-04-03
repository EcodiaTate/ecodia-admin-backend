const { Router } = require('express')
const auth = require('../middleware/auth')
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

module.exports = router
