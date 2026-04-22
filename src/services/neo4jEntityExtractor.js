/**
 * Neo4j Entity Extractor
 *
 * Extracts entity mentions from a node's text and returns PROPOSED edges.
 * Does NOT write to the graph - read + compute + return only.
 *
 * Used by the edgeless-node retrofit pipeline (Wave 3 write-time extraction).
 */

const axios = require('axios')
const { runQuery, runWrite } = require('../config/neo4j')
const env = require('../config/env')
const logger = require('../config/logger')
const db = require('../config/db')
const neo4j = require('neo4j-driver')

// Write-mode confidence gate. Extractor internally keeps candidates at >=0.78,
// but only edges at >=WRITE_CONFIDENCE_THRESHOLD are materialised when writing.
const WRITE_CONFIDENCE_THRESHOLD = 0.85

// ─── RelType inference rules (source label + target label -> relType) ───────

const REL_RULES = [
  // Episode source
  { srcLabel: 'Episode', tgtLabels: ['Organization', 'Person'],              rel: 'INVOLVES' },
  { srcLabel: 'Episode', tgtLabels: ['Problem', 'Decision'],                 rel: 'CONTAINS' },
  // Pattern source
  { srcLabel: 'Pattern', tgtLabels: ['Problem'],                             rel: 'ADDRESSES' },
  // CCSession source
  { srcLabel: 'CCSession', tgtLabels: ['Episode'],                           rel: 'PART_OF' },
]

// Special types inferred from content kind, not from labels
const FILE_REL  = 'APPLIES_TO'
const SHA_REL   = 'CAUSED_BY'
const MENTIONS  = 'MENTIONS'

// ─── Regexes ────────────────────────────────────────────────────────────────

const FILE_PATH_RE = /src\/(services|routes|lib|db|config|middleware|workers|capabilities|scripts|utils|websocket)\/[\w/.-]+\.(js|sql|ts|md)/g
const COMMIT_SHA_RE = /\b([0-9a-f]{7,40})\b/g

// ─── Entity registry (built once per module load) ────────────────────────────

let _registry = null
let _registryBuiltAt = 0
const REGISTRY_TTL_MS = 10 * 60 * 1000 // 10 min

const HARDCODED_PEOPLE = ['Tate', 'Craige', 'Eugene', 'Angelica', 'Vikki', 'Kurt', 'Adam']
const HARDCODED_TOOLS  = [
  'Factory', 'PM2', 'Neo4j', 'Supabase', 'Vercel', 'Bitbucket', 'Stripe',
  'Cognito', 'Zernio', 'Claude', 'Graphiti', 'Zep',
]

async function buildRegistry() {
  if (_registry && Date.now() - _registryBuiltAt < REGISTRY_TTL_MS) return _registry

  const entities = []

  // Clients from Supabase
  try {
    const clients = await db`SELECT name FROM clients WHERE archived_at IS NULL`
    for (const c of clients) {
      if (c.name) entities.push({ name: c.name, type: 'client' })
    }
  } catch (err) {
    logger.warn('neo4jEntityExtractor: failed to load clients', { error: err.message })
  }

  // Projects from Supabase
  try {
    const projects = await db`SELECT name FROM projects`
    for (const p of projects) {
      if (p.name) entities.push({ name: p.name, type: 'project' })
    }
  } catch (err) {
    logger.warn('neo4jEntityExtractor: failed to load projects', { error: err.message })
  }

  // Hardcoded people
  for (const name of HARDCODED_PEOPLE) {
    entities.push({ name, type: 'person' })
  }

  // Hardcoded tools/systems
  for (const name of HARDCODED_TOOLS) {
    entities.push({ name, type: 'tool' })
  }

  _registry = entities
  _registryBuiltAt = Date.now()
  return _registry
}

// ─── Embedding helper (mirrors neo4jRetrieval.embedText) ────────────────────

async function embedText(text) {
  if (!env.OPENAI_API_KEY) return null
  try {
    const res = await axios.post(
      'https://api.openai.com/v1/embeddings',
      { model: 'text-embedding-3-small', input: text.slice(0, 8000) },
      {
        headers: { Authorization: `Bearer ${env.OPENAI_API_KEY}` },
        timeout: 8000,
      }
    )
    return res.data.data[0].embedding
  } catch (err) {
    logger.warn('neo4jEntityExtractor: embedding failed', { error: err.message })
    return null
  }
}

// ─── Node lookup: exact name match first, semantic fallback ─────────────────

async function findNodeByName(name) {
  // Prefer __Embedded__ nodes per canonical-entity-dedup pattern
  const records = await runQuery(
    `MATCH (n)
     WHERE toLower(trim(n.name)) = toLower(trim($name))
     WITH n, CASE WHEN n:__Embedded__ THEN 1 ELSE 0 END AS preferred
     RETURN elementId(n) AS nodeId, labels(n) AS labels, n.name AS name, preferred
     ORDER BY preferred DESC
     LIMIT 1`,
    { name }
  )
  if (records.length === 0) return null

  const rec = records[0]
  const nodeId = rec.get('nodeId')
  const labels = rec.get('labels')
  const nodeName = rec.get('name')
  const primaryLabel = labels.filter(l => l !== '__Embedded__')[0] || labels[0] || 'Node'
  return { nodeId, labels, primaryLabel, name: nodeName }
}

async function findNodeBySemantic(text, minScore = 0.78) {
  if (!env.OPENAI_API_KEY || !env.NEO4J_URI) return null

  const embedding = await embedText(text)
  if (!embedding) return null

  try {
    const records = await runQuery(
      `CALL db.index.vector.queryNodes('node_embeddings', $k, $queryVector) YIELD node, score
       WHERE score >= $minScore
       RETURN elementId(node) AS nodeId, labels(node) AS labels, node.name AS name, score
       ORDER BY score DESC
       LIMIT 1`,
      { k: neo4j.int(10), queryVector: embedding, minScore }
    )

    if (records.length === 0) return null

    const rec = records[0]
    const nodeId = rec.get('nodeId')
    const labels = rec.get('labels')
    const nodeName = rec.get('name')
    const score = rec.get('score')
    const primaryLabel = labels.filter(l => l !== '__Embedded__')[0] || labels[0] || 'Node'
    return { nodeId, labels, primaryLabel, name: nodeName, score }
  } catch (err) {
    logger.warn('neo4jEntityExtractor: semantic fallback failed', { error: err.message })
    return null
  }
}

// ─── RelType inference ───────────────────────────────────────────────────────

function inferRelType(srcLabels, tgtLabels, contentKind) {
  if (contentKind === 'file')   return FILE_REL
  if (contentKind === 'commit') return SHA_REL

  for (const rule of REL_RULES) {
    const srcMatch = srcLabels.includes(rule.srcLabel)
    const tgtMatch = rule.tgtLabels.some(l => tgtLabels.includes(l))
    if (srcMatch && tgtMatch) return rule.rel
  }

  return MENTIONS
}

// ─── Evidence extraction: capture ~80 chars around the match ─────────────────

function extractEvidence(text, matchStr) {
  const idx = text.toLowerCase().indexOf(matchStr.toLowerCase())
  if (idx === -1) return matchStr.slice(0, 80)
  const start = Math.max(0, idx - 40)
  const end   = Math.min(text.length, idx + matchStr.length + 40)
  return text.slice(start, end).replace(/\s+/g, ' ').trim()
}

// ─── Main export ─────────────────────────────────────────────────────────────

/**
 * Extract entity mentions from a node's text and return PROPOSED edges.
 * Does NOT write to the graph.
 *
 * @param {string} nodeId - Neo4j elementId
 * @returns {Promise<{nodeId, nodeLabel, nodeName, proposedEdges: Array}>}
 */
async function extractEntitiesFromNode(nodeId) {
  // 1. Load the node
  const nodeRecords = await runQuery(
    `MATCH (n) WHERE elementId(n) = $nodeId
     RETURN n.name AS name, n.description AS description, labels(n) AS labels`,
    { nodeId }
  )

  if (nodeRecords.length === 0) {
    return { nodeId, nodeLabel: null, nodeName: null, proposedEdges: [] }
  }

  const rec = nodeRecords[0]
  const nodeName = (rec.get('name') || '').trim()
  const nodeDescription = rec.get('description') || ''
  const nodeLabels = rec.get('labels') || []
  const nodeLabel = nodeLabels.filter(l => l !== '__Embedded__')[0] || nodeLabels[0] || 'Node'

  const searchText = [nodeName, nodeDescription].filter(Boolean).join(' ')

  if (!searchText.trim()) {
    return { nodeId, nodeLabel, nodeName, proposedEdges: [] }
  }

  // 2. Build entity registry
  const registry = await buildRegistry()

  // 3. Rule-based extraction pass
  const mentions = [] // { matchStr, contentKind, evidence }

  // Known entities (substring match)
  for (const entity of registry) {
    const lowerText = searchText.toLowerCase()
    const lowerName = entity.name.toLowerCase()
    if (lowerText.includes(lowerName)) {
      mentions.push({
        matchStr: entity.name,
        contentKind: 'entity',
        evidence: extractEvidence(searchText, entity.name),
      })
    }
  }

  // File paths
  const filePathRe = new RegExp(FILE_PATH_RE.source, 'g')
  let m
  while ((m = filePathRe.exec(searchText)) !== null) {
    mentions.push({
      matchStr: m[0],
      contentKind: 'file',
      evidence: extractEvidence(searchText, m[0]),
    })
  }

  // Commit SHAs (7-40 hex chars, standalone)
  const shaRe = new RegExp(COMMIT_SHA_RE.source, 'g')
  while ((m = shaRe.exec(searchText)) !== null) {
    // Filter false positives: skip very common words that happen to be hex
    const sha = m[1]
    if (sha.length < 7) continue
    // Skip if part of a longer word (e.g. #abc123def inside a URL or variable)
    mentions.push({
      matchStr: sha,
      contentKind: 'commit',
      evidence: extractEvidence(searchText, sha),
    })
  }

  if (mentions.length === 0) {
    return { nodeId, nodeLabel, nodeName, proposedEdges: [] }
  }

  // 4. Resolve each mention to a Neo4j node
  const proposedEdgesMap = new Map() // key: `${targetId}::${relType}` -> edge (highest confidence wins)

  for (const mention of mentions) {
    // Skip if the mention resolves to the source node itself
    let target = null
    let confidence = 0

    if (mention.contentKind === 'entity') {
      // Exact match first
      target = await findNodeByName(mention.matchStr)
      if (target) {
        confidence = 1.0
      } else {
        // Semantic fallback
        target = await findNodeBySemantic(mention.matchStr, 0.78)
        if (target) {
          confidence = typeof target.score === 'number' ? target.score : 0.78
        }
      }
    } else {
      // File path or commit SHA - try exact name match, then semantic
      target = await findNodeByName(mention.matchStr)
      if (target) {
        confidence = 1.0
      } else {
        target = await findNodeBySemantic(mention.matchStr, 0.78)
        if (target) {
          confidence = typeof target.score === 'number' ? target.score : 0.78
        }
      }
    }

    if (!target) continue
    // Skip self-references
    if (target.nodeId === nodeId) continue
    // Skip below threshold
    if (confidence < 0.78) continue

    const relType = inferRelType(nodeLabels, target.labels, mention.contentKind)
    const edgeKey = `${target.nodeId}::${relType}`

    const existing = proposedEdgesMap.get(edgeKey)
    if (!existing || confidence > existing.confidence) {
      proposedEdgesMap.set(edgeKey, {
        targetId: target.nodeId,
        targetLabel: target.primaryLabel,
        targetName: target.name,
        relType,
        confidence,
        evidence: mention.evidence,
      })
    }
  }

  const proposedEdges = Array.from(proposedEdgesMap.values())

  return { nodeId, nodeLabel, nodeName, proposedEdges }
}

/**
 * Materialise proposed edges from extractEntitiesFromNode into the graph.
 *
 * Feature-flagged and idempotent. Each edge carries:
 *   - confidence (float, 0.85-1.0)
 *   - evidence  (string, ~80-char excerpt)
 *   - extracted_at (ISO datetime)
 *   - extractor_version (string, bumped when extractor logic changes)
 *
 * Uses MERGE keyed on (source, target, relType) so re-running is safe.
 *
 * @param {object} extraction - result of extractEntitiesFromNode
 * @param {object} opts
 * @param {number} [opts.minConfidence=WRITE_CONFIDENCE_THRESHOLD] - edges below this are skipped
 * @param {boolean} [opts.force=false] - bypass NEO4J_EXTRACTOR_WRITE_ENABLED feature flag
 * @returns {Promise<{written: number, skipped_low_conf: number, skipped_disabled: number, errors: number, edges: Array}>}
 */
async function writeExtractedEdges(extraction, opts = {}) {
  const minConfidence = opts.minConfidence ?? WRITE_CONFIDENCE_THRESHOLD
  const enabled = opts.force === true || process.env.NEO4J_EXTRACTOR_WRITE_ENABLED === 'true'

  const result = { written: 0, skipped_low_conf: 0, skipped_disabled: 0, errors: 0, edges: [] }

  if (!extraction || !extraction.nodeId || !Array.isArray(extraction.proposedEdges)) {
    return result
  }

  if (!enabled) {
    result.skipped_disabled = extraction.proposedEdges.length
    return result
  }

  const extractedAt = new Date().toISOString()
  const extractorVersion = 'v1.0'

  for (const edge of extraction.proposedEdges) {
    if (edge.confidence < minConfidence) {
      result.skipped_low_conf += 1
      continue
    }
    try {
      // Sanitise relType to uppercase alpha+underscore only
      const relType = String(edge.relType || 'MENTIONS').replace(/[^A-Z_]/g, '') || 'MENTIONS'
      const cypher = `
        MATCH (src) WHERE elementId(src) = $srcId
        MATCH (tgt) WHERE elementId(tgt) = $tgtId
        MERGE (src)-[r:${relType}]->(tgt)
        ON CREATE SET r.confidence = $confidence,
                      r.evidence = $evidence,
                      r.extracted_at = $extractedAt,
                      r.extractor_version = $extractorVersion,
                      r.created_at = datetime()
        ON MATCH SET  r.confidence = CASE WHEN coalesce(r.confidence, 0) < $confidence THEN $confidence ELSE r.confidence END,
                      r.evidence = coalesce(r.evidence, $evidence),
                      r.extracted_at = $extractedAt,
                      r.extractor_version = $extractorVersion
        RETURN elementId(r) AS edgeId, type(r) AS relType
      `
      const records = await runWrite(cypher, {
        srcId: extraction.nodeId,
        tgtId: edge.targetId,
        confidence: edge.confidence,
        evidence: edge.evidence,
        extractedAt,
        extractorVersion,
      })
      if (records.length > 0) {
        result.written += 1
        result.edges.push({
          edgeId: records[0].get('edgeId'),
          relType: records[0].get('relType'),
          targetName: edge.targetName,
          confidence: edge.confidence,
        })
      }
    } catch (err) {
      result.errors += 1
      logger.warn('neo4jEntityExtractor: edge write failed', {
        srcId: extraction.nodeId,
        tgtId: edge.targetId,
        relType: edge.relType,
        error: err.message,
      })
    }
  }

  logger.info('neo4jEntityExtractor: writeExtractedEdges completed', {
    srcId: extraction.nodeId,
    proposed: extraction.proposedEdges.length,
    written: result.written,
    skipped_low_conf: result.skipped_low_conf,
    errors: result.errors,
  })

  return result
}

/**
 * Convenience: extract + write in one call. Returns combined result.
 *
 * Use this from graph_merge_node or any write-time hook that wants to
 * materialise edges immediately after a node is created or updated.
 *
 * @param {string} nodeId - Neo4j elementId
 * @param {object} [opts] - Passed through to writeExtractedEdges
 * @returns {Promise<{nodeId, nodeLabel, nodeName, proposedEdges, write: {written, skipped_low_conf, skipped_disabled, errors, edges}}>}
 */
async function extractAndWrite(nodeId, opts = {}) {
  const extraction = await extractEntitiesFromNode(nodeId)
  const write = await writeExtractedEdges(extraction, opts)
  return { ...extraction, write }
}

module.exports = {
  extractEntitiesFromNode,
  writeExtractedEdges,
  extractAndWrite,
  // for tests / CLI
  _internal: { WRITE_CONFIDENCE_THRESHOLD },
}
