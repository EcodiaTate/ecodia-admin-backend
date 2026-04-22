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
      maxSeeds: parseInt(seeds) || 15,
      maxDepth: parseInt(depth) || 5,
      minSimilarity: parseFloat(similarity) || 0.4,
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

// GET /api/kg/search?q=term — search nodes by name (fuzzy)
router.get('/search', async (req, res, next) => {
  try {
    const { q, limit } = req.query
    if (!q) return res.status(400).json({ error: 'Missing query parameter q' })
    const { runQuery } = require('../config/neo4j')
    const maxResults = Math.min(parseInt(limit) || 30, 100)
    const records = await runQuery(
      `MATCH (n)
       WHERE toLower(n.name) CONTAINS toLower($q)
       RETURN n.name AS name, labels(n) AS labels, n.description AS description, n.importance AS importance
       ORDER BY CASE WHEN toLower(n.name) = toLower($q) THEN 0 ELSE 1 END, n.importance DESC
       LIMIT ${maxResults}`,
      { q }
    )
    res.json(records.map(r => ({
      name: r.get('name'),
      labels: r.get('labels') || [],
      description: r.get('description') || null,
      importance: r.get('importance') ?? null,
    })))
  } catch (err) {
    next(err)
  }
})

// GET /api/kg/node/:name/graph?depth=1 — neighborhood as graph data (nodes + edges)
router.get('/node/:name/graph', async (req, res, next) => {
  try {
    const depth = Math.min(parseInt(req.query.depth) || 1, 3)
    const { runQuery } = require('../config/neo4j')

    // Query 1: get center node + neighbors
    const nodeRecords = await runQuery(
      `MATCH (center) WHERE toLower(center.name) = toLower($name)
       OPTIONAL MATCH (center)-[*1..${depth}]-(connected)
       WITH center, collect(DISTINCT connected) AS neighbors
       RETURN center.name AS centerName, labels(center) AS centerLabels,
              center.description AS centerDesc, center.importance AS centerImp,
              [n IN neighbors WHERE n.name IS NOT NULL |
                {name: n.name, labels: labels(n), description: n.description, importance: n.importance}
              ] AS neighbors`,
      { name: req.params.name }
    )

    if (nodeRecords.length === 0) return res.status(404).json({ error: 'Node not found' })

    const rec = nodeRecords[0]
    const nodesMap = new Map()
    nodesMap.set(rec.get('centerName'), {
      name: rec.get('centerName'),
      labels: rec.get('centerLabels') || [],
      description: rec.get('centerDesc') || null,
      importance: rec.get('centerImp') ?? null,
      isCenter: true,
    })
    for (const n of rec.get('neighbors') || []) {
      if (n.name && !nodesMap.has(n.name)) nodesMap.set(n.name, n)
    }

    // Query 2: get edges between all nodes in the set
    const nodeNames = [...nodesMap.keys()]
    const edgeRecords = await runQuery(
      `MATCH (a)-[r]->(b)
       WHERE a.name IN $names AND b.name IN $names
       RETURN DISTINCT a.name AS source, b.name AS target, type(r) AS type`,
      { names: nodeNames }
    )

    const edges = edgeRecords.map(r => ({
      source: r.get('source'),
      target: r.get('target'),
      type: r.get('type'),
    }))

    res.json({
      nodes: [...nodesMap.values()],
      edges,
    })
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

// POST /api/kg/extract-and-write — fire write-time edge extraction for a node
router.post('/extract-and-write', async (req, res, next) => {
  try {
    const { nodeId, minConfidence, force } = req.body
    if (!nodeId) return res.status(400).json({ error: 'Missing nodeId' })
    const { extractAndWrite } = require('../services/neo4jEntityExtractor')
    const result = await extractAndWrite(nodeId, { minConfidence, force })
    res.json(result)
  } catch (err) {
    next(err)
  }
})

module.exports = router
