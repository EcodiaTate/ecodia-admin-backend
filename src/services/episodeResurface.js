/**
 * episodeResurface.js
 *
 * Phase F (Layer 7) of the Decision Quality Self-Optimization Architecture.
 * See: ~/ecodiaos/patterns/decision-quality-self-optimization-architecture.md
 *
 * This module is INTENTIONALLY a sibling of src/services/telemetry/, not a
 * member. While Phase D (failure-classifier) is unmerged on
 * `feat/phase-d-failure-classifier-2026-04-29`, the queue-audit pass-2 anti-rec
 * forbids any new edit under src/services/telemetry/*. Layer 7 is a NEW module
 * not an extension of Layer 4's telemetry, so the placement is correct on
 * its own merit — the constraint just makes it non-negotiable.
 *
 * Responsibilities:
 *   - resurfaceEpisodes(query, opts):       run a semantic search against
 *                                           Neo4j Episode nodes and return the
 *                                           top-K hits (above a min score).
 *   - recordResurfaces({...}, hits):        persist one episode_resurface_event
 *                                           row per hit. Idempotent at the
 *                                           caller's discretion (see metadata
 *                                           keys for dedup hooks).
 *   - markAcknowledgement({id, ack}):       fill in acknowledged_in_response
 *                                           after the dispatch response is
 *                                           inspected.
 *   - markRepeatedFailure({id, repeated}):  fill in repeated_failure once the
 *                                           dispatched action's outcome is
 *                                           classified.
 *   - getResurfaceFrequency({days}):        rolling-window aggregation for the
 *                                           /api/telemetry/episode-resurface
 *                                           dashboard panel.
 *   - getRepeatedFailureRate({days}):       Layer-7 primary health metric.
 *
 * Fail-open: any Neo4j or Postgres error is logged and yields an empty result
 * rather than throwing into the caller. The hot path here is dispatch
 * surfacing — a Layer-7 outage MUST NOT block forks or factory sessions.
 */

'use strict'

const db = require('../config/db')
const logger = require('../config/logger')
const neo4jRetrieval = require('./neo4jRetrieval')

const DEFAULT_LIMIT = 3
const DEFAULT_MIN_SCORE = 0.72

/**
 * Run a semantic search against Neo4j Episode nodes.
 *
 * @param {string} queryText - natural-language seed (typically the brief or
 *                             the proper-noun-rich slice of a dispatch).
 * @param {object} [opts]
 * @param {number} [opts.limit=3]       - max hits to return.
 * @param {number} [opts.minScore=0.72] - cosine threshold below which Episodes
 *                                        are dropped.
 * @returns {Promise<Array<{label,name,description,score}>>}
 */
async function resurfaceEpisodes(queryText, opts = {}) {
  const text = typeof queryText === 'string' ? queryText.trim() : ''
  if (!text) return []

  const limit = Number.isFinite(opts.limit) ? opts.limit : DEFAULT_LIMIT
  const minScore = Number.isFinite(opts.minScore) ? opts.minScore : DEFAULT_MIN_SCORE

  try {
    const hits = await neo4jRetrieval.semanticSearch(text, {
      limit,
      minScore,
      labels: ['Episode'],
      onlyCurrent: true,
    })
    return Array.isArray(hits) ? hits : []
  } catch (err) {
    // fail-open per module contract
    logger.warn('episodeResurface.resurfaceEpisodes failed', { error: err.message })
    return []
  }
}

/**
 * Persist resurface hits to episode_resurface_event.
 *
 * @param {object} ctx
 * @param {string} [ctx.dispatchEventId] - uuid of the originating dispatch_event
 * @param {string} [ctx.hookName]
 * @param {string} [ctx.toolName]
 * @param {object} [ctx.metadataExtra]   - merged into row.metadata
 * @param {Array}  hits                  - output from resurfaceEpisodes
 * @returns {Promise<{inserted:number, ids:number[]}>}
 */
async function recordResurfaces(ctx = {}, hits = []) {
  if (!Array.isArray(hits) || hits.length === 0) return { inserted: 0, ids: [] }

  const dispatchEventId = ctx.dispatchEventId || null
  const hookName = ctx.hookName || null
  const toolName = ctx.toolName || null

  const ids = []
  let inserted = 0

  for (const hit of hits) {
    if (!hit || typeof hit !== 'object') continue
    const nodeId = hit.id || hit.elementId || hit.name || null
    if (!nodeId) continue

    const metadata = JSON.stringify({
      ...(hit.metadata && typeof hit.metadata === 'object' ? hit.metadata : {}),
      ...(ctx.metadataExtra && typeof ctx.metadataExtra === 'object' ? ctx.metadataExtra : {}),
      query_seed: ctx.queryText ? String(ctx.queryText).slice(0, 800) : undefined,
      hit_label: hit.label,
      hit_name: hit.name,
      hit_description: typeof hit.description === 'string' ? hit.description.slice(0, 600) : undefined,
    })

    try {
      const rows = await db`
        INSERT INTO episode_resurface_event
          (dispatch_event_id, hook_name, tool_name,
           resurfaced_node_id, resurfaced_node_label, resurfaced_node_name,
           similarity_score, metadata)
        VALUES
          (${dispatchEventId}, ${hookName}, ${toolName},
           ${String(nodeId)}, ${hit.label || null}, ${hit.name || null},
           ${typeof hit.score === 'number' ? hit.score : null}, ${metadata}::jsonb)
        RETURNING id
      `
      if (rows && rows.length) {
        ids.push(rows[0].id)
        inserted += 1
      }
    } catch (err) {
      logger.warn('episodeResurface.recordResurfaces row insert failed', {
        error: err.message,
        nodeId,
      })
    }
  }

  return { inserted, ids }
}

/**
 * High-level helper: run semantic search AND persist in one call.
 *
 * @param {object} ctx
 * @param {string} ctx.queryText
 * @param {string} [ctx.dispatchEventId]
 * @param {string} [ctx.hookName]
 * @param {string} [ctx.toolName]
 * @param {object} [ctx.metadataExtra]
 * @param {number} [ctx.limit]
 * @param {number} [ctx.minScore]
 * @returns {Promise<{hits:Array, recorded:{inserted:number, ids:number[]}}>}
 */
async function runForDispatch(ctx = {}) {
  const queryText = ctx.queryText || ''
  const hits = await resurfaceEpisodes(queryText, {
    limit: ctx.limit,
    minScore: ctx.minScore,
  })
  const recorded = await recordResurfaces({ ...ctx, queryText }, hits)
  return { hits, recorded }
}

/**
 * Fill in acknowledged_in_response.
 */
async function markAcknowledgement({ id, ack }) {
  if (id == null) return { updated: 0 }
  try {
    const rows = await db`
      UPDATE episode_resurface_event
      SET acknowledged_in_response = ${ack === true}
      WHERE id = ${id}
      RETURNING id
    `
    return { updated: rows.length }
  } catch (err) {
    logger.warn('episodeResurface.markAcknowledgement failed', { error: err.message, id })
    return { updated: 0 }
  }
}

/**
 * Fill in repeated_failure (Layer-7 primary health metric).
 */
async function markRepeatedFailure({ id, repeated }) {
  if (id == null) return { updated: 0 }
  try {
    const rows = await db`
      UPDATE episode_resurface_event
      SET repeated_failure = ${repeated === true}
      WHERE id = ${id}
      RETURNING id
    `
    return { updated: rows.length }
  } catch (err) {
    logger.warn('episodeResurface.markRepeatedFailure failed', { error: err.message, id })
    return { updated: 0 }
  }
}

/**
 * Rolling-window resurface frequency, grouped by hook_name.
 */
async function getResurfaceFrequency({ days = 7 } = {}) {
  const d = Math.max(1, Math.min(90, parseInt(days, 10) || 7))
  try {
    const rows = await db`
      SELECT
        hook_name,
        COUNT(*) AS resurfaces,
        AVG(similarity_score) AS avg_score
      FROM episode_resurface_event
      WHERE ts >= now() - (${d}::int * INTERVAL '1 day')
      GROUP BY hook_name
      ORDER BY resurfaces DESC
    `
    return rows.map(r => ({
      hook_name: r.hook_name,
      resurfaces: Number(r.resurfaces),
      avg_score: r.avg_score == null ? null : Number(r.avg_score),
    }))
  } catch (err) {
    logger.warn('episodeResurface.getResurfaceFrequency failed', { error: err.message })
    return []
  }
}

/**
 * Layer-7 primary health metric:
 *   repeated_failure_rate = repeated / acked, over a rolling window.
 *
 * Rows where acknowledged_in_response IS NULL are excluded from the
 * denominator — we cannot judge repeated failure if we don't yet know whether
 * the resurfaced Episode was even consumed.
 */
async function getRepeatedFailureRate({ days = 30 } = {}) {
  const d = Math.max(1, Math.min(90, parseInt(days, 10) || 30))
  try {
    const rows = await db`
      SELECT
        COUNT(*) FILTER (WHERE acknowledged_in_response = TRUE) AS acked,
        COUNT(*) FILTER (
          WHERE acknowledged_in_response = TRUE AND repeated_failure = TRUE
        ) AS repeated,
        COUNT(*) AS total
      FROM episode_resurface_event
      WHERE ts >= now() - (${d}::int * INTERVAL '1 day')
    `
    const r = rows[0] || {}
    const acked = Number(r.acked || 0)
    const repeated = Number(r.repeated || 0)
    const total = Number(r.total || 0)
    return {
      window_days: d,
      total_resurfaces: total,
      acknowledged: acked,
      repeated_failures: repeated,
      repeated_failure_rate: acked > 0 ? repeated / acked : null,
    }
  } catch (err) {
    logger.warn('episodeResurface.getRepeatedFailureRate failed', { error: err.message })
    return {
      window_days: d,
      total_resurfaces: 0,
      acknowledged: 0,
      repeated_failures: 0,
      repeated_failure_rate: null,
    }
  }
}

module.exports = {
  resurfaceEpisodes,
  recordResurfaces,
  runForDispatch,
  markAcknowledgement,
  markRepeatedFailure,
  getResurfaceFrequency,
  getRepeatedFailureRate,
  // exposed for unit tests
  _DEFAULTS: { DEFAULT_LIMIT, DEFAULT_MIN_SCORE },
}
