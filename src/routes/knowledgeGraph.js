const { Router } = require('express')
const auth = require('../middleware/auth')
const kg = require('../services/knowledgeGraphService')

const router = Router()
router.use(auth)

// GET /api/kg/stats — graph overview
router.get('/stats', async (req, res, next) => {
  try {
    const stats = await kg.getGraphStats()
    res.json(stats)
  } catch (err) {
    next(err)
  }
})

// GET /api/kg/context?q=search+query — trace-based context retrieval
router.get('/context', async (req, res, next) => {
  try {
    const { q, seeds, depth, similarity } = req.query
    if (!q) return res.status(400).json({ error: 'Missing query parameter q' })

    const context = await kg.getContext(q, {
      maxSeeds: parseInt(seeds) || 5,
      maxDepth: parseInt(depth) || 3,
      minSimilarity: parseFloat(similarity) || 0.7,
    })
    res.json(context)
  } catch (err) {
    next(err)
  }
})

// GET /api/kg/node/:name — find a specific node
router.get('/node/:name', async (req, res, next) => {
  try {
    const node = await kg.findNode(req.params.name)
    if (!node) return res.status(404).json({ error: 'Node not found' })
    res.json(node)
  } catch (err) {
    next(err)
  }
})

// GET /api/kg/node/:name/neighborhood — get connected nodes
router.get('/node/:name/neighborhood', async (req, res, next) => {
  try {
    const depth = parseInt(req.query.depth) || 1
    const neighbors = await kg.getNodeNeighborhood(req.params.name, { depth })
    res.json(neighbors)
  } catch (err) {
    next(err)
  }
})

// POST /api/kg/embed — manually trigger embedding of stale nodes
router.post('/embed', async (req, res, next) => {
  try {
    const count = await kg.embedStaleNodes(50)
    res.json({ embedded: count })
  } catch (err) {
    next(err)
  }
})

// GET /api/kg/briefing?q=query — AI-narrated briefing from graph context
router.get('/briefing', async (req, res, next) => {
  try {
    const { q } = req.query
    if (!q) return res.status(400).json({ error: 'Missing query parameter q' })

    const context = await kg.getContext(q, { maxSeeds: 5, maxDepth: 3 })
    if (!context.summary) {
      return res.json({ briefing: null, raw: context.summary })
    }

    const deepseekService = require('../services/deepseekService')
    const briefing = await deepseekService.callDeepSeek([
      {
        role: 'user',
        content: `Tate wants to know everything relevant about "${q}". Here's what the knowledge graph has:

${context.summary}

Write a briefing. Present tense, direct prose, specific details — names, dates, decisions, status. Whatever he needs to know.`
      }
    ], { module: 'cortex', skipRetrieval: true, skipLogging: true })

    res.json({ briefing, raw: context.summary })
  } catch (err) {
    next(err)
  }
})

// GET /api/kg/consolidation/stats — consolidation health
router.get('/consolidation/stats', async (req, res, next) => {
  try {
    const consolidation = require('../services/kgConsolidationService')
    const stats = await consolidation.getConsolidationStats()
    res.json(stats)
  } catch (err) {
    next(err)
  }
})

// POST /api/kg/consolidation/run — manually trigger consolidation pipeline
// dryRun=true runs synchronously (fast, no LLM calls)
// Real runs fire-and-forget (too many DeepSeek calls to wait for)
router.post('/consolidation/run', async (req, res, next) => {
  try {
    const dryRun = req.query.dryRun === 'true'
    const consolidation = require('../services/kgConsolidationService')

    if (dryRun) {
      const results = await consolidation.runConsolidationPipeline({ dryRun: true })
      return res.json(results)
    }

    // Fire and forget — return immediately, run in background
    res.json({ status: 'started', message: 'Consolidation pipeline running in background. Check /consolidation/stats for results.' })

    consolidation.runConsolidationPipeline({ dryRun: false }).catch(err => {
      require('../config/logger').error('Background consolidation failed', { error: err.message })
    })
  } catch (err) {
    next(err)
  }
})

// GET /api/kg/health — check Neo4j connection
router.get('/health', async (req, res, next) => {
  try {
    const healthy = await kg.healthCheck()
    res.json({ neo4j: healthy ? 'connected' : 'disconnected' })
  } catch (err) {
    next(err)
  }
})

module.exports = router
