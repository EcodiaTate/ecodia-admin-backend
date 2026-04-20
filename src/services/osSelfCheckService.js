/**
 * os_self_check — one call, the OS gets a structured picture of its own health.
 *
 * Every subsystem probe runs in parallel with a short timeout. A probe that
 * times out returns as 'unknown' rather than blocking the self-check. Total
 * wall time is bounded by the slowest probe or the overall deadline (8s).
 *
 * Designed for the OS to consume, not a human dashboard:
 *   - Fixed structure with stable keys
 *   - Every probe returns { ok: bool, detail: {...} } so the OS can branch
 *   - Rolls up to a single top-level `status` ('healthy'|'degraded'|'critical')
 *   - Includes the recent-incident summary so patterns are visible in one shot
 *
 * This is the primary introspection surface. The OS should call it:
 *   - On heartbeat wake when something feels off
 *   - After a turn that had retries
 *   - When a user SMS asks "is everything ok"
 */

const db = require('../config/db')
const logger = require('../config/logger')
const usageEnergy = require('./usageEnergyService')

const PROBE_TIMEOUT_MS = 3_000
const OVERALL_DEADLINE_MS = 8_000

function _withTimeout(promise, ms, fallback) {
  return Promise.race([
    promise,
    new Promise(resolve => setTimeout(() => resolve(fallback), ms)),
  ])
}

// ─── Individual probes ──────────────────────────────────────────────────
// Each returns { ok, detail } — never throws.

async function _probeDb() {
  try {
    const started = Date.now()
    const rows = await _withTimeout(
      db`SELECT 1 AS ping`,
      PROBE_TIMEOUT_MS,
      null,
    )
    if (!rows) return { ok: false, detail: { error: 'timeout' } }
    return { ok: true, detail: { latencyMs: Date.now() - started } }
  } catch (err) {
    return { ok: false, detail: { error: err.message } }
  }
}

async function _probeRedis() {
  try {
    const { getRedisClient } = require('../config/redis')
    const client = getRedisClient()
    if (!client) return { ok: false, detail: { error: 'not_configured' } }
    const started = Date.now()
    const pong = await _withTimeout(client.ping(), PROBE_TIMEOUT_MS, null)
    if (pong !== 'PONG') return { ok: false, detail: { error: `unexpected: ${pong}` } }
    return { ok: true, detail: { latencyMs: Date.now() - started, status: client.status } }
  } catch (err) {
    return { ok: false, detail: { error: err.message } }
  }
}

async function _probeNeo4j() {
  // Light check: try opening a session and running a trivial query.
  try {
    const neo4j = (() => { try { return require('neo4j-driver') } catch { return null } })()
    if (!neo4j) return { ok: false, detail: { error: 'driver_missing' } }
    const uri = process.env.NEO4J_URI
    const user = process.env.NEO4J_USER || 'neo4j'
    const password = process.env.NEO4J_PASSWORD
    if (!uri || !password) return { ok: false, detail: { error: 'not_configured' } }
    const driver = neo4j.driver(uri, neo4j.auth.basic(user, password), { connectionTimeout: PROBE_TIMEOUT_MS })
    const started = Date.now()
    try {
      const session = driver.session()
      try {
        await _withTimeout(session.run('RETURN 1 AS ping'), PROBE_TIMEOUT_MS, null)
      } finally {
        await session.close()
      }
    } finally {
      await driver.close()
    }
    return { ok: true, detail: { latencyMs: Date.now() - started } }
  } catch (err) {
    return { ok: false, detail: { error: err.message } }
  }
}

async function _probeClaudeEnergy() {
  try {
    const energy = await _withTimeout(usageEnergy.getEnergy(), PROBE_TIMEOUT_MS, null)
    if (!energy) return { ok: false, detail: { error: 'timeout' } }
    const ok = !energy.isBedrockFallback && (energy.level !== 'critical')
    return {
      ok,
      detail: {
        provider: energy.currentProvider,
        level: energy.level,
        pctUsed: energy.pctUsed,
        isBedrockFallback: !!energy.isBedrockFallback,
        accounts: {
          claude_max: energy.accounts?.claude_max ? {
            pctUsed: energy.accounts.claude_max.pctUsed,
            rateLimitStatus: energy.accounts.claude_max.rateLimitStatus,
          } : null,
          claude_max_2: energy.accounts?.claude_max_2 ? {
            pctUsed: energy.accounts.claude_max_2.pctUsed,
            rateLimitStatus: energy.accounts.claude_max_2.rateLimitStatus,
          } : null,
        },
      },
    }
  } catch (err) {
    return { ok: false, detail: { error: err.message } }
  }
}

async function _probeCert() {
  try {
    const certMonitor = require('./certMonitorService')
    const status = certMonitor.getStatus?.()
    if (!status) return { ok: true, detail: { note: 'monitor_unavailable' } }
    const days = status.lastDaysRemaining
    if (days == null) return { ok: true, detail: { note: 'no_recent_check' } }
    return {
      ok: days > 3,
      detail: { daysRemaining: days, lastCheckedAt: status.lastCheckedAt },
    }
  } catch (err) {
    return { ok: false, detail: { error: err.message } }
  }
}

async function _probeHeartbeat() {
  try {
    const hb = require('./osHeartbeatService')
    const status = hb.getStatus?.()
    if (!status) return { ok: false, detail: { error: 'service_missing' } }
    return {
      ok: !!status.running,
      detail: {
        running: status.running,
        lastHeartbeatAgeMin: status.ageMs ? Math.round(status.ageMs / 60000) : null,
      },
    }
  } catch (err) {
    return { ok: false, detail: { error: err.message } }
  }
}

async function _probeFactory() {
  try {
    const rows = await _withTimeout(
      db`
        SELECT
          COUNT(*) FILTER (WHERE status = 'running')::int AS running,
          COUNT(*) FILTER (WHERE pipeline_stage = 'awaiting_review')::int AS awaiting_review,
          COUNT(*) FILTER (WHERE status = 'running' AND started_at < now() - interval '30 minutes')::int AS stuck_running
        FROM cc_sessions
      `,
      PROBE_TIMEOUT_MS,
      null,
    )
    if (!rows) return { ok: false, detail: { error: 'timeout' } }
    const r = rows[0] || {}
    const ok = (r.stuck_running || 0) === 0
    return { ok, detail: { running: r.running, awaiting_review: r.awaiting_review, stuck_running: r.stuck_running } }
  } catch (err) {
    return { ok: false, detail: { error: err.message } }
  }
}

async function _probeIncidents() {
  try {
    const { recentSummary } = require('./osIncidentService')
    const summary = await _withTimeout(recentSummary({ hours: 4 }), PROBE_TIMEOUT_MS, null)
    if (!summary) return { ok: true, detail: { note: 'no_data' } }
    const ok = (summary.critical || 0) === 0 && (summary.errors || 0) < 5
    return { ok, detail: summary }
  } catch (err) {
    return { ok: false, detail: { error: err.message } }
  }
}

// ─── Top-level rollup ──────────────────────────────────────────────────

async function selfCheck() {
  const started = Date.now()

  const probes = await _withTimeout(
    Promise.all([
      _probeDb().then(r => ['db', r]),
      _probeRedis().then(r => ['redis', r]),
      _probeNeo4j().then(r => ['neo4j', r]),
      _probeClaudeEnergy().then(r => ['claude_energy', r]),
      _probeCert().then(r => ['cert', r]),
      _probeHeartbeat().then(r => ['heartbeat', r]),
      _probeFactory().then(r => ['factory', r]),
      _probeIncidents().then(r => ['recent_incidents', r]),
    ]),
    OVERALL_DEADLINE_MS,
    null,
  )

  if (!probes) {
    return {
      status: 'critical',
      reason: 'self-check overall deadline exceeded',
      checkedAt: new Date().toISOString(),
      durationMs: Date.now() - started,
    }
  }

  const subsystems = {}
  for (const [name, result] of probes) subsystems[name] = result

  // Severity rollup. "critical" if core path is down (DB or Claude energy),
  // "degraded" if any probe failed, "healthy" if everything green.
  const core = ['db', 'claude_energy']
  const coreBroken = core.some(k => subsystems[k] && !subsystems[k].ok)
  const anyBroken = Object.values(subsystems).some(r => !r.ok)

  const status = coreBroken ? 'critical' : (anyBroken ? 'degraded' : 'healthy')

  return {
    status,
    checkedAt: new Date().toISOString(),
    durationMs: Date.now() - started,
    subsystems,
    // Hints for the OS — one-line actionable summary so it doesn't have
    // to reason about every subsystem when it just wants the bottom line.
    summary: _summarize(subsystems, status),
  }
}

function _summarize(s, status) {
  if (status === 'healthy') return 'All systems nominal.'
  const broken = Object.entries(s)
    .filter(([, r]) => !r.ok)
    .map(([name, r]) => `${name}: ${r.detail?.error || JSON.stringify(r.detail).slice(0, 120)}`)
  return broken.join(' | ')
}

module.exports = { selfCheck }
