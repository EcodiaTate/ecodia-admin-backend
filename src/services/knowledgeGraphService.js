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

  const prompt = `You are a knowledge graph builder. Extract entities and relationships from the following content and return them as structured data.

Content source: ${sourceModule}
${context ? `Additional context: ${context}` : ''}

Content:
${content.slice(0, 3000)}

Extract ALL meaningful entities (people, organisations, projects, concepts, events, locations, topics, decisions, problems, tools, etc.) and ALL relationships between them. Be thorough — capture causal chains, temporal sequences, and implicit connections.

For relationships, use descriptive verbs that capture the TRUE nature of the connection — not generic labels. Good: "IS_PIVOTING_TOWARDS", "BLOCKED_BY", "PROPOSED_DURING", "FRUSTRATED_WITH". Bad: "RELATED_TO", "CONNECTED_TO".

Respond with JSON only:
{
  "nodes": [
    {"label": "Person", "name": "Tom Grote", "properties": {"role": "co-founder", "company": "Goodreach"}},
    {"label": "Concept", "name": "AI consultant model", "properties": {"description": "..."}}
  ],
  "relationships": [
    {"from_label": "Person", "from_name": "Tom Grote", "rel_type": "PROPOSED", "to_label": "Concept", "to_name": "AI consultant model", "properties": {"context": "during strategy session", "when": "Mar 31 2026"}},
    {"from_label": "Concept", "from_name": "AI consultant model", "rel_type": "REPLACES", "to_label": "Concept", "to_name": "SaaS platform model", "properties": {"reason": "NFPs can't afford subscription pricing"}}
  ]
}

Rules:
- Use specific, descriptive relationship types (verbs in SCREAMING_SNAKE_CASE)
- Include temporal context in relationship properties when available
- Extract implicit relationships (if someone works at a company, that's a relationship even if not explicitly stated)
- Capture sentiment and intent when present ("FRUSTRATED_WITH", "EXCITED_ABOUT", "CONSIDERING")
- Every person should have their role/title if known
- Organisations should have industry/domain if inferable
- Don't create generic/useless nodes — every node should carry meaning`

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
     SET n.embedding = $embedding, n.embedding_stale = false, n.embedding_text = $text`,
    { nodeId, embedding, text }
  )
}

async function embedStaleNodes(batchSize = 30) {
  if (!env.OPENAI_API_KEY) {
    logger.debug('KG embedding skipped — no OpenAI API key')
    return 0
  }

  const limit = parseInt(batchSize, 10) || 30
  const stale = await runQuery(
    `MATCH (n) WHERE n.embedding_stale = true OR n.embedding IS NULL
     RETURN elementId(n) AS nodeId, n.name AS name
     LIMIT ${limit}`
  )

  if (stale.length === 0) return 0

  // Batch embed — get all texts first
  const nodes = []
  for (const record of stale) {
    const nodeId = record.get('nodeId')
    const nodeRecords = await runQuery(
      `MATCH (n) WHERE elementId(n) = $nodeId
       OPTIONAL MATCH (n)-[r]-(neighbor)
       RETURN n, labels(n) AS labels, collect(DISTINCT {type: type(r), neighbor: neighbor.name}) AS rels`,
      { nodeId }
    )

    if (nodeRecords.length === 0) continue

    const node = nodeRecords[0].get('n').properties
    const labels = nodeRecords[0].get('labels')
    const rels = nodeRecords[0].get('rels')
    const relText = rels.filter(r => r.neighbor).map(r => `${r.type}: ${r.neighbor}`).join(', ')
    const text = `[${labels.join(', ')}] ${node.name}${node.description ? ' — ' + node.description : ''}${relText ? ' | ' + relText : ''}`

    nodes.push({ nodeId, text })
  }

  if (nodes.length === 0) return 0

  // Batch embed via OpenAI
  const embeddings = await getBatchEmbeddings(nodes.map(n => n.text))

  for (let i = 0; i < nodes.length; i++) {
    if (embeddings[i]) {
      await runWrite(
        `MATCH (n) WHERE elementId(n) = $nodeId
         SET n.embedding = $embedding, n.embedding_stale = false, n.embedding_text = $text`,
        { nodeId: nodes[i].nodeId, embedding: embeddings[i], text: nodes[i].text }
      ).catch(err => logger.warn(`Failed to store embedding for ${nodes[i].nodeId}`, { error: err.message }))
    }
  }

  logger.info(`Embedded ${nodes.length} stale KG nodes`)
  return nodes.length
}

// ─── Trace-Based Retrieval ───────────────────────────────────────────

async function getContext(query, { maxSeeds = 5, maxDepth = 3, minSimilarity = 0.7 } = {}) {
  if (!env.OPENAI_API_KEY || !env.NEO4J_URI) {
    return { traces: [], summary: '' }
  }

  // Step 1: Embed the query
  const queryEmbedding = await getEmbedding(query)
  if (!queryEmbedding) return { traces: [], summary: '' }

  // Step 2: Find seed nodes via vector similarity
  // Neo4j vector index search
  const seedLimit = parseInt(maxSeeds, 10) || 5
  let seeds
  try {
    seeds = await runQuery(
      `CALL db.index.vector.queryNodes('node_embeddings', ${seedLimit}, $embedding)
       YIELD node, score
       WHERE score >= $minSimilarity
       RETURN node, score, labels(node) AS labels
       ORDER BY score DESC`,
      { embedding: queryEmbedding, minSimilarity: parseFloat(minSimilarity) || 0.7 }
    )
  } catch {
    // Vector index might not exist yet — fall back to text search
    // Search for each word in the query independently to be more fuzzy
    const words = query.split(/\s+/).filter(w => w.length > 2).slice(0, 5)
    const whereClauses = words.map((_, i) => `toLower(n.name) CONTAINS toLower($w${i})`).join(' OR ')
    const params = {}
    words.forEach((w, i) => { params[`w${i}`] = w })

    seeds = whereClauses ? await runQuery(
      `MATCH (n)
       WHERE ${whereClauses}
       RETURN n AS node, 0.8 AS score, labels(n) AS labels
       LIMIT ${seedLimit}`,
      params
    ) : []
  }

  if (seeds.length === 0) return { traces: [], summary: '' }

  // Step 3: For each seed, follow causal/temporal chains
  const traces = []
  const visited = new Set()

  for (const seed of seeds) {
    const seedNode = seed.get('node').properties
    const seedScore = seed.get('score')
    const seedLabels = seed.get('labels')

    const trace = {
      seed: { name: seedNode.name, labels: seedLabels, score: seedScore },
      chains: [],
    }

    // Variable-length path traversal — follow chains up to maxDepth hops
    const paths = await runQuery(
      `MATCH (seed) WHERE seed.name = $seedName AND $seedLabel IN labels(seed)
       MATCH path = (seed)-[rels*1..${parseInt(maxDepth)}]-(connected)
       WHERE ALL(r IN rels WHERE r IS NOT NULL)
       UNWIND rels AS r
       WITH path, connected, collect(DISTINCT {
         type: type(r),
         startName: startNode(r).name,
         endName: endNode(r).name,
         props: properties(r)
       }) AS relDetails
       RETURN connected.name AS name, labels(connected) AS labels,
              properties(connected) AS props, relDetails,
              length(path) AS depth
       ORDER BY depth ASC
       LIMIT 30`,
      { seedName: seedNode.name, seedLabel: seedLabels[0] || '' }
    )

    for (const pathRecord of paths) {
      const name = pathRecord.get('name')
      if (visited.has(name)) continue
      visited.add(name)

      trace.chains.push({
        name,
        labels: pathRecord.get('labels'),
        properties: pathRecord.get('props'),
        via: pathRecord.get('relDetails'),
        depth: pathRecord.get('depth')?.toInt?.() ?? pathRecord.get('depth'),
      })
    }

    traces.push(trace)
  }

  // Step 4: Build narrative summary from traces
  const summary = buildContextSummary(traces)

  return { traces, summary }
}

function buildContextSummary(traces) {
  if (traces.length === 0) return ''

  const lines = []
  for (const trace of traces) {
    const seedLine = `${trace.seed.name} [${trace.seed.labels.join(', ')}] (relevance: ${(trace.seed.score * 100).toFixed(0)}%)`
    lines.push(seedLine)

    for (const chain of trace.chains.slice(0, 8)) {
      const viaStr = chain.via
        .map(r => `${r.startName} -[${r.type}]-> ${r.endName}`)
        .join(' → ')
      lines.push(`  ${viaStr}`)

      // Add property context if meaningful
      const props = chain.properties || {}
      const meaningful = Object.entries(props)
        .filter(([k]) => !['name', 'created_at', 'updated_at', 'embedding_stale', 'embedding', 'embedding_text', 'source_module', 'source_id'].includes(k))
        .map(([k, v]) => `${k}: ${v}`)
        .join(', ')
      if (meaningful) lines.push(`    (${meaningful})`)
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

async function getEmbedding(text) {
  if (!env.OPENAI_API_KEY) return null

  try {
    const response = await axios.post(
      'https://api.openai.com/v1/embeddings',
      { model: 'text-embedding-3-small', input: text },
      { headers: { Authorization: `Bearer ${env.OPENAI_API_KEY}` } }
    )
    return response.data.data[0].embedding
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
    return response.data.data.map(d => d.embedding)
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
  getContext,
  findNode,
  getNodeNeighborhood,
  getGraphStats,
  ensureVectorIndex,
  healthCheck,
}
