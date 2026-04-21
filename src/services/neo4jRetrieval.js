/**
 * Neo4j Retrieval Service
 *
 * Thin wrapper for semantic search against the knowledge graph.
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

module.exports = { semanticSearch }
