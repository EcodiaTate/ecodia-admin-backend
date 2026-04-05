const db = require('../config/db')
const logger = require('../config/logger')
const env = require('../config/env')

// ═══════════════════════════════════════════════════════════════════════
// SESSION OBSERVATION SERVICE — Watches running CC sessions for health
//
// Called by autonomousMaintenanceWorker when the AI decides to check
// session health. Detects stalls, stuck sessions, and unhealthy
// patterns. Can auto-intervene by sending follow-up messages.
// ═══════════════════════════════════════════════════════════════════════

// Stale heartbeat threshold: session hasn't reported in this long
const HEARTBEAT_STALE_MS = parseInt(env.SESSION_HEARTBEAT_STALE_MS || '300000')  // 5 min

// Output stall threshold: no log output for this long
const OUTPUT_STALL_MS = parseInt(env.SESSION_OUTPUT_STALL_MS || '180000')  // 3 min

async function checkSessionHealth() {
  const running = await db`
    SELECT cs.id, cs.initial_prompt, cs.status, cs.started_at,
           cs.last_heartbeat_at, cs.codebase_id, cs.pipeline_stage,
           cb.name AS codebase_name
    FROM cc_sessions cs
    LEFT JOIN codebases cb ON cs.codebase_id = cb.id
    WHERE cs.status IN ('running', 'initializing')
    ORDER BY cs.started_at DESC
  `

  if (running.length === 0) return { healthy: true, sessions: [] }

  const now = new Date()
  const results = []

  for (const session of running) {
    const heartbeatAge = session.last_heartbeat_at
      ? now - new Date(session.last_heartbeat_at)
      : now - new Date(session.started_at)

    const isHeartbeatStale = heartbeatAge > HEARTBEAT_STALE_MS

    // Check last log output time
    const [lastLog] = await db`
      SELECT created_at FROM cc_session_logs
      WHERE session_id = ${session.id}
      ORDER BY created_at DESC LIMIT 1
    `
    const lastOutputAge = lastLog
      ? now - new Date(lastLog.created_at)
      : now - new Date(session.started_at)

    const isOutputStalled = lastOutputAge > OUTPUT_STALL_MS

    const duration = now - new Date(session.started_at)
    const durationMin = Math.round(duration / 60000)

    results.push({
      sessionId: session.id,
      prompt: session.initial_prompt?.slice(0, 100),
      codebaseName: session.codebase_name,
      pipelineStage: session.pipeline_stage,
      durationMinutes: durationMin,
      heartbeatAgeMs: heartbeatAge,
      lastOutputAgeMs: lastOutputAge,
      isHeartbeatStale,
      isOutputStalled,
      healthy: !isHeartbeatStale && !isOutputStalled,
    })
  }

  const unhealthyCount = results.filter(r => !r.healthy).length

  return {
    healthy: unhealthyCount === 0,
    totalRunning: running.length,
    unhealthyCount,
    sessions: results,
  }
}

async function detectStalls() {
  const health = await checkSessionHealth()
  const stalled = health.sessions.filter(s => s.isOutputStalled && !s.isHeartbeatStale)

  if (stalled.length === 0) return { stalled: [] }

  // For truly stalled sessions (output gap but heartbeat alive), get recent logs
  // to help the AI decide whether to intervene
  const stalledWithContext = []
  for (const session of stalled) {
    const recentLogs = await db`
      SELECT chunk, created_at FROM cc_session_logs
      WHERE session_id = ${session.sessionId}
      ORDER BY created_at DESC LIMIT 10
    `
    stalledWithContext.push({
      ...session,
      recentLogs: recentLogs.reverse().map(l => l.chunk).join('\n').slice(-2000),
    })
  }

  return { stalled: stalledWithContext }
}

async function getSessionMetrics() {
  const [stats] = await db`
    SELECT
      count(*) FILTER (WHERE status IN ('running', 'initializing'))::int AS active,
      count(*) FILTER (WHERE status = 'complete' AND completed_at > now() - interval '24 hours')::int AS completed_24h,
      count(*) FILTER (WHERE status = 'error' AND started_at > now() - interval '24 hours')::int AS errors_24h,
      avg(EXTRACT(EPOCH FROM (completed_at - started_at)) / 60)
        FILTER (WHERE status = 'complete' AND completed_at > now() - interval '7 days') AS avg_duration_min,
      avg(confidence_score) FILTER (WHERE confidence_score IS NOT NULL AND started_at > now() - interval '7 days') AS avg_confidence
    FROM cc_sessions
  `

  const [pendingRequests] = await db`
    SELECT count(*)::int AS count FROM code_requests WHERE status = 'pending'
  `

  return {
    ...stats,
    avg_duration_min: stats.avg_duration_min ? Math.round(stats.avg_duration_min) : null,
    avg_confidence: stats.avg_confidence ? parseFloat(stats.avg_confidence).toFixed(2) : null,
    pending_code_requests: pendingRequests.count,
  }
}

// Build a brief for the maintenance worker's AI decision loop
async function buildSessionHealthBrief() {
  const health = await checkSessionHealth()
  const metrics = await getSessionMetrics()

  const lines = []
  lines.push(`Sessions: ${metrics.active} active, ${metrics.completed_24h} completed (24h), ${metrics.errors_24h} errors (24h)`)
  if (metrics.avg_duration_min) lines.push(`Avg duration: ${metrics.avg_duration_min}min, avg confidence: ${metrics.avg_confidence}`)
  if (metrics.pending_code_requests > 0) lines.push(`Pending code requests: ${metrics.pending_code_requests}`)

  if (!health.healthy) {
    lines.push(`UNHEALTHY: ${health.unhealthyCount}/${health.totalRunning} sessions`)
    for (const s of health.sessions.filter(s => !s.healthy)) {
      const issues = []
      if (s.isHeartbeatStale) issues.push('heartbeat stale')
      if (s.isOutputStalled) issues.push('output stalled')
      lines.push(`  - ${s.sessionId.slice(0, 8)}: ${s.prompt} [${issues.join(', ')}] (${s.durationMinutes}min)`)
    }
  }

  return lines.join('\n')
}

module.exports = {
  checkSessionHealth,
  detectStalls,
  getSessionMetrics,
  buildSessionHealthBrief,
}
