const db = require('../../config/db')

async function appendLog(sessionId, chunk) {
  await db`INSERT INTO cc_session_logs (session_id, chunk) VALUES (${sessionId}, ${chunk})`
}

async function updateSessionStatus(sessionId, status, extra = {}) {
  const isTerminal = status === 'complete' || status === 'error' || status === 'stopped'
  const completedAt = isTerminal ? new Date() : undefined

  // Only update fields that are explicitly provided — never clobber existing values with null.
  // Previous version unconditionally set error_message, cc_session_id, cc_cost_usd to null
  // on every status update, wiping data recorded by earlier pipeline stages.
  if ('error_message' in extra || 'cc_session_id' in extra || 'cc_cost_usd' in extra) {
    await db`
      UPDATE cc_sessions
      SET status = ${status},
          completed_at = COALESCE(${completedAt ?? null}, completed_at),
          error_message = COALESCE(${extra.error_message ?? null}, error_message),
          cc_session_id = COALESCE(${extra.cc_session_id ?? null}, cc_session_id),
          cc_cost_usd = COALESCE(${extra.cc_cost_usd ?? null}, cc_cost_usd)
      WHERE id = ${sessionId}
    `
  } else {
    // Fast path: just status + maybe completed_at
    await db`
      UPDATE cc_sessions
      SET status = ${status},
          completed_at = COALESCE(${completedAt ?? null}, completed_at)
      WHERE id = ${sessionId}
    `
  }
}

module.exports = { appendLog, updateSessionStatus }
