const { runQuery, runWrite, healthCheck } = require('../config/neo4j')
const logger = require('../config/logger')
const env = require('../config/env')
const axios = require('axios')

// ═══════════════════════════════════════════════════════════════════════
// KNOWLEDGE GRAPH SERVICE
//
// Open-schema knowledge graph. No predefined entity types or relationship
// types. The LLM decides what to create. Every node gets embedded for
// semantic retrieval. Trace-based traversal follows causal chains.
// ═══════════════════════════════════════════════════════════════════════

// ─── Ingestion Throttle Gate ─────────────────────────────────────────
// Prevents duplicate LLM ingestion of the same sourceId within a time window,
// and caps total LLM ingestion calls per minute to prevent runaway costs.

const _recentIngestions = new Map() // sourceId → timestamp
const INGESTION_DEDUP_WINDOW_MS = parseInt(env.KG_INGESTION_DEDUP_WINDOW_MS || '600000')
const INGESTION_RATE_WINDOW_MS = 60 * 1000 // 1 min
let _ingestionTimestamps = [] // ring buffer of recent ingestion timestamps
const MAX_INGESTIONS_PER_MINUTE = parseInt(env.KG_MAX_INGESTIONS_PER_MIN || '0', 10)  // 0 = unlimited

function shouldThrottleIngestion(sourceId) {
  const now = Date.now()

  // Dedup: skip if same sourceId was ingested recently
  if (sourceId) {
    const lastIngested = _recentIngestions.get(sourceId)
    if (lastIngested && now - lastIngested < INGESTION_DEDUP_WINDOW_MS) {
      return true
    }
  }

  // Rate limit: skip if too many ingestions in the last minute (0 = unlimited)
  if (MAX_INGESTIONS_PER_MINUTE > 0) {
    _ingestionTimestamps = _ingestionTimestamps.filter(t => now - t < INGESTION_RATE_WINDOW_MS)
    if (_ingestionTimestamps.length >= MAX_INGESTIONS_PER_MINUTE) {
      return true
    }
  }

  return false
}

function recordIngestion(sourceId) {
  const now = Date.now()
  if (sourceId) _recentIngestions.set(sourceId, now)
  _ingestionTimestamps.push(now)

  // GC the dedup map periodically
  const dedupMapSize = parseInt(env.KG_INGESTION_DEDUP_MAP_SIZE || '500')
  if (_recentIngestions.size > dedupMapSize) {
    const cutoff = now - INGESTION_DEDUP_WINDOW_MS
    for (const [key, ts] of _recentIngestions) {
      if (ts < cutoff) _recentIngestions.delete(key)
    }
  }
}

// ─── Node Operations ─────────────────────────────────────────────────

async function ensureNode({ label, name, properties = {}, sourceModule, sourceId }) {
  const props = {
    ...properties,
    name,
    source_module: sourceModule || null,
    source_id: sourceId || null,
    updated_at: new Date().toISOString(),
  }

  // Merge on name + label — if same name and label exists, update properties
  const records = await runWrite(
    `MERGE (n:\`${sanitizeLabel(label)}\` {name: $name})
     ON CREATE SET n += $props, n.created_at = datetime(), n.embedding_stale = true
     ON MATCH SET n += $props, n.updated_at = datetime(), n.embedding_stale = true
     RETURN n`,
    { name, props }
  )

  return records[0]?.get('n')?.properties
}

async function ensureRelationship({ fromLabel, fromName, toLabel, toName, relType, properties = {}, sourceModule }) {
  const props = {
    ...properties,
    source_module: sourceModule || null,
    created_at: new Date().toISOString(),
  }

  const records = await runWrite(
    `MERGE (a:\`${sanitizeLabel(fromLabel)}\` {name: $fromName})
     ON CREATE SET a.created_at = datetime(), a.embedding_stale = true
     MERGE (b:\`${sanitizeLabel(toLabel)}\` {name: $toName})
     ON CREATE SET b.created_at = datetime(), b.embedding_stale = true
     MERGE (a)-[r:\`${sanitizeLabel(relType)}\`]->(b)
     ON CREATE SET r += $props
     ON MATCH SET r += $props
     RETURN a, r, b`,
    { fromName, toName, props }
  )

  return records[0] ? {
    from: records[0].get('a')?.properties,
    rel: records[0].get('r')?.properties,
    to: records[0].get('b')?.properties,
  } : null
}

// ─── LLM-Driven Ingestion ────────────────────────────────────────────

async function ingestFromLLM(content, { sourceModule, sourceId, context = '' }) {
  if (!env.DEEPSEEK_API_KEY) {
    logger.warn('KG ingestion skipped — no DeepSeek API key')
    return
  }

  // Throttle: skip duplicate sourceIds and enforce rate limit
  if (shouldThrottleIngestion(sourceId)) {
    logger.debug(`KG ingestion throttled for ${sourceModule}/${sourceId}`)
    return
  }

  // Fetch existing nodes that might overlap — gives the LLM awareness of what's
  // already in the graph so it reuses existing entity names instead of creating duplicates.
  let existingContext = ''
  try {
    const words = content.split(/\s+/).filter(w => w.length > 3).slice(0, 4)
    if (words.length > 0) {
      const whereClauses = words.map((_, i) => `toLower(n.name) CONTAINS toLower($w${i})`).join(' OR ')
      const params = {}
      words.forEach((w, i) => { params[`w${i}`] = w })
      const existing = await runQuery(
        `MATCH (n) WHERE ${whereClauses}
         RETURN n.name AS name, labels(n) AS labels
         LIMIT 10`,
        params
      ).catch(() => [])
      if (existing.length > 0) {
        existingContext = '\n\nExisting entities already in the graph (reuse these exact names when referring to the same entity — do NOT create duplicates):\n' +
          existing.map(r => `- ${r.get('name')} [${(r.get('labels') || []).join(', ')}]`).join('\n')
      }
    }
  } catch {}

  const prompt = `Extract a knowledge graph from this content.

Source: ${sourceModule}
${context ? `Context: ${context}` : ''}

Content:
${content.slice(0, 3000)}${existingContext}

Pull out every meaningful entity and every relationship between them — people, orgs, projects, concepts, events, decisions, problems, tools. Capture causal chains, temporal sequences, and implicit connections.

Relationship types matter: use descriptive verbs that capture what's actually happening. "IS_PIVOTING_TOWARDS", "BLOCKED_BY", "FRUSTRATED_WITH" — not "RELATED_TO". Capture sentiment and intent when present. Include temporal context in properties when available.

Respond as JSON:
{
  "nodes": [
    {"label": "Person", "name": "Tom Grote", "properties": {"role": "co-founder", "company": "Goodreach"}},
    {"label": "Concept", "name": "AI consultant model", "properties": {"description": "..."}}
  ],
  "relationships": [
    {"from_label": "Person", "from_name": "Tom Grote", "rel_type": "PROPOSED", "to_label": "Concept", "to_name": "AI consultant model", "properties": {"context": "during strategy session", "when": "Mar 31 2026"}},
    {"from_label": "Concept", "from_name": "AI consultant model", "rel_type": "REPLACES", "to_label": "Concept", "to_name": "SaaS platform model", "properties": {"reason": "NFPs can't afford subscription pricing"}}
  ]
}`

  try {
    const deepseekService = require('./deepseekService')
    const response = await deepseekService.callDeepSeek(
      [{ role: 'user', content: prompt }],
      { module: 'knowledge_graph', skipRetrieval: true, skipLogging: true }
    )

    const parsed = parseJSON(response)

    // Write all nodes
    for (const node of (parsed.nodes || [])) {
      await ensureNode({
        label: node.label,
        name: node.name,
        properties: node.properties || {},
        sourceModule,
        sourceId,
      }).catch(err => logger.warn(`KG node failed: ${node.name}`, { error: err.message }))
    }

    // Write all relationships
    for (const rel of (parsed.relationships || [])) {
      await ensureRelationship({
        fromLabel: rel.from_label,
        fromName: rel.from_name,
        toLabel: rel.to_label,
        toName: rel.to_name,
        relType: rel.rel_type,
        properties: rel.properties || {},
        sourceModule,
      }).catch(err => logger.warn(`KG rel failed: ${rel.rel_type}`, { error: err.message }))
    }

    recordIngestion(sourceId)
    logger.info(`KG ingested ${parsed.nodes?.length || 0} nodes, ${parsed.relationships?.length || 0} relationships from ${sourceModule}`)
    return parsed
  } catch (err) {
    logger.error('KG ingestion failed', { error: err.message, sourceModule })
    return null
  }
}

// ─── Embedding Operations ────────────────────────────────────────────

async function embedNode(nodeId) {
  if (!env.OPENAI_API_KEY) return

  // Get node with its relationships for rich embedding text
  const records = await runQuery(
    `MATCH (n) WHERE elementId(n) = $nodeId
     OPTIONAL MATCH (n)-[r]-(neighbor)
     RETURN n, collect(DISTINCT {type: type(r), neighbor: neighbor.name, props: r}) AS rels`,
    { nodeId }
  )

  if (records.length === 0) return

  const node = records[0].get('n').properties
  const rels = records[0].get('rels')
  const labels = records[0].get('n').labels

  // Build rich text for embedding
  const relText = rels
    .filter(r => r.neighbor)
    .map(r => `${r.type}: ${r.neighbor}`)
    .join(', ')

  const text = `[${labels.join(', ')}] ${node.name}${node.description ? ' — ' + node.description : ''}${relText ? ' | Connections: ' + relText : ''}`

  const embedding = await getEmbedding(text)
  if (!embedding) return

  await runWrite(
    `MATCH (n) WHERE elementId(n) = $nodeId
     SET n.embedding = $embedding, n.embedding_stale = false, n.embedding_text = $text, n:\`__Embedded__\``,
    { nodeId, embedding, text }
  )
}

async function embedStaleNodes(batchSize = 100) {
  if (!env.OPENAI_API_KEY) {
    logger.debug('KG embedding skipped — no OpenAI API key')
    return 0
  }

  const limit = parseInt(batchSize, 10) || 100

  // First: mark nameless nodes as un-embeddable so they stop clogging the batch.
  // Nodes without a name can't produce meaningful embedding text, so they'd be
  // fetched, skipped, and re-fetched forever — blocking real nodes from processing.
  try {
    await runWrite(
      `MATCH (n) WHERE (n.embedding_stale = true OR n.embedding IS NULL)
       AND n.name IS NULL
       SET n.embedding_stale = false, n.embedding_skipped = true
       RETURN count(n) AS skipped`
    ).then(res => {
      const skipped = res[0]?.get('skipped')?.toInt?.() ?? res[0]?.get('skipped') ?? 0
      if (skipped > 0) logger.info(`KG embedding: marked ${skipped} nameless nodes as un-embeddable`)
    })
  } catch (err) {
    logger.debug('Nameless node cleanup failed', { error: err.message })
  }

  // Single query fetches stale nodes with their relationships in one pass
  // Only fetches nodes that HAVE a name — nameless ones were cleaned above
  const stale = await runQuery(
    `MATCH (n) WHERE (n.embedding_stale = true OR n.embedding IS NULL)
     AND n.name IS NOT NULL
     WITH n LIMIT ${limit}
     OPTIONAL MATCH (n)-[r]-(neighbor)
     RETURN elementId(n) AS nodeId, n AS node, labels(n) AS labels,
            collect(DISTINCT {type: type(r), neighbor: neighbor.name}) AS rels`
  )

  if (stale.length === 0) return 0

  // Build embedding texts from the batch query results
  const nodes = []
  for (const record of stale) {
    const node = record.get('node').properties
    if (!node.name) continue
    const labels = record.get('labels')
    const rels = record.get('rels')
    const relText = rels.filter(r => r.neighbor).map(r => `${r.type}: ${r.neighbor}`).join(', ')
    const text = `[${labels.join(', ')}] ${node.name}${node.description ? ' — ' + node.description : ''}${relText ? ' | ' + relText : ''}`

    nodes.push({ nodeId: record.get('nodeId'), text })
  }

  if (nodes.length === 0) return 0

  // Batch embed via OpenAI
  const embeddings = await getBatchEmbeddings(nodes.map(n => n.text))

  let stored = 0
  let failed = 0
  for (let i = 0; i < nodes.length; i++) {
    if (embeddings[i]) {
      await runWrite(
        `MATCH (n) WHERE elementId(n) = $nodeId
         SET n.embedding = $embedding, n.embedding_stale = false, n.embedding_text = $text, n:\`__Embedded__\``,
        { nodeId: nodes[i].nodeId, embedding: embeddings[i], text: nodes[i].text }
      ).catch(err => {
        failed++
        logger.warn(`Failed to store embedding for ${nodes[i].nodeId}`, { error: err.message })
      })
      stored++
    } else {
      failed++
    }
  }

  if (failed > 0) {
    logger.warn(`KG embedding: ${stored} stored, ${failed} failed out of ${nodes.length} batch`)
  } else {
    logger.info(`Embedded ${stored} stale KG nodes`)
  }
  return stored
}

// ─── Trace-Based Retrieval ───────────────────────────────────────────

async function getContext(query, { maxSeeds = parseInt(env.KG_CONTEXT_MAX_SEEDS || '15', 10), maxDepth = parseInt(env.KG_CONTEXT_MAX_DEPTH || '5', 10), minSimilarity = parseFloat(env.KG_CONTEXT_MIN_SIMILARITY || '0.4') } = {}) {
  if (!env.NEO4J_URI) return { traces: [], summary: '' }

  const seedLimit = parseInt(maxSeeds, 10) || 5
  const depthInt = parseInt(maxDepth, 10) || 3

  // Step 1: Find seed nodes via vector similarity (primary) + keyword fallback
  let seedRecords = []

  // Primary: semantic vector search — finds nodes by meaning, not substring
  if (env.OPENAI_API_KEY) {
    try {
      const queryEmbedding = await getEmbedding(query)
      if (queryEmbedding) {
        seedRecords = await runQuery(
          `CALL db.index.vector.queryNodes('node_embeddings', $k, $embedding)
           YIELD node, score
           WHERE score >= $minSim
           WITH node, score, coalesce(node.importance, 0.0) AS imp
           RETURN node.name AS name, labels(node) AS labels,
                  score * 0.7 + imp * 0.3 AS score
           ORDER BY score DESC`,
          { k: seedLimit, embedding: queryEmbedding, minSim: minSimilarity }
        ).catch(() => [])
      }
    } catch (err) {
      logger.debug('KG vector search failed, falling back to keyword', { error: err.message })
    }
  }

  // Fallback: keyword search if vector search returned nothing
  // (covers cases where embeddings aren't available or index doesn't exist yet)
  if (seedRecords.length === 0) {
    const words = query.split(/\s+/).filter(w => w.length > 2).slice(0, 5)
    if (words.length === 0) return { traces: [], summary: '' }

    const whereClauses = words.map((_, i) => `toLower(n.name) CONTAINS toLower($w${i})`).join(' OR ')
    const params = {}
    words.forEach((w, i) => { params[`w${i}`] = w })

    seedRecords = await runQuery(
      `MATCH (n) WHERE ${whereClauses}
       RETURN n.name AS name, labels(n) AS labels, 0.5 AS score
       LIMIT ${seedLimit}`,
      params
    )
  }

  if (seedRecords.length === 0) return { traces: [], summary: '' }

  // Step 2: For each seed, get its neighborhood via direct Cypher
  // Return rich node properties — importance, description, timestamps — so
  // the consumer (Cortex) can reason over *what* nodes mean, not just their names.
  const lines = []

  for (const seedRec of seedRecords) {
    const seedName = seedRec.get('name')
    const seedLabels = seedRec.get('labels') || []
    const score = seedRec.get('score')
    const pct = typeof score === 'number' ? ` (${(score * 100).toFixed(0)}%)` : ''

    // Fetch seed node's own properties
    const [seedProps] = await runQuery(
      `MATCH (n {name: $seedName})
       RETURN n.description AS description, n.importance AS importance,
              n.is_synthesized AS synthesized, n.created_at AS created_at`,
      { seedName }
    ).catch(() => [])

    let seedLine = `${seedName} [${seedLabels.join(', ')}]${pct}`
    if (seedProps) {
      const imp = seedProps.get('importance')
      if (imp != null) seedLine += ` importance:${imp}`
      if (seedProps.get('synthesized')) seedLine += ' [synthesized]'
      const desc = seedProps.get('description')
      if (desc) seedLine += ` — ${String(desc).slice(0, 200)}`
    }
    lines.push(seedLine)

    const neighbors = await runQuery(
      `MATCH (n {name: $seedName})-[r*1..${depthInt}]-(m)
       WHERE m.name <> $seedName
       WITH m, [rel IN r | type(rel)] AS types, size(r) AS depth
       RETURN DISTINCT m.name AS name, labels(m) AS labels, types, depth,
              m.description AS description, m.importance AS importance,
              m.is_synthesized AS synthesized
       ORDER BY depth, m.importance DESC
       LIMIT 20`,
      { seedName }
    )

    const seen = new Set()
    for (const rec of neighbors) {
      const name = rec.get('name')
      if (seen.has(name)) continue
      seen.add(name)

      const types = rec.get('types') || []
      const labels = rec.get('labels') || []
      const rawDepth = rec.get('depth')
      const d = typeof rawDepth === 'object' && rawDepth?.low !== undefined ? rawDepth.low : rawDepth
      const indent = '  '.repeat(d)

      let line = `${indent}-[${types.join(' → ')}]-> ${name} [${labels.join(', ')}]`
      const imp = rec.get('importance')
      if (imp != null) line += ` importance:${imp}`
      if (rec.get('synthesized')) line += ' [synthesized]'
      const desc = rec.get('description')
      if (desc) line += ` — ${String(desc).slice(0, 150)}`
      lines.push(line)
    }
  }

  const summary = lines.join('\n')
  return { traces: [], summary }
}

function buildContextSummary(traces) {
  if (traces.length === 0) return ''

  const lines = []
  for (const trace of traces) {
    const score = typeof trace.seed.score === 'number' ? trace.seed.score : 0.8
    const seedLine = `${trace.seed.name} [${(trace.seed.labels || []).join(', ')}] (relevance: ${(score * 100).toFixed(0)}%)`
    lines.push(seedLine)

    for (const chain of trace.chains.slice(0, 10)) {
      const via = chain.via || []
      const viaStr = via
        .map(r => `${r.startName} -[${r.type}]-> ${r.endName}`)
        .join(' → ')
      if (viaStr) lines.push(`  ${viaStr}`)
      else lines.push(`  → ${chain.name} [${(chain.labels || []).join(', ')}]`)
    }
  }

  return lines.join('\n')
}

// ─── Direct Node Lookup ──────────────────────────────────────────────

async function findNode(name) {
  const records = await runQuery(
    `MATCH (n) WHERE toLower(n.name) = toLower($name)
     RETURN n, labels(n) AS labels
     LIMIT 1`,
    { name }
  )
  if (records.length === 0) return null
  return { ...records[0].get('n').properties, labels: records[0].get('labels') }
}

async function getNodeNeighborhood(name, { depth = 1 } = {}) {
  const records = await runQuery(
    `MATCH (n) WHERE toLower(n.name) = toLower($name)
     MATCH path = (n)-[*1..${parseInt(depth)}]-(connected)
     RETURN DISTINCT connected.name AS name, labels(connected) AS labels,
            properties(connected) AS props
     LIMIT 50`,
    { name }
  )
  return records.map(r => ({
    name: r.get('name'),
    labels: r.get('labels'),
    properties: r.get('props'),
  }))
}

async function getGraphStats() {
  const records = await runQuery(`
    MATCH (n)
    WITH labels(n) AS lbls, count(n) AS cnt
    UNWIND lbls AS label
    RETURN label, sum(cnt) AS count
    ORDER BY count DESC
  `)

  const [relCount] = await runQuery('MATCH ()-[r]->() RETURN count(r) AS count')
  const [nodeCount] = await runQuery('MATCH (n) RETURN count(n) AS count')
  const [embeddedCount] = await runQuery('MATCH (n) WHERE n.embedding IS NOT NULL RETURN count(n) AS count')

  return {
    totalNodes: nodeCount?.get('count')?.toInt?.() ?? 0,
    totalRelationships: relCount?.get('count')?.toInt?.() ?? 0,
    embeddedNodes: embeddedCount?.get('count')?.toInt?.() ?? 0,
    labelBreakdown: records.map(r => ({
      label: r.get('label'),
      count: r.get('count')?.toInt?.() ?? 0,
    })),
  }
}

// ─── Setup: Create Vector Index ──────────────────────────────────────

async function ensureVectorIndex() {
  try {
    // Drop the old label-scoped index if it exists (was __Embedded__ but nodes never got that label)
    await runWrite(`DROP INDEX node_embeddings IF EXISTS`).catch(() => {})

    // Create index scoped to __Embedded__ label — embedStaleNodes now adds this label
    await runWrite(`
      CREATE VECTOR INDEX node_embeddings IF NOT EXISTS
      FOR (n:__Embedded__)
      ON (n.embedding)
      OPTIONS {indexConfig: {
        \`vector.dimensions\`: 1536,
        \`vector.similarity_function\`: 'cosine'
      }}
    `)
    logger.info('Neo4j vector index ensured')
  } catch (err) {
    // Index might already exist or Aura version might not support this syntax
    logger.debug('Vector index creation skipped', { error: err.message })
  }
}

// ─── Stale Node Count (used by embedding worker for adaptive scheduling) ──

async function countStaleNodes() {
  const [result] = await runQuery(
    `MATCH (n) WHERE (n.embedding_stale = true OR n.embedding IS NULL)
     AND n.name IS NOT NULL
     RETURN count(n) AS cnt`
  )
  return result?.get('cnt')?.toInt?.() ?? result?.get('cnt') ?? 0
}

// ─── Defensive Stale Sweep ──────────────────────────────────────────
// Catches nodes where embedding IS NULL but embedding_stale was never set
// (e.g. partial writes, crashes, race conditions during creation).
// Called periodically by the embedding worker.

async function sweepOrphanedEmbeddings() {
  const result = await runWrite(
    `MATCH (n)
     WHERE n.embedding IS NULL
       AND (n.embedding_stale IS NULL OR n.embedding_stale = false)
       AND n.name IS NOT NULL
     SET n.embedding_stale = true
     RETURN count(n) AS fixed`
  )
  const fixed = result[0]?.get('fixed')?.toInt?.() ?? result[0]?.get('fixed') ?? 0
  if (fixed > 0) {
    logger.info(`KG sweep: marked ${fixed} orphaned nodes as embedding_stale`)
  }
  return fixed
}

// ─── Helpers ─────────────────────────────────────────────────────────

function sanitizeLabel(label) {
  // Neo4j labels can't have special chars — sanitize
  return label.replace(/[^a-zA-Z0-9_]/g, '_').replace(/^_+|_+$/g, '') || 'Unknown'
}

function parseJSON(content) {
  try {
    return JSON.parse(content)
  } catch {
    const match = content.match(/```(?:json)?\s*([\s\S]*?)```/)
    if (match) return JSON.parse(match[1].trim())
    throw new Error(`Failed to parse KG response: ${content.slice(0, 200)}`)
  }
}

const EXPECTED_EMBEDDING_DIMS = 1536

async function getEmbedding(text) {
  if (!env.OPENAI_API_KEY) return null

  try {
    const response = await axios.post(
      'https://api.openai.com/v1/embeddings',
      { model: 'text-embedding-3-small', input: text },
      { headers: { Authorization: `Bearer ${env.OPENAI_API_KEY}` } }
    )
    const embedding = response.data.data[0].embedding
    if (!Array.isArray(embedding) || embedding.length !== EXPECTED_EMBEDDING_DIMS) {
      logger.warn(`Embedding dimension mismatch: expected ${EXPECTED_EMBEDDING_DIMS}, got ${embedding?.length}`)
      return null
    }
    return embedding
  } catch (err) {
    logger.warn('Embedding failed', { error: err.message })
    return null
  }
}

async function getBatchEmbeddings(texts) {
  if (!env.OPENAI_API_KEY) return texts.map(() => null)

  try {
    const response = await axios.post(
      'https://api.openai.com/v1/embeddings',
      { model: 'text-embedding-3-small', input: texts },
      { headers: { Authorization: `Bearer ${env.OPENAI_API_KEY}` } }
    )
    return response.data.data.map(d => {
      if (!Array.isArray(d.embedding) || d.embedding.length !== EXPECTED_EMBEDDING_DIMS) {
        logger.warn(`Batch embedding dimension mismatch: expected ${EXPECTED_EMBEDDING_DIMS}, got ${d.embedding?.length}`)
        return null
      }
      return d.embedding
    })
  } catch (err) {
    logger.warn('Batch embedding failed', { error: err.message })
    return texts.map(() => null)
  }
}

module.exports = {
  ensureNode,
  ensureRelationship,
  ingestFromLLM,
  embedStaleNodes,
  countStaleNodes,
  sweepOrphanedEmbeddings,
  getContext,
  findNode,
  getNodeNeighborhood,
  getGraphStats,
  ensureVectorIndex,
  healthCheck,
}
