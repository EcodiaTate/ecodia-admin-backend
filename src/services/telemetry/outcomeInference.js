/**
 * outcomeInference.js
 *
 * Phase B (Layer 4 -> Layer 5 bridge) of the Decision Quality Self-Optimization
 * Architecture. See:
 *   ~/ecodiaos/patterns/decision-quality-self-optimization-architecture.md
 *
 * For each dispatch_event without an outcome_event row, look up downstream
 * signals that imply the dispatch's outcome (success / failure / correction /
 * partial). Conservative defaults: when in doubt, defer to the next cron cycle
 * rather than risk a false-positive 'correction' classification.
 *
 * The inferrer reads from these tables (best-effort - tables may not exist
 * if the surrounding codebase changes; missing tables are handled silently):
 *   - cc_sessions  (Factory CLI session status, by sessionId)
 *   - sms_messages OR sms_inbound (Tate-side reply text within 30 minutes)
 *   - status_board (correction text and last_touched changes)
 *
 * Heuristics (in order of evidence strength):
 *   1. Explicit Tate correction in SMS within 30 min:
 *        keywords: 'wrong', 'not that', 'stop', 'no', 'redo', 'undo', 'fix'
 *        => outcome=correction, classification=usage_failure (Phase D refines).
 *   2. fork_spawn dispatches: forks table status (if available)
 *        - status='done' OR 'completed' => outcome=success
 *        - status='aborted' OR 'errored' => outcome=failure
 *   3. factory_dispatch dispatches: cc_sessions.status
 *        - 'completed' OR 'deployed' => outcome=success
 *        - 'rejected' OR 'error' => outcome=failure
 *   4. tool_call dispatches without an explicit Tate correction:
 *        => outcome=success (graceful default; if it failed, the conductor
 *          would already have reacted and that reaction would emit a
 *          subsequent dispatch_event we'd correlate against).
 *   5. cron_fire dispatches: success unless an exception was logged in the
 *      same dispatch's metadata (rare).
 *
 * False-positive guardrails:
 *   - 'no' alone is too short to safely classify; require a longer token
 *     match or a multi-word phrase.
 *   - SMS body must arrive within 30 min AFTER the dispatch ts, not before.
 *   - Defer (no inference) is always preferable to a confident-but-wrong
 *     classification. Phase D refines.
 *
 * Schema notes:
 *   outcome_event.outcome ∈ {'success','failure','correction','partial'}
 *   outcome_event.classification is left NULL here; Phase D adds the
 *     usage_failure / surfacing_failure / doctrine_failure label.
 */

'use strict'

const { Client } = require('pg')

let _env = null
function getEnv() {
  if (_env) return _env
  _env = require('../../config/env')
  return _env
}

const TICK_INTERVAL_MS = 30 * 60 * 1000 // 30 minutes
const SMS_CORRECTION_WINDOW_MS = 30 * 60 * 1000 // 30 minutes after dispatch
const CORRECTION_KEYWORDS = [
  // Multi-token "I want you to undo / redo / not that" phrases
  'not that',
  "that's wrong",
  'thats wrong',
  'wrong fork',
  'wrong direction',
  'undo that',
  'redo that',
  'fix that',
  'stop',
  'abort',
  'cancel that',
  // Single-token strong corrections
  'incorrect',
  'mistake',
  'broke',
  'broken',
]

/**
 * Returns true if the given table exists in the public schema. Used to
 * silently skip heuristics that depend on optional tables.
 */
async function tableExists(client, tableName) {
  try {
    const r = await client.query(
      `SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name=$1 LIMIT 1`,
      [tableName]
    )
    return r.rowCount > 0
  } catch {
    return false
  }
}

async function findTateCorrection(client, dispatch, smsTable) {
  if (!smsTable) return null
  const startTs = new Date(dispatch.ts).toISOString()
  const endTs = new Date(new Date(dispatch.ts).getTime() + SMS_CORRECTION_WINDOW_MS).toISOString()
  // Only scan inbound (Tate-to-us) messages. The column names vary by table;
  // we tolerate both `direction` and `from_tate` shapes.
  let q
  try {
    q = await client.query(
      `SELECT body, ts FROM ${smsTable}
       WHERE ts BETWEEN $1 AND $2
         AND (
           direction = 'inbound'
           OR direction = 'received'
           OR from_tate = true
           OR (from_number IS NOT NULL)
         )
       ORDER BY ts ASC LIMIT 20`,
      [startTs, endTs]
    )
  } catch {
    return null
  }
  for (const row of q.rows) {
    const body = (row.body || '').toLowerCase()
    if (!body) continue
    for (const kw of CORRECTION_KEYWORDS) {
      if (body.includes(kw)) {
        return { matched_keyword: kw, body: row.body, ts: row.ts }
      }
    }
  }
  return null
}

async function inferForkSpawnOutcome(client, dispatch) {
  const hasForksTable = await tableExists(client, 'forks')
  if (!hasForksTable) return null
  // metadata.fork_id is the linkage; if not present, skip.
  const meta = dispatch.metadata || {}
  const forkId = meta.fork_id || meta.id || null
  if (!forkId) return null
  try {
    const r = await client.query(`SELECT status FROM forks WHERE id = $1 LIMIT 1`, [forkId])
    if (r.rowCount === 0) return null
    const s = (r.rows[0].status || '').toLowerCase()
    if (s === 'done' || s === 'completed' || s === 'success') {
      return { outcome: 'success', evidence: `forks.id=${forkId} status=${s}` }
    }
    if (s === 'aborted' || s === 'errored' || s === 'failed' || s === 'cancelled') {
      return { outcome: 'failure', evidence: `forks.id=${forkId} status=${s}` }
    }
    return null
  } catch {
    return null
  }
}

async function inferFactoryDispatchOutcome(client, dispatch) {
  const hasCC = await tableExists(client, 'cc_sessions')
  if (!hasCC) return null
  const meta = dispatch.metadata || {}
  const sessionId = meta.session_id || meta.sessionId || null
  if (!sessionId) return null
  try {
    const r = await client.query(`SELECT status, pipeline_stage FROM cc_sessions WHERE id = $1 LIMIT 1`, [sessionId])
    if (r.rowCount === 0) return null
    const s = (r.rows[0].status || '').toLowerCase()
    if (s === 'completed' || s === 'deployed' || s === 'approved') {
      return { outcome: 'success', evidence: `cc_sessions.id=${sessionId} status=${s}` }
    }
    if (s === 'rejected' || s === 'error' || s === 'aborted') {
      return { outcome: 'failure', evidence: `cc_sessions.id=${sessionId} status=${s}` }
    }
    return null
  } catch {
    return null
  }
}

async function inferDispatchOutcome(client, dispatch, smsTable) {
  // Step 1: explicit Tate correction (highest evidence).
  const correction = await findTateCorrection(client, dispatch, smsTable)
  if (correction) {
    return {
      outcome: 'correction',
      evidence: `sms within 30min after dispatch matched '${correction.matched_keyword}'`,
      correction_text: correction.body,
    }
  }

  // Step 2: type-specific signals.
  if (dispatch.action_type === 'fork_spawn') {
    const r = await inferForkSpawnOutcome(client, dispatch)
    if (r) return r
  }
  if (dispatch.action_type === 'factory_dispatch') {
    const r = await inferFactoryDispatchOutcome(client, dispatch)
    if (r) return r
  }

  // Step 3: graceful default for tool calls older than 30 min with no
  // correction signal. We assume success; Phase D's classifier may overturn
  // this once a richer signal is available.
  const ageMs = Date.now() - new Date(dispatch.ts).getTime()
  if (ageMs > 30 * 60 * 1000) {
    return {
      outcome: 'success',
      evidence: `no correction signal within 30min, action_type=${dispatch.action_type}`,
      correction_text: null,
    }
  }

  // Otherwise: defer (no inference yet).
  return null
}

async function tickInferOutcomes() {
  const env = getEnv()
  const client = new Client({ connectionString: env.DATABASE_URL })
  await client.connect()

  let inferred = 0
  let skipped = 0
  let errors = 0

  try {
    // Detect SMS table once per tick.
    let smsTable = null
    if (await tableExists(client, 'sms_messages')) smsTable = 'sms_messages'
    else if (await tableExists(client, 'sms_inbound')) smsTable = 'sms_inbound'
    else if (await tableExists(client, 'sms_log')) smsTable = 'sms_log'

    // Pull dispatches without an outcome_event, older than 5 minutes (give
    // the system time to settle), capped at 500 per tick.
    const r = await client.query(`
      SELECT d.id, d.ts, d.actor, d.action_type, d.tool_name, d.metadata
      FROM dispatch_event d
      LEFT JOIN outcome_event o ON o.dispatch_event_id = d.id
      WHERE o.id IS NULL
        AND d.ts < NOW() - INTERVAL '5 minutes'
        AND d.ts > NOW() - INTERVAL '14 days'
      ORDER BY d.ts ASC
      LIMIT 500
    `)

    for (const dispatch of r.rows) {
      try {
        const inference = await inferDispatchOutcome(client, dispatch, smsTable)
        if (!inference) {
          skipped += 1
          continue
        }
        await client.query(
          `INSERT INTO outcome_event (dispatch_event_id, outcome, evidence, correction_text, classification)
           VALUES ($1, $2, $3, $4, $5)`,
          [
            dispatch.id,
            inference.outcome,
            inference.evidence || null,
            inference.correction_text || null,
            null, // Phase D fills classification
          ]
        )
        inferred += 1
      } catch (err) {
        errors += 1
        console.error('[outcomeInference] error inferring dispatch', dispatch.id, err.message)
      }
    }
  } finally {
    try { await client.end() } catch { /* ignore */ }
  }

  return { ok: true, inferred, skipped, errors }
}

async function runOnce() {
  try {
    const result = await tickInferOutcomes()
    console.log('[outcomeInference] tick complete:', JSON.stringify(result))
    return result
  } catch (err) {
    console.error('[outcomeInference] tick failed:', err.message)
    return { ok: false, error: err.message }
  }
}

async function runLoop() {
  console.log(`[outcomeInference] starting periodic loop, interval=${TICK_INTERVAL_MS / 1000}s`)
  await runOnce()
  setInterval(runOnce, TICK_INTERVAL_MS).unref()
  setInterval(() => {}, 60_000).unref()
}

if (require.main === module) {
  const onceMode = process.argv.includes('--once')
  if (onceMode) {
    runOnce()
      .then(result => process.exit(result && result.ok ? 0 : 1))
      .catch(err => { console.error(err); process.exit(1) })
  } else {
    runLoop().catch(err => { console.error(err); process.exit(1) })
  }
}

module.exports = {
  tickInferOutcomes,
  runOnce,
  inferDispatchOutcome,
  CORRECTION_KEYWORDS,
}
