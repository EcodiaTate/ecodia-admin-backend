require('../config/env')
const logger = require('../config/logger')
const xeroService = require('../services/xeroService')
const { createNotification } = require('../db/queries/transactions')
const { recordHeartbeat } = require('./heartbeat')

// ═══════════════════════════════════════════════════════════════════════
// FINANCE POLLER — Adaptive loop
//
// Transaction sync adapts to activity:
//   - Active day (new transactions found) → poll every 1 hour
//   - Quiet period → poll every 4 hours
//
// Token heartbeat: every 6 hours (Xero tokens expire after 60 days of
// non-use; 6-hour keep-alive is safe and responsive).
// ═══════════════════════════════════════════════════════════════════════

logger.info('Finance poller worker started — adaptive loop')

let running = true
let pollTimer = null
let heartbeatTimer = null

async function poll() {
  let nextDelayMs = 4 * 60 * 60_000  // default 4 hours

  try {
    const result = await xeroService.pollTransactions()
    logger.info('Finance poll complete')
    await recordHeartbeat('finance', 'active')

    // If new transactions found, check again in 1 hour
    const newTx = result?.newTransactions ?? result?.count ?? 0
    if (newTx > 0) nextDelayMs = 60 * 60_000
  } catch (e) {
    // If Xero isn't connected yet, log quietly — not a system error
    const isNotConnected = e.message?.includes('No Xero tokens') || e.message?.includes('OAuth flow')
    if (isNotConnected) {
      logger.debug('Finance poller skipped — Xero not connected', { error: e.message })
      await recordHeartbeat('finance', 'inactive', e.message)
    } else {
      logger.error('Finance poller failed', { error: e.message, stack: e.stack })
      await recordHeartbeat('finance', 'error', e.message)
      await createNotification({
        type: 'system',
        message: `Finance poller failed: ${e.message}`,
        link: '/finance',
        metadata: { error: e.message, worker: 'financePoller' },
      }).catch(notifErr => logger.error('Failed to create finance poller notification', { error: notifErr.message }))
    }
    nextDelayMs = 2 * 60 * 60_000  // retry in 2h on error
  }

  scheduleNext(nextDelayMs)
}

async function heartbeat() {
  try {
    await xeroService.getValidAccessToken()
    logger.info('Xero token heartbeat OK')
  } catch (e) {
    const isNotConnected = e.message?.includes('No Xero tokens') || e.message?.includes('OAuth flow')
    if (!isNotConnected) {
      logger.error('Xero token heartbeat failed — may need to re-authenticate', { error: e.message })
      await createNotification({
        type: 'system',
        message: 'Xero token heartbeat failed — re-authentication may be required',
        link: '/settings',
        metadata: { error: e.message },
      }).catch(notifErr => logger.error('Failed to create heartbeat notification', { error: notifErr.message }))
    }
  }
  if (running) heartbeatTimer = setTimeout(heartbeat, 6 * 60 * 60_000)
}

function scheduleNext(delayMs) {
  if (!running) return
  if (pollTimer) clearTimeout(pollTimer)
  pollTimer = setTimeout(poll, delayMs)
}

// Start first poll after 30s boot delay, heartbeat after 1 min
pollTimer = setTimeout(poll, 30_000)
heartbeatTimer = setTimeout(heartbeat, 60_000)

module.exports = {
  stop() {
    running = false
    if (pollTimer) clearTimeout(pollTimer)
    if (heartbeatTimer) clearTimeout(heartbeatTimer)
  },
}
