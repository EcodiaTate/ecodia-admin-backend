const db = require('../config/db')
const { broadcast } = require('../websocket/wsManager')
const logger = require('../config/logger')

/**
 * Record a worker heartbeat — upserts into worker_heartbeats table
 * and broadcasts via WebSocket so the frontend updates immediately.
 */
async function recordHeartbeat(workerName, status = 'active', errorMsg = null) {
  const now = new Date().toISOString()

  try {
    await db`
      INSERT INTO worker_heartbeats (worker_name, last_run_at, status, error_msg)
      VALUES (${workerName}, ${now}, ${status}, ${errorMsg})
      ON CONFLICT (worker_name)
      DO UPDATE SET last_run_at = ${now}, status = ${status}, error_msg = ${errorMsg}
    `
  } catch (err) {
    logger.error('Failed to record worker heartbeat', { worker: workerName, error: err.message })
  }

  try {
    broadcast('worker_heartbeat', {
      payload: { worker: workerName, lastSync: now, status, error: errorMsg },
    })
  } catch {
    // WebSocket may not be ready during startup — safe to ignore
  }
}

module.exports = { recordHeartbeat }
