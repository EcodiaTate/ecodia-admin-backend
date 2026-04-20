/**
 * Structured incident log — one row per non-trivial failure.
 *
 * The OS reads this to diagnose itself. Not for a human dashboard.
 * Every callsite logs a normalized `kind` so the OS can group and
 * pattern-match without brittle substring matching.
 *
 * Writes are fire-and-forget: the log must never block or fail a turn.
 */

const db = require('../config/db')
const logger = require('../config/logger')

// Fixed vocabulary — keep this small. The OS learns to reason about
// these specific labels, so introducing new ones is a semantic break.
const KNOWN_KINDS = new Set([
  'turn_failure',        // SDK stream ended bad — empty, inactivity, tool hang
  'mcp_failure',         // MCP server unreachable or returned error repeatedly
  'provider_switch',     // Bedrock fallback triggered OR returned to Max
  'tool_hung',           // tool watchdog fired
  'db_error',            // postgres write/read failed after retries
  'redis_error',         // Redis connection lost / write failed
  'quota_warn',          // crossed 90%
  'alert_fired',         // an email alert was sent (so the OS can see what Tate knows)
  'cert_warning',        // TLS cert < warn threshold
  'neo4j_unreachable',   // KG context fetch failed
  'empty_sdk_stream',    // CC CLI exited with no result message
  'subsystem_recovered', // a previously-failed subsystem came back
  'context_reset',       // ccSessionId was nulled — auto-handover, stale-retry, empty-stream retry. Why matters.
])

async function log({ kind, severity = 'warn', component = null, message, context = {} }) {
  try {
    if (!KNOWN_KINDS.has(kind)) {
      // Log unknown kinds but still store them — don't lose signal because
      // a callsite drifted. Just warn so we notice vocabulary drift.
      logger.debug('osIncident: unknown kind', { kind })
    }
    await db`
      INSERT INTO os_incidents (kind, severity, component, message, context)
      VALUES (${kind}, ${severity}, ${component}, ${String(message || '').slice(0, 2000)}, ${context})
    `.catch(err => logger.debug('osIncident: write failed', { error: err.message, kind }))
  } catch (err) {
    // Swallow — incident logging must never break the caller's path.
    logger.debug('osIncident: log call crashed', { error: err.message })
  }
}

// ─── Queries the OS uses to diagnose itself ─────────────────────────────

async function recent({ hours = 24, kind = null, severity = null, limit = 50 } = {}) {
  const since = new Date(Date.now() - hours * 3_600_000)
  try {
    if (kind && severity) {
      return await db`
        SELECT kind, severity, component, message, context, created_at
        FROM os_incidents
        WHERE created_at >= ${since} AND kind = ${kind} AND severity = ${severity}
        ORDER BY created_at DESC LIMIT ${limit}
      `
    } else if (kind) {
      return await db`
        SELECT kind, severity, component, message, context, created_at
        FROM os_incidents
        WHERE created_at >= ${since} AND kind = ${kind}
        ORDER BY created_at DESC LIMIT ${limit}
      `
    } else if (severity) {
      return await db`
        SELECT kind, severity, component, message, context, created_at
        FROM os_incidents
        WHERE created_at >= ${since} AND severity = ${severity}
        ORDER BY created_at DESC LIMIT ${limit}
      `
    }
    return await db`
      SELECT kind, severity, component, message, context, created_at
      FROM os_incidents
      WHERE created_at >= ${since}
      ORDER BY created_at DESC LIMIT ${limit}
    `
  } catch (err) {
    logger.warn('osIncident.recent failed', { error: err.message })
    return []
  }
}

// Pattern view: buckets by (kind, component) with counts + first/last seen.
// This is the query the OS should lead with when asked "what's been going wrong".
async function patterns({ hours = 24 } = {}) {
  const since = new Date(Date.now() - hours * 3_600_000)
  try {
    return await db`
      SELECT kind, component, severity,
             COUNT(*)::int AS n,
             MIN(created_at) AS first_at,
             MAX(created_at) AS last_at
      FROM os_incidents
      WHERE created_at >= ${since}
      GROUP BY kind, component, severity
      ORDER BY n DESC, last_at DESC
      LIMIT 50
    `
  } catch (err) {
    logger.warn('osIncident.patterns failed', { error: err.message })
    return []
  }
}

// Summary counters for the heartbeat's grounded context — cheap single row
// so every heartbeat can check "is anything repeatedly failing right now?"
async function recentSummary({ hours = 4 } = {}) {
  const since = new Date(Date.now() - hours * 3_600_000)
  try {
    const rows = await db`
      SELECT
        COUNT(*)::int AS total,
        COUNT(*) FILTER (WHERE severity = 'critical')::int AS critical,
        COUNT(*) FILTER (WHERE severity = 'error')::int AS errors,
        COUNT(*) FILTER (WHERE kind = 'turn_failure')::int AS turn_failures,
        COUNT(*) FILTER (WHERE kind = 'tool_hung')::int AS tool_hangs,
        COUNT(*) FILTER (WHERE kind = 'provider_switch')::int AS provider_switches,
        COUNT(DISTINCT component) FILTER (WHERE severity IN ('error', 'critical')) AS distinct_failing_components
      FROM os_incidents
      WHERE created_at >= ${since}
    `
    return rows[0] || null
  } catch (err) {
    logger.warn('osIncident.recentSummary failed', { error: err.message })
    return null
  }
}

module.exports = { log, recent, patterns, recentSummary, KNOWN_KINDS }
