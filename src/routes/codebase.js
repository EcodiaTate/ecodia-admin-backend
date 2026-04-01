const { Router } = require('express')
const { z } = require('zod')
const db = require('../config/db')
const auth = require('../middleware/auth')
const codebaseIntelligence = require('../services/codebaseIntelligenceService')

const router = Router()
router.use(auth)

// ─── List Codebases ─────────────────────────────────────────────────

router.get('/', async (_req, res, next) => {
  try {
    const codebases = await db`
      SELECT c.*,
        (SELECT count(*)::int FROM code_chunks WHERE codebase_id = c.id) AS chunk_count,
        (SELECT count(DISTINCT file_path)::int FROM code_chunks WHERE codebase_id = c.id) AS file_count
      FROM codebases c
      ORDER BY c.name
    `
    res.json(codebases)
  } catch (err) { next(err) }
})

// ─── Register Codebase ──────────────────────────────────────────────

const createSchema = z.object({
  name: z.string().min(1).max(100),
  repoUrl: z.string().optional(),
  repoPath: z.string().min(1),
  mirrorPath: z.string().optional(),
  language: z.string().optional(),
  projectId: z.string().uuid().optional(),
})

router.post('/', async (req, res, next) => {
  try {
    const data = createSchema.parse(req.body)
    const [codebase] = await db`
      INSERT INTO codebases (name, repo_url, repo_path, mirror_path, language, project_id)
      VALUES (${data.name}, ${data.repoUrl || null}, ${data.repoPath}, ${data.mirrorPath || null}, ${data.language || null}, ${data.projectId || null})
      RETURNING *
    `
    res.status(201).json(codebase)
  } catch (err) { next(err) }
})

// ─── Get Codebase Details ───────────────────────────────────────────

router.get('/:id', async (req, res, next) => {
  try {
    const [codebase] = await db`SELECT * FROM codebases WHERE id = ${req.params.id}`
    if (!codebase) return res.status(404).json({ error: 'Codebase not found' })

    const stats = await codebaseIntelligence.getCodebaseStats(req.params.id)
    res.json({ ...codebase, stats })
  } catch (err) { next(err) }
})

// ─── Trigger Manual Index ───────────────────────────────────────────

router.post('/:id/index', async (req, res, next) => {
  try {
    const [codebase] = await db`SELECT * FROM codebases WHERE id = ${req.params.id}`
    if (!codebase) return res.status(404).json({ error: 'Codebase not found' })

    // Sync + index + embed (fire-and-forget for large codebases)
    const sync = req.query.sync !== 'false'
    if (sync) {
      await codebaseIntelligence.syncCodebase(req.params.id)
    }

    const result = await codebaseIntelligence.indexCodebase(req.params.id)

    // Embed stale chunks for this codebase
    const embedded = await codebaseIntelligence.embedStaleChunks(50)

    res.json({ ...result, embedded })
  } catch (err) { next(err) }
})

// ─── Semantic Code Search (single codebase) ─────────────────────────

const querySchema = z.object({
  query: z.string().min(1).max(2000),
  limit: z.number().int().min(1).max(50).optional().default(20),
})

router.post('/:id/query', async (req, res, next) => {
  try {
    const data = querySchema.parse(req.body)
    const results = await codebaseIntelligence.queryCodebase(req.params.id, data.query, { limit: data.limit })
    res.json(results)
  } catch (err) { next(err) }
})

// ─── Cross-Codebase Search ──────────────────────────────────────────

router.post('/query', async (req, res, next) => {
  try {
    const data = querySchema.parse(req.body)
    const results = await codebaseIntelligence.queryAllCodebases(data.query, { limit: data.limit })
    res.json(results)
  } catch (err) { next(err) }
})

// ─── File Tree ──────────────────────────────────────────────────────

router.get('/:id/structure', async (req, res, next) => {
  try {
    const structure = await codebaseIntelligence.getCodebaseStructure(req.params.id)
    res.json(structure)
  } catch (err) { next(err) }
})

module.exports = router
