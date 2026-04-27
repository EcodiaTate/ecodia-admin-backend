#!/usr/bin/env node
'use strict'

// =========================================================================
// PEER MONITOR -- AI-as-legal-entity landscape tracker
//
// Runs every 72h via the OS scheduler. Searches for new AI-managed / AI-member
// legal entities globally (sub-50 globally as of Apr 2026). Diffs results
// against the cached peer set in kv_store, writes new peers as Neo4j Peer
// nodes, and surfaces material finds to status_board.
//
// Spec: Neo4j Concept node 2543 "Peer Monitor Capability" (2026-04-27).
//
// Usage:
//   node src/scripts/peerMonitor.js              # live run
//   node src/scripts/peerMonitor.js --dry-run    # inspect without writing
//
// Re-exports runPeerMonitor for scheduler/require()-callers.
// =========================================================================

require('../config/env')

// Curated search queries -- from spec node 2543, unchanged on redispatch.
const SEARCH_QUERIES = [
  'AI-run company examples 2026 autonomous agent legal entity',
  'Wyoming DAO LLC AI sole member algorithmic manager',
  'KYA know your agent compliance implementations 2026',
  'AI agent wallet launches Skyfire Coinbase x402',
  'autonomous AI legal entity case study 2026',
]

// High-signal terms that trigger immediate status_board surfacing
// regardless of count threshold.
const HIGH_SIGNAL_KEYWORDS = [
  'wyoming dao llc ai',
  'kya-compliant operating business',
  'ai sole member legal entity',
]

// kv_store key for the cached peer set.
const KV_KEY = 'ceo.peer_monitor_seen'

// Minimum LLM-assigned confidence to accept a candidate as a peer.
const CONFIDENCE_THRESHOLD = 0.7

// Status-board surfacing threshold: 3+ new peers in one run OR any high-signal match.
const STATUS_BOARD_THRESHOLD = 3

// -- kv_store helpers -------------------------------------------------------

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

// -- Signal scoring ---------------------------------------------------------

function scorePeer(peer) {
  const signals = Array.isArray(peer.signals) ? peer.signals : []
  let score = 0
  let qualifyReason = null

  if (signals.includes('real_legal_entity')) { score += 3; qualifyReason = 'registered legal entity' }
  if (signals.includes('on_chain_identifier')) { score += 3; qualifyReason = qualifyReason || 'on-chain identifier present' }
  if (signals.includes('industry_cited')) { score += 2; qualifyReason = qualifyReason || 'cited in 2+ industry sources' }

  return { qualifies: score >= 2, qualifyReason: qualifyReason || 'insufficient signals' }
}

function isHighSignal(peer) {
  const text = [peer.name, peer.summary, ...(peer.signals || [])].join(' ').toLowerCase()
  return HIGH_SIGNAL_KEYWORDS.some(kw => text.includes(kw))
}

// -- Web search + extraction ------------------------------------------------
//
// Primary: Anthropic API with web_search_20250305 (requires ANTHROPIC_API_KEY).
// Fallback: callClaude via claudeService (knowledge-based, no live web).

async function runSearchQuery(client, query) {
  const logger = require('../config/logger')

  if (client) {
    try {
      const response = await client.messages.create({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 1024,
        tools: [{ type: 'web_search_20250305', name: 'web_search' }],
        betas: ['web-search-2025-03-05'],
        messages: [{
          role: 'user',
          content: `Search for: "${query}"\n\nFocus on specifically named AI-managed legal entities, autonomous AI companies, or on-chain DAOs where an AI is the sole or primary legal member/manager. Return a concise summary of any named entities found, including their legal form, jurisdiction, and any on-chain identifiers.`,
        }],
      })
      return response.content.filter(b => b.type === 'text').map(b => b.text).join('\n').trim()
    } catch (err) {
      logger.warn(`peerMonitor: web_search failed, using knowledge fallback — ${err.message.slice(0, 80)}`)
    }
  }

  // Fallback: knowledge-based query via factory bridge
  try {
    const { callClaude } = require('../services/claudeService')
    return await callClaude([{
      role: 'user',
      content: `Research task: ${query}\n\nFrom your training knowledge, list any specifically named AI-managed legal entities, autonomous AI companies, AI-run DAOs, or on-chain entities where an AI is the sole or primary legal member/manager. Include their legal form, jurisdiction, and any on-chain identifiers if known.`,
    }], { module: 'peer_monitor_search' })
  } catch (err) {
    logger.warn(`peerMonitor: fallback also failed for "${query.slice(0, 60)}"`, { error: err.message })
    return ''
  }
}

async function extractCandidates(client, searchSummaries) {
  const logger = require('../config/logger')
  const combined = searchSummaries.filter(Boolean).join('\n\n---\n\n')
  if (!combined.trim()) return []

  const prompt = `From these search summaries, extract entities matching this profile:

MUST HAVE at least one of:
- Real legal entity (registered company, LLC, DAO LLC, foundation)
- On-chain identifier (smart contract, blockchain registration)
- Cited by 2+ industry sources

EXCLUDE: generic AI agent frameworks, research papers, indie-hacker projects, vaporware.

Search summaries:
${combined}

Respond with JSON only:
{ "candidates": [{ "name": "entity name", "kind": "DAO LLC|LLC|Corp|Foundation|Protocol|Other", "jurisdiction": "US-WY|US-DE|on-chain|Australia|etc", "identifier": "contract address or registration ID or empty", "url": "source URL", "summary": "one sentence why it qualifies", "signals": ["real_legal_entity","on_chain_identifier","industry_cited"], "confidence": 0.0 }] }`

  if (client) {
    try {
      const response = await client.messages.create({
        model: 'claude-sonnet-4-6',
        max_tokens: 2048,
        messages: [{ role: 'user', content: prompt }],
      })
      const text = response.content.filter(b => b.type === 'text').map(b => b.text).join('')
      const cleaned = text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim()
      const parsed = JSON.parse(cleaned)
      if (Array.isArray(parsed.candidates)) return parsed.candidates
    } catch (err) {
      logger.warn('peerMonitor: direct extraction failed, trying factory bridge', { error: err.message })
    }
  }

  try {
    const { callClaudeJSON } = require('../services/claudeService')
    const parsed = await callClaudeJSON([{ role: 'user', content: prompt }], { module: 'peer_monitor_extract' })
    return Array.isArray(parsed.candidates) ? parsed.candidates : []
  } catch (err) {
    logger.warn('peerMonitor: candidate extraction failed', { error: err.message })
    return []
  }
}

// -- Neo4j writes -----------------------------------------------------------

async function writePeerNode(runWrite, peer) {
  await runWrite(`
    MERGE (p:Peer { name: $name })
    ON CREATE SET p.first_seen = $first_seen, p.created_at = datetime()
    SET p.kind = $kind, p.url = $url, p.summary = $summary,
        p.jurisdiction = $jurisdiction, p.identifier = $identifier,
        p.confidence = $confidence, p.signals = $signals, p.updated_at = datetime()
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

  const peerList = newPeers.map(p => ({ name: p.name, url: p.url || '' }))
  await db`
    INSERT INTO status_board (
      entity_type, name, status,
      next_action, next_action_by, priority,
      context, last_touched
    ) VALUES (
      'opportunity',
      ${'Peer-monitor: ' + newPeers.length + ' new peers worth review'},
      'surfaced',
      'Review new peers and decide newsletter angle',
      'tate',
      3,
      ${JSON.stringify(peerList)},
      NOW()
    )
  `.catch(() => {})
}

// -- Main export ------------------------------------------------------------

/**
 * runPeerMonitor({ dryRun = false })
 *
 * Runs curated WebSearches, diffs against the cached peer set, and writes
 * new peers to Neo4j + status_board.
 *
 * Returns: { scanned, candidates, new_peers, cache_size_after, new_peer_list }
 */
async function runPeerMonitor({ dryRun = false } = {}) {
  const db = require('../config/db')
  const { runWrite } = require('../config/neo4j')
  const env = require('../config/env')
  const logger = require('../config/logger')

  let client = null
  if (env.ANTHROPIC_API_KEY) {
    const Anthropic = require('@anthropic-ai/sdk')
    client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY })
    logger.info('peerMonitor: using Anthropic API (real-time web search)')
  } else {
    logger.info('peerMonitor: ANTHROPIC_API_KEY not set -- using knowledge-based fallback')
  }

  logger.info('peerMonitor: starting scan', { dryRun, queries: SEARCH_QUERIES.length })

  // 1. Load existing peer set
  const peerSet = await loadPeerSet(db)
  const knownNames = new Set(peerSet.map(p => p.name.toLowerCase().trim()))
  logger.info(`peerMonitor: loaded ${peerSet.length} known peers`)

  // 2. Run all search queries in parallel
  const searchSummaries = await Promise.all(SEARCH_QUERIES.map(q => runSearchQuery(client, q)))
  const scanned = searchSummaries.filter(Boolean).length
  logger.info(`peerMonitor: ${scanned}/${SEARCH_QUERIES.length} searches returned results`)

  // 3. Extract structured candidates from all summaries in one LLM call
  const rawCandidates = await extractCandidates(client, searchSummaries)
  logger.info(`peerMonitor: extracted ${rawCandidates.length} raw candidates`)

  // 4. Filter: qualify via scoring function, confidence threshold, not already known
  const newPeers = rawCandidates
    .map(c => {
      const { qualifies, qualifyReason } = scorePeer(c)
      return { ...c, qualifyReason, _qualifies: qualifies }
    })
    .filter(c => {
      if (!c._qualifies) return false
      if (typeof c.confidence !== 'number' || c.confidence < CONFIDENCE_THRESHOLD) return false
      if (!c.name || typeof c.name !== 'string') return false
      return !knownNames.has(c.name.toLowerCase().trim())
    })

  logger.info(`peerMonitor: ${newPeers.length} new peers qualify`, {
    dryRun,
    names: newPeers.map(p => p.name),
  })

  if (dryRun) {
    const wouldSurface = newPeers.length >= STATUS_BOARD_THRESHOLD || newPeers.some(isHighSignal)
    return {
      scanned,
      candidates: rawCandidates.length,
      new_peers: newPeers.length,
      new_peer_list: newPeers,
      cache_size_after: peerSet.length,
      wouldSurface,
      queries: SEARCH_QUERIES,
    }
  }

  // 5. Write new peers to Neo4j and update kv_store
  const written = []
  for (const peer of newPeers) {
    try {
      await writePeerNode(runWrite, peer)
      written.push(peer)
      logger.info(`peerMonitor: wrote Peer node "${peer.name}"`)
    } catch (err) {
      logger.warn(`peerMonitor: failed to write "${peer.name}"`, { error: err.message })
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
    await surfaceToStatusBoard(db, written)
  }

  const cacheSizeAfter = peerSet.length + written.length
  logger.info('peerMonitor: scan complete', {
    scanned,
    candidates: rawCandidates.length,
    new_peers: written.length,
    cache_size_after: cacheSizeAfter,
  })

  return {
    scanned,
    candidates: rawCandidates.length,
    new_peers: written.length,
    new_peer_list: written,
    cache_size_after: cacheSizeAfter,
  }
}

module.exports = { runPeerMonitor }

// -- CLI entry point --------------------------------------------------------

if (require.main === module) {
  const logger = require('./config/logger').child ? require('../config/logger') : require('../config/logger')
  const dryRun = process.argv.includes('--dry-run')

  if (dryRun) logger.info('peerMonitor: DRY-RUN mode -- no writes will occur')

  runPeerMonitor({ dryRun })
    .then(result => {
      if (dryRun) {
        const report = {
          candidatesEvaluated: result.candidates,
          qualifiedNew: result.new_peers,
          alreadySeen: result.cache_size_after - result.new_peers,
          wouldSurface: result.wouldSurface || false,
          queries: result.queries,
          new_peer_list: result.new_peer_list || [],
        }
        console.log('\n-- DRY RUN REPORT --')
        console.log(JSON.stringify(report, null, 2))
      }
      process.exit(0)
    })
    .catch(err => {
      require('../config/logger').error('peerMonitor: fatal error', { error: err.message })
      process.exit(1)
    })
}
