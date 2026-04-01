const db = require('../../config/db')

async function appendLog(sessionId, chunk) {
  await db`INSERT INTO cc_session_logs (session_id, chunk) VALUES (${sessionId}, ${chunk})`
}

async function updateSessionStatus(sessionId, status, extra = {}) {
  const updates = { status, ...extra }
  if (status === 'complete' || status === 'error') {
    updates.completed_at = new Date()
  }
  await db`
    UPDATE cc_sessions
    SET status = ${updates.status},
        completed_at = ${updates.completed_at || null},
        error_message = ${updates.error_message || null},
        cc_session_id = ${updates.cc_session_id || null},
        cc_cost_usd = ${updates.cc_cost_usd || null}
    WHERE id = ${sessionId}
  `
}

module.exports = { appendLog, updateSessionStatus }
