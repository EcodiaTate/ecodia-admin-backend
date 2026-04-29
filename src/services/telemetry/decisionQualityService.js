/**
 * decisionQualityService.js
 *
 * Backing service for `GET /api/telemetry/decision-quality`. Computes the four
 * Phase B observability panels:
 *   1. pattern_usage       - per pattern: surface_count, application_count, usage_rate
 *   2. failure_correlation - per pattern: applied_count, correction_count, correction_rate
 *   3. hook_fp_estimate    - per hook: surfaces, correction-adjacent count, FP estimate
 *   4. doctrine_coverage   - failure clusters with no doctrine surfaced
 *
 * See:
 *   ~/ecodiaos/patterns/decision-quality-self-optimization-architecture.md
 *
 * Drift signals (separate but available):
 *   - dormant_pattern_candidate: any pattern not surfaced in 90 days.
 *   - regression_signal: 24h windows with correction_rate > 30%.
 *   - silent_hook_candidate: any hook with surface_count = 0 in last 24h.
 *
 * The drift cron (`decision-quality-drift-check`) calls computeDriftSignals()
 * and inserts P3 status_board rows for new flags.
 */

'use strict'

const { Client } = require('pg')

let _env = null
function getEnv() {
  if (_env) return _env
  _env = require('../../config/env')
  return _env
}

async function withClient(fn) {
  const env = getEnv()
  const client = new Client({ connectionString: env.DATABASE_URL })
  await client.connect()
  try {
    return await fn(client)
  } finally {
    try { await client.end() } catch { /* ignore */ }
  }
}

/**
 * Panel 1: per-pattern surface vs application counts and usage_rate.
 */
async function patternUsage(client, days) {
  const r = await client.query(`
    WITH s AS (
      SELECT pattern_path, COUNT(*) AS surface_count
      FROM surface_event
      WHERE ts > NOW() - ($1 || ' days')::interval
      GROUP BY pattern_path
    ),
    a AS (
      SELECT pattern_path, COUNT(*) AS application_count
      FROM application_event
      WHERE ts > NOW() - ($1 || ' days')::interval
      GROUP BY pattern_path
    )
    SELECT s.pattern_path,
           s.surface_count,
           COALESCE(a.application_count, 0) AS application_count,
           CASE WHEN s.surface_count > 0
                THEN ROUND( (COALESCE(a.application_count, 0)::numeric / s.surface_count) , 4)
                ELSE 0
           END AS usage_rate
    FROM s LEFT JOIN a ON a.pattern_path = s.pattern_path
    ORDER BY s.surface_count DESC
    LIMIT 200
  `, [String(days)])
  return r.rows
}

/**
 * Panel 2: per-pattern application vs correction counts and correction_rate.
 */
async function failureCorrelation(client, days) {
  const r = await client.query(`
    WITH a AS (
      SELECT ae.pattern_path,
             ae.dispatch_event_id
      FROM application_event ae
      WHERE ae.ts > NOW() - ($1 || ' days')::interval
    ),
    c AS (
      SELECT a.pattern_path,
             COUNT(*) AS correction_count
      FROM a
      JOIN outcome_event o ON o.dispatch_event_id = a.dispatch_event_id
      WHERE o.outcome = 'correction'
      GROUP BY a.pattern_path
    ),
    counts AS (
      SELECT pattern_path, COUNT(*) AS applied_count
      FROM a
      GROUP BY pattern_path
    )
    SELECT counts.pattern_path,
           counts.applied_count,
           COALESCE(c.correction_count, 0) AS correction_count,
           CASE WHEN counts.applied_count > 0
                THEN ROUND( (COALESCE(c.correction_count, 0)::numeric / counts.applied_count) , 4)
                ELSE 0
           END AS correction_rate
    FROM counts LEFT JOIN c ON c.pattern_path = counts.pattern_path
    ORDER BY counts.applied_count DESC
    LIMIT 200
  `, [String(days)])
  return r.rows
}

/**
 * Panel 3: per-hook FP estimate. A surface is counted as a "hit" if its
 * dispatch_event has either an application_event referencing the same
 * pattern_path OR an outcome_event with outcome='correction'. The remainder
 * are FP candidates.
 */
async function hookFpEstimate(client, days) {
  const r = await client.query(`
    WITH s AS (
      SELECT id, dispatch_event_id, source_layer, pattern_path
      FROM surface_event
      WHERE ts > NOW() - ($1 || ' days')::interval
    ),
    hits AS (
      SELECT s.source_layer, COUNT(*) AS hit_count
      FROM s
      LEFT JOIN application_event ae
        ON ae.dispatch_event_id = s.dispatch_event_id
       AND ae.pattern_path = s.pattern_path
      LEFT JOIN outcome_event o
        ON o.dispatch_event_id = s.dispatch_event_id
       AND o.outcome = 'correction'
      WHERE ae.id IS NOT NULL OR o.id IS NOT NULL
      GROUP BY s.source_layer
    ),
    counts AS (
      SELECT source_layer, COUNT(*) AS surface_count
      FROM s
      GROUP BY source_layer
    )
    SELECT counts.source_layer,
           counts.surface_count,
           COALESCE(hits.hit_count, 0) AS hit_count,
           CASE WHEN counts.surface_count > 0
                THEN ROUND( ((counts.surface_count - COALESCE(hits.hit_count, 0))::numeric / counts.surface_count) , 4)
                ELSE 0
           END AS fp_estimate
    FROM counts LEFT JOIN hits ON hits.source_layer = counts.source_layer
    ORDER BY counts.surface_count DESC
  `, [String(days)])
  return r.rows
}

/**
 * Panel 4: failure clusters lacking doctrine. A "failure cluster" is any
 * dispatch_event with outcome=correction whose dispatch had ZERO surface_event
 * rows. The action keyword summary (top context_keywords for those dispatches)
 * highlights doctrine gaps.
 */
async function doctrineCoverage(client, days) {
  const r = await client.query(`
    WITH no_surface AS (
      SELECT d.id, d.action_type, d.tool_name, d.context_keywords
      FROM dispatch_event d
      JOIN outcome_event o ON o.dispatch_event_id = d.id
      LEFT JOIN surface_event s ON s.dispatch_event_id = d.id
      WHERE o.outcome = 'correction'
        AND d.ts > NOW() - ($1 || ' days')::interval
        AND s.id IS NULL
    )
    SELECT action_type,
           tool_name,
           COUNT(*) AS uncovered_correction_count,
           ARRAY_AGG(DISTINCT kw) FILTER (WHERE kw IS NOT NULL) AS top_keywords
    FROM no_surface ns
    LEFT JOIN LATERAL UNNEST(ns.context_keywords) AS kw ON true
    GROUP BY action_type, tool_name
    ORDER BY uncovered_correction_count DESC
    LIMIT 50
  `, [String(days)])
  return r.rows
}

/**
 * Aggregate summary for the response envelope.
 */
async function summary(client, days) {
  const r = await client.query(`
    SELECT
      (SELECT COUNT(*) FROM dispatch_event WHERE ts > NOW() - ($1 || ' days')::interval) AS dispatch_count,
      (SELECT COUNT(*) FROM surface_event  WHERE ts > NOW() - ($1 || ' days')::interval) AS surface_count,
      (SELECT COUNT(*) FROM application_event WHERE ts > NOW() - ($1 || ' days')::interval) AS application_count,
      (SELECT COUNT(*) FROM outcome_event WHERE ts > NOW() - ($1 || ' days')::interval) AS outcome_count,
      (SELECT COUNT(*) FROM outcome_event WHERE outcome='correction' AND ts > NOW() - ($1 || ' days')::interval) AS correction_count
  `, [String(days)])
  return r.rows[0] || {}
}

async function computeDecisionQuality({ days = 7 } = {}) {
  return withClient(async (client) => {
    const [s, p1, p2, p3, p4] = await Promise.all([
      summary(client, days),
      patternUsage(client, days),
      failureCorrelation(client, days),
      hookFpEstimate(client, days),
      doctrineCoverage(client, days),
    ])
    return {
      window_days: days,
      summary: s,
      pattern_usage: p1,
      failure_correlation: p2,
      hook_fp_estimate: p3,
      doctrine_coverage: p4,
    }
  })
}

/**
 * Drift signals. Returns a list of flag objects ready for status_board
 * insertion. The cron (`decision-quality-drift-check`) inserts P3 rows for
 * each flag and dedupes against pre-existing rows by name.
 */
async function computeDriftSignals() {
  return withClient(async (client) => {
    const flags = []

    // dormant_pattern_candidate: file_per_thing patterns that haven't surfaced in 90d.
    // We list every .md in patterns/ whose path doesn't appear in surface_event.
    const fs = require('fs')
    const path = require('path')
    const PATTERNS_DIR = '/home/tate/ecodiaos/patterns'
    let allPatternFiles = []
    try {
      allPatternFiles = fs.readdirSync(PATTERNS_DIR)
        .filter(f => f.endsWith('.md') && f !== 'INDEX.md')
        .map(f => path.join(PATTERNS_DIR, f))
    } catch { /* ignore */ }

    const surfaced = await client.query(`
      SELECT DISTINCT pattern_path FROM surface_event
      WHERE ts > NOW() - INTERVAL '90 days'
    `)
    const surfacedSet = new Set(surfaced.rows.map(r => r.pattern_path))

    for (const f of allPatternFiles) {
      if (!surfacedSet.has(f)) {
        flags.push({
          flag_type: 'dormant_pattern_candidate',
          name: `Dormant pattern: ${path.basename(f)}`,
          context: `Pattern file ${f} has not surfaced via any hook in 90 days. Either tighten its triggers, retire the doctrine, or expand its trigger keywords. See ~/ecodiaos/patterns/decision-quality-self-optimization-architecture.md for the drift protocol.`,
          next_action: `Review ${f} for trigger adequacy or retirement candidacy`,
        })
      }
    }

    // regression_signal: 24h windows with correction_rate > 30%.
    const regression = await client.query(`
      SELECT date_trunc('day', d.ts) AS day,
             COUNT(*) FILTER (WHERE o.outcome='correction') AS corrections,
             COUNT(*) AS total
      FROM dispatch_event d
      LEFT JOIN outcome_event o ON o.dispatch_event_id = d.id
      WHERE d.ts > NOW() - INTERVAL '14 days'
        AND o.id IS NOT NULL
      GROUP BY day
      HAVING COUNT(*) >= 5
         AND (COUNT(*) FILTER (WHERE o.outcome='correction')::numeric / COUNT(*)) > 0.3
      ORDER BY day DESC
      LIMIT 5
    `)
    for (const row of regression.rows) {
      flags.push({
        flag_type: 'regression_signal',
        name: `Decision-quality regression on ${row.day instanceof Date ? row.day.toISOString().slice(0, 10) : row.day}`,
        context: `${row.corrections}/${row.total} dispatches that day classified as 'correction' (>30% threshold). Investigate whether a doctrine drift, hook regression, or upstream tool change caused the spike.`,
        next_action: 'Investigate correction cluster for root-cause classification',
      })
    }

    // silent_hook_candidate: hook in source_layer enumeration with 0 surfaces in 24h.
    const knownLayers = ['hook:brief-consistency', 'hook:cred-mention', 'hook:doctrine-edit-cross-ref', 'hook:status-board-write']
    const recentLayers = await client.query(`
      SELECT DISTINCT source_layer FROM surface_event
      WHERE ts > NOW() - INTERVAL '24 hours'
    `)
    const recentSet = new Set(recentLayers.rows.map(r => r.source_layer))
    for (const layer of knownLayers) {
      // Note: this fires legitimately if the hook was never *needed* in 24h
      // (e.g. no doctrine-edit-cross-ref hook because no doctrine files were
      // edited). The drift cron treats it as a P3 information signal, not a
      // bug to fix. Tate-review distinguishes "no traffic" from "regression".
      if (!recentSet.has(layer)) {
        flags.push({
          flag_type: 'silent_hook_candidate',
          name: `Silent hook: ${layer} (24h)`,
          context: `Hook ${layer} emitted zero surface_event rows in the last 24 hours. Either no traffic legitimately reached this hook (acceptable) OR the hook's JSONL emission is broken (regression). Inspect ~/ecodiaos/logs/telemetry/dispatch-events.jsonl for recent hook fires from this layer.`,
          next_action: 'Verify whether silence is regression or low-traffic legitimate',
        })
      }
    }

    return flags
  })
}

module.exports = {
  computeDecisionQuality,
  computeDriftSignals,
}
