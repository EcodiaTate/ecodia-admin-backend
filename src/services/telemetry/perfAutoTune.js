/**
 * perfAutoTune.js
 *
 * Phase E (Layer 6) per-primitive performance regression detector.
 * See: ~/ecodiaos/patterns/decision-quality-self-optimization-architecture.md
 *
 * For each primitive_name in primitive_perf_event:
 *   - Compute p50, p95, p99 over rolling 7d ("current window").
 *   - Compute p95 over rolling 30d ending 7d ago ("baseline window") so the
 *     baseline is not contaminated by the regression we're trying to detect.
 *   - delta_vs_30d_baseline = (current_p95 - baseline_p95) / baseline_p95
 *   - If delta > 0.5 (50% regression) AND current_window_count >= 100,
 *     write a P2 status_board flag `perf_regression: <primitive> p95 +<X>%`.
 *   - Auto-retrain: a regression flag is "accepted as new normal" if p95 stays
 *     within +-20% of the new value for 7 consecutive days. Tracking lives in
 *     kv_store key `perf_autotune.baseline.<primitive>` so we don't poison the
 *     baseline forever on a single bad day.
 *
 * Schedule: `decision-quality-perf-autotune` every 24h.
 *
 * Sample-count gating: never flag regression on n < 100. Statistical noise
 * dominates below that. This is the spec hard constraint.
 *
 * Internal-only: never instrument or flag regressions on client codebase code.
 *
 * Invocation:
 *   node src/services/telemetry/perfAutoTune.js --once
 */

'use strict'

const { Client } = require('pg')

let _env = null
function getEnv() {
  if (_env) return _env
  _env = require('../../config/env')
  return _env
}

const REGRESSION_THRESHOLD = 0.5      // 50% p95 worsening triggers a flag
const MIN_SAMPLE_COUNT = 100          // gate; statistical noise dominates below this
const ACCEPT_BAND = 0.2               // +-20% of new value to accept it as the new baseline
const ACCEPT_DAYS = 7                 // must hold within band for this many consecutive daily ticks

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
 * Compute p50/p95/p99/count for one primitive over an arbitrary interval.
 * Uses Postgres percentile_cont aggregates so we don't pull rows into Node.
 */
async function percentilesFor(client, primitive, intervalSql) {
  const r = await client.query(`
    SELECT
      COUNT(*)::int                                                              AS sample_count,
      COALESCE(percentile_cont(0.5)  WITHIN GROUP (ORDER BY duration_ms), 0)::int AS p50_ms,
      COALESCE(percentile_cont(0.95) WITHIN GROUP (ORDER BY duration_ms), 0)::int AS p95_ms,
      COALESCE(percentile_cont(0.99) WITHIN GROUP (ORDER BY duration_ms), 0)::int AS p99_ms
    FROM primitive_perf_event
    WHERE primitive_name = $1
      AND ts > NOW() - ${intervalSql}
      AND ts <= NOW()
      AND status = 'ok'
  `, [primitive])
  return r.rows[0]
}

/**
 * Same as percentilesFor but for a windowed past slice (ts BETWEEN start AND end).
 * Used for the baseline window which ENDS 7d ago.
 */
async function percentilesForWindow(client, primitive, startIntervalSql, endIntervalSql) {
  const r = await client.query(`
    SELECT
      COUNT(*)::int                                                              AS sample_count,
      COALESCE(percentile_cont(0.5)  WITHIN GROUP (ORDER BY duration_ms), 0)::int AS p50_ms,
      COALESCE(percentile_cont(0.95) WITHIN GROUP (ORDER BY duration_ms), 0)::int AS p95_ms,
      COALESCE(percentile_cont(0.99) WITHIN GROUP (ORDER BY duration_ms), 0)::int AS p99_ms
    FROM primitive_perf_event
    WHERE primitive_name = $1
      AND ts > NOW() - ${startIntervalSql}
      AND ts <= NOW() - ${endIntervalSql}
      AND status = 'ok'
  `, [primitive])
  return r.rows[0]
}

async function listPrimitives(client) {
  const r = await client.query(`
    SELECT primitive_name, COUNT(*)::int AS total_count
    FROM primitive_perf_event
    WHERE ts > NOW() - INTERVAL '60 days'
    GROUP BY primitive_name
    ORDER BY total_count DESC
  `)
  return r.rows.map(r => r.primitive_name)
}

/**
 * Read the persisted baseline value for a primitive, if any. Stored in kv_store
 * as JSON: {p95_ms, in_band_days, set_at}.
 */
async function readBaseline(client, primitive) {
  const r = await client.query(
    `SELECT value FROM kv_store WHERE key = $1`,
    [`perf_autotune.baseline.${primitive}`]
  )
  if (r.rowCount === 0) return null
  try {
    const v = r.rows[0].value
    return (typeof v === 'string') ? JSON.parse(v) : v
  } catch { return null }
}

async function writeBaseline(client, primitive, payload) {
  // Normalize to text - kv_store value column may be jsonb or text depending on schema.
  // Use upsert.
  const json = JSON.stringify(payload)
  await client.query(`
    INSERT INTO kv_store (key, value, updated_at)
    VALUES ($1, $2::jsonb, NOW())
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()
  `, [`perf_autotune.baseline.${primitive}`, json])
}

/**
 * Compute regression flags. Returns array of flag objects ready for status_board.
 * Each row mutates the perf_autotune.baseline.<primitive> kv_store entry to track
 * acceptance progress.
 */
async function computeRegressions() {
  return withClient(async (client) => {
    const primitives = await listPrimitives(client)
    const flags = []
    const ticks = []

    for (const primitive of primitives) {
      // Current window: last 7d.
      const cur = await percentilesFor(client, primitive, "INTERVAL '7 days'")
      // Baseline window: 30d up to 7d ago.
      const base = await percentilesForWindow(client, primitive, "INTERVAL '37 days'", "INTERVAL '7 days'")
      const persisted = await readBaseline(client, primitive)
      const baselineP95 = (persisted && Number.isFinite(persisted.p95_ms))
        ? persisted.p95_ms
        : (base && base.p95_ms ? base.p95_ms : null)

      ticks.push({
        primitive,
        current: cur,
        rolling_baseline: base,
        persisted_baseline: persisted,
        baseline_used_p95_ms: baselineP95,
      })

      // Sample-count gating - never act on noise.
      if (!cur || cur.sample_count < MIN_SAMPLE_COUNT) continue
      if (!baselineP95 || baselineP95 <= 0) {
        // No baseline yet; seed it with the current p95.
        await writeBaseline(client, primitive, {
          p95_ms: cur.p95_ms, in_band_days: 0, set_at: new Date().toISOString(), reason: 'seed',
        })
        continue
      }

      const delta = (cur.p95_ms - baselineP95) / baselineP95

      // Acceptance tracking: if current_p95 within +-ACCEPT_BAND of persisted baseline
      // for ACCEPT_DAYS consecutive ticks, accept the current as the new normal.
      const inBand = Math.abs(delta) <= ACCEPT_BAND
      let nextBaselinePayload = persisted
        ? { ...persisted }
        : { p95_ms: baselineP95, in_band_days: 0, set_at: new Date().toISOString(), reason: 'rolling-bootstrap' }
      if (inBand) {
        nextBaselinePayload.in_band_days = (nextBaselinePayload.in_band_days || 0) + 1
        if (nextBaselinePayload.in_band_days >= ACCEPT_DAYS) {
          // Accept: shift baseline to current p95, reset counter.
          nextBaselinePayload = {
            p95_ms: cur.p95_ms,
            in_band_days: 0,
            set_at: new Date().toISOString(),
            reason: `auto-accepted after ${ACCEPT_DAYS} in-band days`,
          }
        }
      } else {
        nextBaselinePayload.in_band_days = 0
      }
      await writeBaseline(client, primitive, nextBaselinePayload)

      // Flag regressions: delta > REGRESSION_THRESHOLD (50%).
      if (delta > REGRESSION_THRESHOLD) {
        const pct = Math.round(delta * 100)
        flags.push({
          flag_type: 'perf_regression',
          name: `perf_regression: ${primitive} p95 +${pct}%`,
          context: `${primitive} current p95=${cur.p95_ms}ms vs baseline ${baselineP95}ms (n=${cur.sample_count}). 50% regression threshold breached. Investigate upstream: hot-path doctrine corpus growth, downstream service latency, or infra change. Auto-acceptance after ${ACCEPT_DAYS} in-band days will retrain baseline.`,
          next_action: `Investigate ${primitive} regression; sample window 7d, baseline window 30d ending 7d ago.`,
          primitive,
          current_p95_ms: cur.p95_ms,
          baseline_p95_ms: baselineP95,
          delta_pct: pct,
          sample_count: cur.sample_count,
        })
      }
    }
    return { flags, ticks }
  })
}

/**
 * Insert a P2 status_board row per regression flag. Dedupes by name within the
 * same calendar day so the cron firing daily doesn't accumulate duplicates if
 * the regression persists.
 */
async function insertStatusBoardFlags(flags) {
  if (!flags || flags.length === 0) return { inserted: 0 }
  return withClient(async (client) => {
    let inserted = 0
    for (const flag of flags) {
      try {
        // Dedupe: skip if a row with the same name was inserted in the last 24h
        // (covers daily cron retriggering on a still-broken metric).
        const dup = await client.query(
          `SELECT id FROM status_board
           WHERE name = $1
             AND archived_at IS NULL
             AND last_touched > NOW() - INTERVAL '24 hours'
           LIMIT 1`,
          [flag.name]
        )
        if (dup.rowCount > 0) continue

        await client.query(
          `INSERT INTO status_board (entity_type, name, status, next_action, next_action_by, priority, context, last_touched)
           VALUES ('infrastructure', $1, 'flagged', $2, 'ecodiaos', 2, $3, NOW())`,
          [flag.name, flag.next_action, flag.context]
        )
        inserted += 1
      } catch (err) {
        console.error('[perf-autotune] status_board insert failed:', err.message)
      }
    }
    return { inserted }
  })
}

async function runOnce() {
  try {
    const { flags, ticks } = await computeRegressions()
    const sb = await insertStatusBoardFlags(flags)
    const result = {
      ok: true,
      tick_count: ticks.length,
      flag_count: flags.length,
      inserted_status_board_rows: sb.inserted,
      flags,
    }
    console.log('[perf-autotune] tick complete:', JSON.stringify(result))
    return result
  } catch (err) {
    console.error('[perf-autotune] tick failed:', err.message)
    return { ok: false, error: err.message }
  }
}

if (require.main === module) {
  runOnce()
    .then(result => process.exit(result && result.ok ? 0 : 1))
    .catch(err => { console.error(err); process.exit(1) })
}

module.exports = {
  computeRegressions,
  insertStatusBoardFlags,
  runOnce,
  // Exposed for tests.
  _internals: { percentilesFor, percentilesForWindow, readBaseline, writeBaseline },
}
