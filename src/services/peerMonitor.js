'use strict'

// =========================================================================
// PEER MONITOR -- AI-as-legal-entity landscape tracker
//
// Runs every 72h via the OS scheduler. Searches for new AI-managed / AI-member
// legal entities globally (sub-50 globally as of Apr 2026). Diffs results
// against the cached peer set in kv_store, writes new peers as Neo4j Peer
// nodes, and surfaces material finds to status_board.
//
// Spec: Neo4j Concept node "Peer-monitor capability for AI-as-legal-entity /
//       KYA-shaped projects" (created 2026-04-27 self-evolution session).
//
// All heavy dependencies are lazy-required inside runPeerMonitor() so this
// module can be imported in test contexts without a live DB or Neo4j connection.
// =========================================================================

// Curated search queries - edit here, not inline. Source: Neo4j node 2543.
const SEARCH_QUERIES = [
  'wyoming dao llc algorithmically-managed entity 2026',
  'AI sole member LLC formation announcement',
  'AI managed company on-chain identifier',
  'decentralized autonomous organization formation 2026 algorithmic manager',
  'agentic AI legal entity registered',
  'Know Your Agent KYA compliance entity',
]

// High-signal terms that trigger immediate status_board surfacing
// regardless of count threshold (per Neo4j spec node).
const HIGH_SIGNAL_KEYWORDS = [
  'wyoming dao llc ai',
  'kya-compliant operating business',
  'ai sole member legal entity',
]

// kv_store key for the cached peer set (Neo4j spec node wins on this name).
const KV_KEY = 'ceo.peer_monitor_seen'

// Minimum LLM-assigned confidence to accept a candidate as a peer.
const CONFIDENCE_THRESHOLD = 0.7

// Status-board surfacing threshold: 3+ new peers in one run OR any high-signal match.
const STATUS_BOARD_THRESHOLD = 3

// -- Helpers ----------------------------------------------------------------

async function loadPeerSet(db) {
  const rows = await db`SELECT value FROM kv_store WHERE key = ${KV_KEY}`
  if (!rows.length) return []
  const v = rows[0].value
  if (Array.isArray(v)) return v
  if (typeof v === 'string') {
    try { return JSON.parse(v) } catch { return [] }
  }
  return []
}

async function savePeerSet(db, peerSet) {
  await db`
    INSERT INTO kv_store (key, value)
    VALUES (${KV_KEY}, ${JSON.stringify(peerSet)})
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value
  `
}

function isHighSignal(peer) {
  const text = [peer.name, peer.summary, ...(peer.signals || [])].join(' ').toLowerCase()
  return HIGH_SIGNAL_KEYWORDS.some(kw => text.includes(kw))
}

// -- Web search + extraction ------------------------------------------------
//
// Primary: Anthropic API with web_search_20250305 (requires ANTHROPIC_API_KEY).
// Fallback: callClaude via factory bridge (knowledge-based, no live web access).
// TODO: wire to actual real-time WebSearch once ANTHROPIC_API_KEY is set in
//       the environment — currently routes to knowledge-based fallback.

async function runSearchQuery(client, query) {
  // Primary path: real web search via Anthropic API
  if (client) {
    try {
      const response = await client.messages.create({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 1024,
        tools: [{ type: 'web_search_20250305', name: 'web_search' }],
        betas: ['web-search-2025-03-05'],
        messages: [{
          role: 'user',
          content: `Search for: "${query}"\n\nFocus on finding specifically named AI-managed legal entities, autonomous AI companies, or on-chain DAOs where an AI is the sole or primary legal member/manager. Return a concise summary of any specific named entities found, including their legal form, jurisdiction, and any on-chain identifiers.`,
        }],
      })
      return response.content
        .filter(b => b.type === 'text')
        .map(b => b.text)
        .join('\n')
        .trim()
    } catch (err) {
      const logger = require('../config/logger')
      logger.warn(`peerMonitor: web_search failed, falling back to knowledge query — ${err.message.slice(0, 80)}`)
    }
  }

  // Fallback: knowledge-based query via factory bridge (works without API key)
  try {
    const { callClaude } = require('./claudeService')
    return await callClaude([{
      role: 'user',
      content: `Research task: ${query}\n\nFrom your training knowledge, list any specifically named AI-managed legal entities, autonomous AI companies, AI-run DAOs, or on-chain entities where an AI is the sole or primary legal member/manager. Focus on real registered entities, not theoretical concepts. Include their legal form, jurisdiction, and any on-chain identifiers if known.`,
    }], { module: 'peer_monitor_search' })
  } catch (err) {
    const logger = require('../config/logger')
    logger.warn(`peerMonitor: fallback search also failed for query "${query.slice(0, 60)}"`, { error: err.message })
    return ''
  }
}

async function extractCandidates(client, searchSummaries) {
  const combined = searchSummaries.filter(Boolean).join('\n\n---\n\n')
  if (!combined.trim()) return []

  const prompt = `You are an analyst identifying AI-managed legal entities. From the search summaries below, extract any entities that match this profile:

MUST HAVE at least one of:
- Real legal entity (registered company, LLC, DAO LLC, foundation)
- On-chain identifier (smart contract address, blockchain registration)
- Cited by 2 or more industry sources (a16z, Substack, law journals, crypto media)

EXCLUDE:
- Generic AI agent frameworks or software products
- Research papers or academic concepts
- Individual indie-hacker "AI agent" side projects
- Vaporware / unannounced projects

Search summaries:
${combined}

Respond with JSON only - no markdown, no explanation:
{
  "candidates": [
    {
      "name": "full entity name",
      "kind": "DAO LLC | LLC | Corp | Foundation | Protocol | Other",
      "jurisdiction": "US-WY | US-DE | on-chain | Australia | etc",
      "identifier": "registration ID, contract address, or empty string",
      "url": "most authoritative source URL",
      "summary": "one sentence describing what this entity is and why it qualifies",
      "signals": ["real_legal_entity", "on_chain_identifier", "industry_cited"],
      "confidence": 0.0
    }
  ]
}`

  // Primary: direct Anthropic API call (fast, structured)
  if (client) {
    try {
      const response = await client.messages.create({
        model: 'claude-sonnet-4-6',
        max_tokens: 2048,
        messages: [{ role: 'user', content: prompt }],
      })
      const text = response.content
        .filter(b => b.type === 'text')
        .map(b => b.text)
        .join('')
      const cleaned = text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim()
      const parsed = JSON.parse(cleaned)
      if (Array.isArray(parsed.candidates)) return parsed.candidates
    } catch (err) {
      const logger = require('../config/logger')
      logger.warn('peerMonitor: direct extraction failed, trying factory bridge', { error: err.message })
    }
  }

  // Fallback: factory bridge (works without API key)
  try {
    const { callClaudeJSON } = require('./claudeService')
    const parsed = await callClaudeJSON([{ role: 'user', content: prompt }], { module: 'peer_monitor_extract' })
    return Array.isArray(parsed.candidates) ? parsed.candidates : []
  } catch (err) {
    const logger = require('../config/logger')
    logger.warn('peerMonitor: candidate extraction failed', { error: err.message })
    return []
  }
}

// -- Neo4j writes -----------------------------------------------------------

async function writePeerNode(runWrite, peer) {
  // MERGE on name for idempotency. first_seen only set on creation.
  await runWrite(`
    MERGE (p:Peer { name: $name })
    ON CREATE SET
      p.first_seen = $first_seen,
      p.created_at = datetime()
    SET
      p.kind         = $kind,
      p.url          = $url,
      p.summary      = $summary,
      p.jurisdiction = $jurisdiction,
      p.identifier   = $identifier,
      p.confidence   = $confidence,
      p.signals      = $signals,
      p.updated_at   = datetime()
    WITH p
    MERGE (c:Concept { name: 'AI-as-legal-entity landscape 2026' })
    MERGE (p)-[:PART_OF]->(c)
  `, {
    name: peer.name,
    kind: peer.kind || 'Unknown',
    url: peer.url || '',
    first_seen: new Date().toISOString(),
    summary: peer.summary || '',
    jurisdiction: peer.jurisdiction || '',
    identifier: peer.identifier || '',
    confidence: typeof peer.confidence === 'number' ? peer.confidence : 0,
    signals: Array.isArray(peer.signals) ? peer.signals : [],
  })
}

// -- Status board surfacing -------------------------------------------------

async function surfaceToStatusBoard(db, newPeers) {
  const shouldSurface = newPeers.length >= STATUS_BOARD_THRESHOLD || newPeers.some(isHighSignal)
  if (!shouldSurface) return

  for (const peer of newPeers) {
    const context = `confidence=${peer.confidence}, signals=${(peer.signals || []).join(',')}`
    await db`
      INSERT INTO status_board (
        entity_type, name, status,
        next_action, next_action_by, priority,
        context, last_touched
      ) VALUES (
        'intelligence',
        ${'Peer detected: ' + peer.name},
        'new',
        'Review and decide if this peer warrants outreach or research',
        'ecodiaos',
        3,
        ${context},
        NOW()
      )
    `.catch(() => {})
  }
}

// -- Main export ------------------------------------------------------------

/**
 * runPeerMonitor({ dryRun = false })
 *
 * Runs curated WebSearches, diffs against the cached peer set, and writes
 * new peers to Neo4j + status_board.
 *
 * Returns: { scanned, candidates, new_peers, cache_size_after }
 */
async function runPeerMonitor({ dryRun = false } = {}) {
  const db = require('../config/db')
  const { runWrite } = require('../config/neo4j')
  const env = require('../config/env')
  const logger = require('../config/logger')

  // Build Anthropic client only if API key available. When absent, web_search
  // falls back to callClaude via factory bridge (knowledge-based, no live web).
  // TODO: set ANTHROPIC_API_KEY in environment to enable real-time web search.
  let client = null
  if (env.ANTHROPIC_API_KEY) {
    const Anthropic = require('@anthropic-ai/sdk')
    client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY })
    logger.info('peerMonitor: using Anthropic API (real-time web search)')
  } else {
    logger.info('peerMonitor: ANTHROPIC_API_KEY not set — using knowledge-based fallback via factory bridge')
  }

  logger.info('peerMonitor: starting scan', { dryRun, queries: SEARCH_QUERIES.length })

  // 1. Load existing peer set (names are the dedup key)
  const peerSet = await loadPeerSet(db)
  const knownNames = new Set(peerSet.map(p => p.name.toLowerCase().trim()))

  logger.info(`peerMonitor: loaded ${peerSet.length} known peers from cache`)

  // 2. Run all search queries in parallel
  const searchSummaries = await Promise.all(
    SEARCH_QUERIES.map(q => runSearchQuery(client, q))
  )
  const scanned = searchSummaries.filter(Boolean).length
  logger.info(`peerMonitor: ${scanned}/${SEARCH_QUERIES.length} searches returned results`)

  // 3. Extract structured candidates from all summaries in one LLM call
  const candidates = await extractCandidates(client, searchSummaries)
  logger.info(`peerMonitor: extracted ${candidates.length} candidates`)

  // 4. Filter: confidence threshold + not already known
  const newPeers = candidates.filter(c => {
    if (typeof c.confidence !== 'number' || c.confidence < CONFIDENCE_THRESHOLD) return false
    if (!c.name || typeof c.name !== 'string') return false
    return !knownNames.has(c.name.toLowerCase().trim())
  })

  logger.info(`peerMonitor: ${newPeers.length} new peers above threshold`, {
    dryRun,
    newPeerNames: newPeers.map(p => p.name),
  })

  if (dryRun) {
    return {
      scanned,
      candidates: candidates.length,
      new_peers: newPeers.length,
      new_peer_list: newPeers,
      cache_size_after: peerSet.length,
    }
  }

  // 5. Write new peers to Neo4j and update kv_store cache
  const written = []
  for (const peer of newPeers) {
    try {
      await writePeerNode(runWrite, peer)
      written.push(peer)
      logger.info(`peerMonitor: wrote Peer node "${peer.name}"`)
    } catch (err) {
      logger.warn(`peerMonitor: failed to write Peer node "${peer.name}"`, { error: err.message })
    }
  }

  if (written.length > 0) {
    const updatedSet = [
      ...peerSet,
      ...written.map(p => ({
        name: p.name,
        url: p.url || '',
        first_seen: new Date().toISOString(),
        last_seen: new Date().toISOString(),
        signals: p.signals || [],
        jurisdiction: p.jurisdiction || '',
        identifier: p.identifier || '',
      })),
    ]
    await savePeerSet(db, updatedSet)

    // 6. Surface material finds to status_board
    await surfaceToStatusBoard(db, written)
  }

  const cacheSizeAfter = peerSet.length + written.length

  logger.info('peerMonitor: scan complete', {
    scanned,
    candidates: candidates.length,
    new_peers: written.length,
    cache_size_after: cacheSizeAfter,
  })

  return {
    scanned,
    candidates: candidates.length,
    new_peers: written.length,
    cache_size_after: cacheSizeAfter,
  }
}

module.exports = { runPeerMonitor }
