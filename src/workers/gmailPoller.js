require('../config/env')
const logger = require('../config/logger')
const gmailService = require('../services/gmailService')
const { createNotification } = require('../db/queries/transactions')
const { recordHeartbeat } = require('./heartbeat')

// ═══════════════════════════════════════════════════════════════════════
// GMAIL POLLER — On-Demand
//
// No fixed schedule. Called by autonomousMaintenanceWorker when the AI
// decides a poll is warranted — based on system pressure, time since
// last poll, and any pending signals.
//
// Exported as a callable so other workers can trigger it too.
// ═══════════════════════════════════════════════════════════════════════

async function pollOnce() {
  try {
    await gmailService.pollInbox()
    await recordHeartbeat('gmail', 'active')
  } catch (e) {
    logger.error('Gmail poller failed', { error: e.message, stack: e.stack })
    await recordHeartbeat('gmail', 'error', e.message)
    await createNotification({
      type: 'system',
      message: `Gmail poller failed: ${e.message}`,
      link: '/gmail',
      metadata: { error: e.message, worker: 'gmailPoller' },
    }).catch(notifErr => logger.error('Failed to create gmail poller notification', { error: notifErr.message }))
  }
}

logger.info('Gmail poller registered (on-demand, no fixed schedule)')

module.exports = { pollOnce }
