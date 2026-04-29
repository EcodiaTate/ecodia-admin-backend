/**
 * Cowork V2 MCP — patterns.semantic_search backing service.
 *
 * Filesystem-grep over ~/ecodiaos/patterns/ with `triggers:` frontmatter
 * matching, ranked by token-match against the query. Falls back to Neo4j
 * `Pattern`-label semantic search when filesystem grep returns 0 hits.
 *
 * Spec: ~/ecodiaos/drafts/cowork-deep-integration-architecture-2026-04-30.md §4.10.
 *
 * Authored: 30 Apr 2026 by fork_mokmorc8_24edea (W2-B).
 */
'use strict'

const fs = require('fs')
const path = require('path')
const logger = require('../config/logger')
const neo4jRetrieval = require('./neo4jRetrieval')

const PATTERNS_DIR = process.env.ECODIAOS_PATTERNS_DIR || '/home/tate/ecodiaos/patterns'

const STOPWORDS = new Set([
  'the','and','for','are','was','has','have','had','but','not','you','this','that',
  'with','from','they','were','their','what','when','where','which','would','could',
  'should','about','into','your','our','its','his','her','been','will','just','also',
  'than','then','them','these','those','here','some','such','only','very','more',
  'most','much','any','all','one','two','can','may',
])

function _tokenise(query) {
  return String(query || '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(t => t.length >= 3 && !STOPWORDS.has(t))
}

function _readPatternMeta(filePath) {
  try {
    const raw = fs.readFileSync(filePath, 'utf8')
    const triggersMatch = raw.match(/^triggers:\s*(.+)$/m)
    const titleMatch = raw.match(/^#\s+(.+)$/m)
    const triggers = triggersMatch
      ? triggersMatch[1].split(',').map(t => t.trim()).filter(Boolean)
      : []
    const title = titleMatch ? titleMatch[1].trim() : path.basename(filePath, '.md')
    const body = raw.split('---').slice(2).join('---').replace(/^\s+/, '')
    const snippet = body.replace(/\s+/g, ' ').slice(0, 300)
    return { triggers, title, snippet }
  } catch {
    return null
  }
}

async function semanticSearch(query, opts = {}) {
  const limit = Math.max(1, Math.min(50, opts.limit | 0 || 10))
  const tokens = _tokenise(query)

  let entries = []
  try {
    entries = fs.readdirSync(PATTERNS_DIR)
      .filter(f => f.endsWith('.md') && f !== 'INDEX.md')
  } catch (err) {
    logger.warn('patternsRetrieval: readdir failed', { error: err.message, dir: PATTERNS_DIR })
  }

  const matches = []
  for (const file of entries) {
    const fp = path.join(PATTERNS_DIR, file)
    const meta = _readPatternMeta(fp)
    if (!meta) continue
    const triggerHay = meta.triggers.join(' ').toLowerCase()
    const titleHay = meta.title.toLowerCase()
    const snippetHay = meta.snippet.toLowerCase()
    let score = 0
    for (const t of tokens) {
      if (triggerHay.includes(t)) score += 3
      if (titleHay.includes(t)) score += 2
      if (snippetHay.includes(t)) score += 1
    }
    if (score > 0) {
      matches.push({
        path: fp,
        title: meta.title,
        triggers: meta.triggers,
        snippet: meta.snippet,
        score,
      })
    }
  }

  matches.sort((a, b) => b.score - a.score)

  if (matches.length === 0) {
    try {
      const neo = await neo4jRetrieval.semanticSearch(query, { labels: ['Pattern'], limit })
      return neo.map(n => ({
        path: null,
        title: n.name,
        triggers: [],
        snippet: n.description || '',
        score: n.score || 0,
        source: 'neo4j',
      }))
    } catch (err) {
      logger.warn('patternsRetrieval: neo4j fallback failed', { error: err.message })
      return []
    }
  }

  return matches.slice(0, limit)
}

module.exports = { semanticSearch, _tokenise, _readPatternMeta, PATTERNS_DIR }
