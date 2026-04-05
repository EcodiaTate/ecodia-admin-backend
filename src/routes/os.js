/**
 * OS Cortex Routes — /api/os/*
 * Completely separate from /api/cortex/* (organism stream).
 */

const express = require('express')
const router = express.Router()
const osCortex = require('../services/osCortexService')
const { listWorkspaces } = require('../services/osWorkspaceDefinitions')
const db = require('../config/db')

// ── Main execution endpoint ──

router.post('/run', async (req, res, next) => {
  // Set long timeout for multi-turn tasks
  res.setTimeout(300_000)
  try {
    const { taskId, workspace, messages } = req.body
    if (!workspace) return res.status(400).json({ error: 'workspace is required' })
    if (!messages || !messages.length) return res.status(400).json({ error: 'messages is required' })

    const result = await osCortex.runTask(taskId || null, messages, { workspace })
    res.json(result)
  } catch (err) { next(err) }
})

// ── Workspaces ──

router.get('/workspaces', (_req, res) => {
  res.json({ workspaces: listWorkspaces() })
})

// ── Task Sessions ──

router.get('/tasks', async (req, res, next) => {
  try {
    const { workspace, status } = req.query
    let rows
    if (workspace && status) {
      rows = await db`SELECT id, workspace, title, status, created_at, updated_at
        FROM os_task_sessions WHERE workspace = ${workspace} AND status = ${status}
        ORDER BY updated_at DESC LIMIT 20`
    } else if (workspace) {
      rows = await db`SELECT id, workspace, title, status, created_at, updated_at
        FROM os_task_sessions WHERE workspace = ${workspace}
        ORDER BY updated_at DESC LIMIT 20`
    } else {
      rows = await db`SELECT id, workspace, title, status, created_at, updated_at
        FROM os_task_sessions ORDER BY updated_at DESC LIMIT 20`
    }
    res.json({ tasks: rows })
  } catch (err) { next(err) }
})

router.get('/tasks/:id', async (req, res, next) => {
  try {
    const session = await osCortex.loadTaskSession(req.params.id)
    if (!session) return res.status(404).json({ error: 'Task not found' })
    res.json({ task: session })
  } catch (err) { next(err) }
})

// ── Docs ──

router.get('/docs', async (req, res, next) => {
  try {
    const { workspace } = req.query
    const rows = workspace
      ? await db`SELECT id, key, title, workspace, updated_by, updated_at FROM os_docs WHERE workspace = ${workspace} OR workspace IS NULL ORDER BY key`
      : await db`SELECT id, key, title, workspace, updated_by, updated_at FROM os_docs ORDER BY key`
    res.json({ docs: rows })
  } catch (err) { next(err) }
})

router.get('/docs/:key', async (req, res, next) => {
  try {
    const doc = await osCortex.getDoc(req.params.key)
    if (!doc) return res.status(404).json({ error: 'Doc not found' })
    res.json({ doc })
  } catch (err) { next(err) }
})

router.put('/docs/:key', express.json(), async (req, res, next) => {
  try {
    const { title, content, workspace } = req.body
    if (!title || content === undefined) return res.status(400).json({ error: 'title and content required' })
    await osCortex.upsertDoc(req.params.key, title, content, workspace || null, 'human')
    res.json({ status: 'ok' })
  } catch (err) { next(err) }
})

// ── Core Context ──

router.get('/context', async (_req, res, next) => {
  try {
    const facts = await osCortex.getCoreContext()
    res.json({ facts })
  } catch (err) { next(err) }
})

router.put('/context', express.json(), async (req, res, next) => {
  try {
    const { key, value } = req.body
    if (!key || value === undefined) return res.status(400).json({ error: 'key and value required' })
    await osCortex.updateCoreContextFact(key, value)
    res.json({ status: 'ok' })
  } catch (err) { next(err) }
})

module.exports = router
