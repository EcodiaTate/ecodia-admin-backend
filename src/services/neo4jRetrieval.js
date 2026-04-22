/**
 * Neo4j Retrieval Service
 *
 * Semantic and fused retrieval against the knowledge graph.
 * Used by osSessionService to inject relevant memory into user messages.
 *
 * Fail-open: any error returns an empty array.
 */

const axios = require('axios')
const { runQuery } = require('../config/neo4j')
const logger = require('../config/logger')
const env = require('../config/env')

const neo4j = require('neo4j-driver')

// Labels we want to retrieve (noise labels excluded)
const DEFAULT_LABELS = ['Pattern', 'Decision', 'Episode', 'Strategic_Direction', 'Reflection']

// Bi-temporal filter for current-only retrieval. Excludes superseded nodes.
// Nodes without t_invalid_from (Episode, Reflection, etc.) evaluate to NULL IS NULL = true,
// so non-doctrine labels are never filtered out.
const CURRENT_ONLY_CLAUSE = '(n.t_invalid_from IS NULL OR n.t_invalid_from > datetime())'

/**
 * Embed a text string via OpenAI text-embedding-3-small.
 * Returns null if embedding fails.
 */
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
    logger.warn('neo4jRetrieval: embedding failed', { error: err.message })
    return null
  }
}

/**
 * Semantic search against the Neo4j knowledge graph.
 *
 * @param {string} query - Natural language query text
 * @param {object} opts
 * @param {number} [opts.limit=3] - Max results to return
 * @param {number} [opts.minScore=0.78] - Minimum cosine similarity
 * @param {string[]} [opts.labels] - Label whitelist (default: Pattern, Decision, Episode)
 * @returns {Array<{label: string, name: string, description: string, score: number}>}
 */
async function semanticSearch(query, opts = {}) {
  if (!env.NEO4J_URI || !env.OPENAI_API_KEY) return []

  const limit = opts.limit ?? 3
  const minScore = opts.minScore ?? 0.70
  const labels = opts.labels ?? DEFAULT_LABELS
  const onlyCurrent = opts.onlyCurrent !== false
  // Vector query uses `node` as the variable name; adapt the clause accordingly
  const currentFilter = onlyCurrent ? `AND ${CURRENT_ONLY_CLAUSE.replace(/\bn\./g, 'node.')}` : ''

  const embedding = await embedText(query)
  if (!embedding) return []

  const vecStr = `[${embedding.join(',')}]`
  // Over-fetch to allow label filtering
  const k = limit * labels.length * 2

  try {
    const records = await runQuery(
      `CALL db.index.vector.queryNodes('node_embeddings', $k, $queryVector) YIELD node, score
       WHERE any(lbl IN labels(node) WHERE lbl IN $labels)
         AND score >= $minScore
         ${currentFilter}
       RETURN node, labels(node) AS lbls, score
       ORDER BY score DESC
       LIMIT $limit`,
      {
        k: neo4j.int(k),
        queryVector: embedding,
        labels,
        minScore,
        limit: neo4j.int(limit),
      }
    )

    return records.map(r => {
      const props = r.get('node').properties
      const nodeLabels = r.get('lbls')
      const score = r.get('score')
      // Pick the first matching label for display
      const label = nodeLabels.find(l => labels.includes(l)) || nodeLabels[0] || 'Node'
      const name = props.name || props.title || '(unnamed)'
      const description = props.description || props.summary || props.content || ''
      return { label, name, description: description.slice(0, 300), score }
    })
  } catch (err) {
    logger.warn('neo4jRetrieval: query failed', { error: err.message })
    return []
  }
}

/**
 * Semantic search with 1-hop neighbourhood expansion.
 *
 * Calls semanticSearch to get top-K hits, then for each hit fetches its
 * direct neighbours (1 hop) from Neo4j so callers can surface relationship
 * context alongside the matched node.
 *
 * @param {string} query - Natural language query text
 * @param {object} opts
 * @param {number} [opts.limit=3] - Max seed results
 * @param {number} [opts.minScore=0.70] - Minimum cosine similarity
 * @param {string[]} [opts.labels] - Label whitelist
 * @param {number} [opts.hopLimit=1] - Traversal depth (currently fixed at 1)
 * @param {number} [opts.maxNeighboursPerHit=5] - Max neighbours per seed node
 * @returns {Array<{label, name, description, score, neighbours: Array<{rel_type, label, name, description}>}>}
 */
async function semanticSearchWithNeighborhood(query, opts = {}) {
  const { maxNeighboursPerHit = 5, ...searchOpts } = opts
  const hits = await semanticSearch(query, searchOpts)
  if (hits.length === 0) return []

  // Expand each hit by 1 hop using its name (elementId not exposed by semanticSearch)
  const expanded = await Promise.all(hits.map(async hit => {
    try {
      const records = await runQuery(
        `MATCH (n {name: $name})
         MATCH (n)-[r]-(m)
         WHERE m.name IS NOT NULL
         RETURN type(r) AS rel_type, labels(m)[0] AS neighbour_label,
                m.name AS neighbour_name, m.description AS neighbour_description
         LIMIT $maxN`,
        { name: hit.name, maxN: neo4j.int(maxNeighboursPerHit) }
      )

      const neighbours = records.map(rec => ({
        rel_type: rec.get('rel_type') || '',
        label: rec.get('neighbour_label') || 'Node',
        name: rec.get('neighbour_name') || '',
        description: (rec.get('neighbour_description') || '').slice(0, 120),
      })).filter(n => n.name)

      return { ...hit, neighbours }
    } catch (err) {
      logger.warn('neo4jRetrieval: neighbourhood query failed', { name: hit.name, error: err.message })
      return { ...hit, neighbours: [] }
    }
  }))

  return expanded
}

// ─── Tier-1 Fused Retrieval ──────────────────────────────────────────────

/**
 * BM25-lite keyword search against node name and description fields.
 *
 * Tokenises the query, drops stopwords and short tokens, then does a
 * label-filtered linear scan counting token hits. No index required -
 * the graph is small enough that this runs in <200ms.
 *
 * A proper BM25 via a Neo4j fulltext index is Tier-2. This Tier-1
 * version is sufficient and does not require schema migration.
 *
 * @param {string} query
 * @param {object} opts
 * @param {number} [opts.limit=10]
 * @param {string[]} [opts.labels]
 * @returns {Array<{label, name, description, matches}>}
 */
async function keywordSearch(query, opts = {}) {
  if (!env.NEO4J_URI) return []
  const limit = opts.limit ?? 10
  const labels = opts.labels ?? DEFAULT_LABELS
  const onlyCurrent = opts.onlyCurrent !== false
  const currentFilter = onlyCurrent ? `AND ${CURRENT_ONLY_CLAUSE}` : ''

  // Tokenise: lowercase, split on non-alphanumeric, drop stopwords and tokens <3 chars
  const STOPWORDS = new Set([
    'the','and','for','are','was','has','have','had','but','not','you','this','that',
    'with','from','they','were','their','what','when','where','which','would','could',
    'should','about','into','your','our','its','his','her','been','will','just','also',
    'than','then','them','these','those','here','some','such','only','very','more',
    'most','much','any','all','one','two','can','may',
  ])
  const tokens = String(query || '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(t => t.length >= 3 && !STOPWORDS.has(t))
  if (tokens.length === 0) return []

  try {
    const records = await runQuery(
      `MATCH (n)
       WHERE any(lbl IN labels(n) WHERE lbl IN $labels)
         AND n.name IS NOT NULL
         ${currentFilter}
       WITH n, labels(n) AS lbls,
            toLower(coalesce(n.name, '') + ' ' + coalesce(n.description, '')) AS hay
       WITH n, lbls, hay,
            size([t IN $tokens WHERE hay CONTAINS t]) AS matches
       WHERE matches > 0
       RETURN n AS node, lbls, matches,
              coalesce(n.date, n.created_at, datetime('1970-01-01T00:00:00Z')) AS when
       ORDER BY matches DESC, when DESC
       LIMIT $limit`,
      { labels, tokens, limit: neo4j.int(limit) }
    )
    return records.map(r => {
      const props = r.get('node').properties
      const lbls = r.get('lbls')
      const label = lbls.find(l => labels.includes(l)) || lbls[0] || 'Node'
      const name = props.name || props.title || '(unnamed)'
      const description = props.description || props.summary || props.content || ''
      return {
        label,
        name,
        description: description.slice(0, 300),
        matches: r.get('matches')?.toNumber?.() ?? r.get('matches') ?? 0,
      }
    })
  } catch (err) {
    logger.warn('neo4jRetrieval: keyword query failed', { error: err.message })
    return []
  }
}

/**
 * Exponential decay recency score.
 * Returns 1.0 for "just now", 0.5 for `halflifeDays` ago, 0.25 for 2x halflife ago.
 *
 * @param {string|object} whenValue - ISO string or Neo4j temporal type
 * @param {number} [halflifeDays=14]
 * @returns {number} 0.0-1.0
 */
function recencyScore(whenValue, halflifeDays = 14) {
  if (!whenValue) return 0
  let timestamp
  try {
    if (typeof whenValue === 'string') {
      timestamp = new Date(whenValue).getTime()
    } else if (whenValue?.toString) {
      // Neo4j temporal types have a toString that parses
      timestamp = new Date(whenValue.toString()).getTime()
    } else {
      return 0
    }
    if (!Number.isFinite(timestamp)) return 0
  } catch { return 0 }
  const ageDays = (Date.now() - timestamp) / (1000 * 60 * 60 * 24)
  if (ageDays < 0) return 1
  return Math.pow(0.5, ageDays / halflifeDays)
}

/**
 * Reciprocal Rank Fusion over multiple ranked result lists.
 *
 * Items across lists are matched by `label|name` key.
 * Each item's RRF score is the sum of 1/(k + rank) over every list it appears in.
 *
 * @param {Array<Array<object>>} rankedLists - Each inner list is ranked best-first
 * @param {number} [k=60] - RRF constant (higher k reduces the impact of rank differences)
 * @returns {Array<{item: object, score: number}>} sorted by RRF score desc
 */
function reciprocalRankFusion(rankedLists, k = 60) {
  const scores = new Map() // key -> {item, score}
  for (const list of rankedLists) {
    list.forEach((item, idx) => {
      const key = `${item.label || 'Node'}|${item.name || ''}`
      const rrfScore = 1 / (k + idx + 1) // idx is 0-based so +1
      const existing = scores.get(key)
      if (existing) {
        existing.score += rrfScore
      } else {
        scores.set(key, { item, score: rrfScore })
      }
    })
  }
  return Array.from(scores.values()).sort((a, b) => b.score - a.score)
}

/**
 * Fused retrieval: vector + keyword + recency, merged via Reciprocal Rank Fusion.
 *
 * Use this for natural-language queries that want the best blended hits.
 * For unqueried orientation (turn-open "what's recent and critical"), use
 * getRecentHighPriorityNodes instead.
 *
 * @param {string} query - Natural language query text
 * @param {object} opts
 * @param {number} [opts.limit=5] - Max results after fusion
 * @param {number} [opts.minScore=0.55] - Min vector similarity for vector leg
 * @param {string[]} [opts.labels] - Label whitelist
 * @param {number} [opts.recencyHalflifeDays=14] - Recency decay halflife
 * @param {number} [opts.vectorK=15] - Candidate count from vector leg
 * @param {number} [opts.keywordK=15] - Candidate count from keyword leg
 * @returns {Array<{label, name, description, score, signals: {vector, keyword, recency}}>}
 */
async function fusedSearch(query, opts = {}) {
  const limit = opts.limit ?? 5
  const labels = opts.labels ?? DEFAULT_LABELS
  const halflife = opts.recencyHalflifeDays ?? 14
  const vectorK = opts.vectorK ?? 15
  const keywordK = opts.keywordK ?? 15
  const onlyCurrent = opts.onlyCurrent !== false

  const [vectorHits, keywordHits] = await Promise.all([
    semanticSearch(query, { limit: vectorK, minScore: opts.minScore ?? 0.55, labels, onlyCurrent }),
    keywordSearch(query, { limit: keywordK, labels, onlyCurrent }),
  ])

  // Build a union map of all hits
  const union = new Map()
  for (const h of [...vectorHits, ...keywordHits]) {
    const key = `${h.label || 'Node'}|${h.name || ''}`
    if (!union.has(key)) union.set(key, h)
  }

  // Fetch `when` timestamps for all union members so we can rank by recency
  let recencyRanked = []
  const unionList = Array.from(union.values())
  if (unionList.length > 0) {
    try {
      const names = unionList.map(h => h.name)
      const records = await runQuery(
        `MATCH (n)
         WHERE n.name IN $names
         RETURN n.name AS name, labels(n)[0] AS label,
                coalesce(n.date, n.created_at, datetime('1970-01-01T00:00:00Z')) AS when`,
        { names }
      )
      const byName = new Map()
      for (const r of records) {
        byName.set(r.get('name'), r.get('when'))
      }
      // Sort union by recency desc
      recencyRanked = unionList
        .map(h => ({ h, when: byName.get(h.name) }))
        .sort((a, b) => {
          const av = a.when?.toString?.() || ''
          const bv = b.when?.toString?.() || ''
          return bv.localeCompare(av)
        })
        .map(x => x.h)
    } catch (err) {
      logger.warn('neo4jRetrieval: fused recency lookup failed', { error: err.message })
      // Fall back to union order if timestamp fetch fails
      recencyRanked = unionList
    }
  }

  // RRF merge the three rankings
  const fused = reciprocalRankFusion([vectorHits, keywordHits, recencyRanked])

  // Attach signal breakdown for observability
  const vectorPos = new Map(vectorHits.map((h, i) => [`${h.label}|${h.name}`, { rank: i, score: h.score }]))
  const keywordPos = new Map(keywordHits.map((h, i) => [`${h.label}|${h.name}`, { rank: i, matches: h.matches }]))

  // TODO(tier2): plumb `when` through every hit so recency signal is reported accurately.
  // Currently recency influences ranking via the recency-sorted list but the returned
  // signal value is a placeholder (0) rather than the actual per-node recency score.
  return fused.slice(0, limit).map(({ item, score }) => {
    const key = `${item.label}|${item.name}`
    return {
      label: item.label,
      name: item.name,
      description: item.description,
      score,
      signals: {
        vector: vectorPos.get(key)?.score ?? null,
        keyword: keywordPos.get(key)?.matches ?? null,
        recency: 0, // TODO(tier2): fill from per-node `when` once plumbed through
      },
    }
  })
}

/**
 * Recent high-priority Decisions/Episodes/Patterns for turn-open orientation.
 *
 * Returns the most recent nodes across specified labels, ordered by date then
 * created_at. No query required. This is what gets auto-injected at the top
 * of a turn when the context is "auto-wake / restart / cron fire" and there
 * is no natural-language query yet.
 *
 * @param {object} opts
 * @param {number} [opts.days=14] - Only return nodes with date/created_at in the last N days
 * @param {number} [opts.limit=10] - Max results
 * @param {string[]} [opts.labels] - Label whitelist (default: Decision, Episode, Pattern)
 * @param {string} [opts.priorityFilter] - If set, require priority property matches
 * @returns {Array<{label, name, description, date, priority}>}
 */
async function getRecentHighPriorityNodes(opts = {}) {
  if (!env.NEO4J_URI) return []
  const days = opts.days ?? 14
  const limit = opts.limit ?? 10
  const labels = opts.labels ?? ['Decision', 'Episode', 'Pattern']
  const priorityFilter = opts.priorityFilter ?? null
  const onlyCurrent = opts.onlyCurrent !== false
  const currentFilter = onlyCurrent ? `AND ${CURRENT_ONLY_CLAUSE}` : ''

  try {
    const records = await runQuery(
      `MATCH (n)
       WHERE any(lbl IN labels(n) WHERE lbl IN $labels)
         AND n.name IS NOT NULL
         AND (
           (n.date IS NOT NULL AND n.date > date() - duration({days: $days}))
           OR (n.created_at IS NOT NULL AND n.created_at > datetime() - duration({days: $days}))
         )
         AND ($priorityFilter IS NULL OR n.priority = $priorityFilter)
         ${currentFilter}
       RETURN n AS node, labels(n) AS lbls,
              coalesce(n.date, n.created_at) AS when,
              coalesce(n.priority, '') AS priority
       ORDER BY when DESC
       LIMIT $limit`,
      {
        labels,
        days: neo4j.int(days),
        limit: neo4j.int(limit),
        priorityFilter,
      }
    )
    return records.map(r => {
      const props = r.get('node').properties
      const lbls = r.get('lbls')
      const label = lbls.find(l => labels.includes(l)) || lbls[0] || 'Node'
      const name = props.name || props.title || '(unnamed)'
      const description = props.description || props.summary || props.content || ''
      const when = r.get('when')
      return {
        label,
        name,
        description: description.slice(0, 400),
        date: when?.toString?.() || String(when || ''),
        priority: r.get('priority') || '',
      }
    })
  } catch (err) {
    logger.warn('neo4jRetrieval: recent-high-priority query failed', { error: err.message })
    return []
  }
}

module.exports = {
  semanticSearch,
  semanticSearchWithNeighborhood,
  fusedSearch,
  getRecentHighPriorityNodes,
  // internals exposed for tests
  _internal: { keywordSearch, recencyScore, reciprocalRankFusion },
}
