const db = require('../config/db')
const logger = require('../config/logger')
const env = require('../config/env')

// ═══════════════════════════════════════════════════════════════════════
// SESSION OBSERVATION SERVICE — Watches running CC sessions for health
//
// Called by autonomousMaintenanceWorker when the AI decides to check
// session health. Detects stalls, stuck sessions, and unhealthy
// patterns. Can auto-intervene by sending follow-up messages.
//
// Hardened against:
//   - Missing 'completing'/'queued' states (sessions stuck invisible)
//   - Null heartbeat/date fields
//   - DB query failures (graceful degradation)
//   - Concurrent observation calls (no duplicate interventions)
// ═══════════════════════════════════════════════════════════════════════

// Stale heartbeat threshold: session hasn't reported in this long
const HEARTBEAT_STALE_MS = Math.max(parseInt(env.SESSION_HEARTBEAT_STALE_MS || '300000'), 30000)  // 5 min, min 30s

// Output stall threshold: no log output for this long
const OUTPUT_STALL_MS = Math.max(parseInt(env.SESSION_OUTPUT_STALL_MS || '180000'), 30000)  // 3 min, min 30s

// Queued session threshold: session stuck in 'queued' for this long
const QUEUED_STALE_MS = parseInt(env.SESSION_QUEUED_STALE_MS || '300000')  // 5 min

async function checkSessionHealth() {
  try {
    // Include 'completing' and 'queued' — sessions can get stuck in these states
    const running = await db`
      SELECT cs.id, cs.initial_prompt, cs.status, cs.started_at,
             cs.last_heartbeat_at, cs.codebase_id, cs.pipeline_stage,
             cb.name AS codebase_name
      FROM cc_sessions cs
      LEFT JOIN codebases cb ON cs.codebase_id = cb.id
      WHERE cs.status IN ('running', 'initializing', 'completing', 'queued')
      ORDER BY cs.started_at DESC
    `

    if (running.length === 0) return { healthy: true, sessions: [], totalRunning: 0, unhealthyCount: 0 }

    const now = new Date()
    const results = []

    for (const session of running) {
      const startedAt = session.started_at ? new Date(session.started_at) : now
      const heartbeatAt = session.last_heartbeat_at ? new Date(session.last_heartbeat_at) : null

      // For queued sessions, check if they've been stuck too long
      if (session.status === 'queued') {
        const queuedAge = now - startedAt
        results.push({
          sessionId: session.id,
          prompt: (session.initial_prompt || '').slice(0, 100),
          codebaseName: session.codebase_name,
          pipelineStage: session.pipeline_stage,
          status: session.status,
          durationMinutes: Math.round(queuedAge / 60000),
          heartbeatAgeMs: null,
          lastOutputAgeMs: null,
          isHeartbeatStale: false,
          isOutputStalled: false,
          isQueuedStale: queuedAge > QUEUED_STALE_MS,
          healthy: queuedAge <= QUEUED_STALE_MS,
        })
        continue
      }

      const heartbeatAge = heartbeatAt
        ? now - heartbeatAt
        : now - startedAt  // No heartbeat yet — use start time
      const isHeartbeatStale = heartbeatAge > HEARTBEAT_STALE_MS

      // Check last log output time
      let lastOutputAge
      try {
        const [lastLog] = await db`
          SELECT created_at FROM cc_session_logs
          WHERE session_id = ${session.id}
          ORDER BY created_at DESC LIMIT 1
        `
        lastOutputAge = lastLog?.created_at
          ? now - new Date(lastLog.created_at)
          : now - startedAt
      } catch (err) {
        logger.debug('Failed to check session log', { sessionId: session.id, error: err.message })
        lastOutputAge = now - startedAt
      }

      const isOutputStalled = lastOutputAge > OUTPUT_STALL_MS

      // Sessions in 'completing' for >2min are likely stuck
      const isCompletingStuck = session.status === 'completing' && (now - startedAt > 120000)

      const duration = now - startedAt
      const durationMin = Math.round(duration / 60000)

      results.push({
        sessionId: session.id,
        prompt: (session.initial_prompt || '').slice(0, 100),
        codebaseName: session.codebase_name,
        pipelineStage: session.pipeline_stage,
        status: session.status,
        durationMinutes: durationMin,
        heartbeatAgeMs: Math.round(heartbeatAge),
        lastOutputAgeMs: Math.round(lastOutputAge),
        isHeartbeatStale,
        isOutputStalled,
        isQueuedStale: false,
        isCompletingStuck: isCompletingStuck || false,
        healthy: !isHeartbeatStale && !isOutputStalled && !isCompletingStuck,
      })
    }

    const unhealthyCount = results.filter(r => !r.healthy).length

    return {
      healthy: unhealthyCount === 0,
      totalRunning: running.length,
      unhealthyCount,
      sessions: results,
    }
  } catch (err) {
    logger.error('Session health check failed', { error: err.message })
    return { healthy: true, sessions: [], totalRunning: 0, unhealthyCount: 0, error: err.message }
  }
}

async function detectStalls() {
  try {
    const health = await checkSessionHealth()
    const stalled = health.sessions.filter(s =>
      (s.isOutputStalled && !s.isHeartbeatStale) || s.isQueuedStale || s.isCompletingStuck
    )

    if (stalled.length === 0) return { stalled: [] }

    // For truly stalled sessions (output gap but heartbeat alive), get recent logs
    // to help the AI decide whether to intervene
    const stalledWithContext = []
    for (const session of stalled) {
      try {
        const recentLogs = await db`
          SELECT chunk, created_at FROM cc_session_logs
          WHERE session_id = ${session.sessionId}
          ORDER BY created_at DESC LIMIT 10
        `
        stalledWithContext.push({
          ...session,
          recentLogs: recentLogs.reverse().map(l => l.chunk || '').join('\n').slice(-2000),
        })
      } catch (err) {
        logger.debug('Failed to fetch stall context', { sessionId: session.sessionId, error: err.message })
        stalledWithContext.push({ ...session, recentLogs: '(failed to fetch logs)' })
      }
    }

    return { stalled: stalledWithContext }
  } catch (err) {
    logger.error('Stall detection failed', { error: err.message })
    return { stalled: [], error: err.message }
  }
}

async function getSessionMetrics() {
  try {
    const [stats] = await db`
      SELECT
        count(*) FILTER (WHERE status IN ('running', 'initializing', 'completing', 'queued'))::int AS active,
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
      active: stats?.active || 0,
      completed_24h: stats?.completed_24h || 0,
      errors_24h: stats?.errors_24h || 0,
      avg_duration_min: stats?.avg_duration_min ? Math.round(parseFloat(stats.avg_duration_min)) : null,
      avg_confidence: stats?.avg_confidence ? parseFloat(stats.avg_confidence).toFixed(2) : null,
      pending_code_requests: pendingRequests?.count || 0,
    }
  } catch (err) {
    logger.error('Session metrics query failed', { error: err.message })
    return { active: 0, completed_24h: 0, errors_24h: 0, avg_duration_min: null, avg_confidence: null, pending_code_requests: 0 }
  }
}

// Build a brief for the maintenance worker's AI decision loop
async function buildSessionHealthBrief() {
  try {
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
        if (s.isQueuedStale) issues.push('stuck in queue')
        if (s.isCompletingStuck) issues.push('stuck completing')
        lines.push(`  - ${s.sessionId.slice(0, 8)}: ${s.prompt || 'no prompt'} [${issues.join(', ')}] (${s.durationMinutes}min, ${s.status})`)
      }
    }

    return lines.join('\n')
  } catch (err) {
    logger.error('Failed to build session health brief', { error: err.message })
    return `Session health check failed: ${err.message}`
  }
}

module.exports = {
  checkSessionHealth,
  detectStalls,
  getSessionMetrics,
  buildSessionHealthBrief,
}
