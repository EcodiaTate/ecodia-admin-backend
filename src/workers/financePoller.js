require('../config/env')
const cron = require('node-cron')
const logger = require('../config/logger')
const xeroService = require('../services/xeroService')
const { createNotification } = require('../db/queries/transactions')
const { recordHeartbeat } = require('./heartbeat')

logger.info('Finance poller worker started')

// Poll transactions every 4 hours
cron.schedule('0 */4 * * *', async () => {
  try {
    await xeroService.pollTransactions()
    logger.info('Finance poll complete')
    await recordHeartbeat('finance', 'active')
  } catch (e) {
    logger.error('Finance poller failed', { error: e.message, stack: e.stack })
    await recordHeartbeat('finance', 'error', e.message)
    await createNotification({
      type: 'system',
      message: `Finance poller failed: ${e.message}`,
      link: '/finance',
      metadata: { error: e.message, worker: 'financePoller' },
    }).catch(notifErr => logger.error('Failed to create finance poller notification', { error: notifErr.message }))
  }
})

// Daily token heartbeat — Xero refresh tokens expire if unused for 60 days
cron.schedule('0 9 * * *', async () => {
  try {
    await xeroService.getValidAccessToken()
    logger.info('Xero token heartbeat OK')
  } catch (e) {
    logger.error('Xero token heartbeat failed — may need to re-authenticate', { error: e.message })
    await createNotification({
      type: 'system',
      message: 'Xero token heartbeat failed — re-authentication may be required',
      link: '/settings',
      metadata: { error: e.message },
    }).catch(notifErr => logger.error('Failed to create heartbeat notification', { error: notifErr.message }))
  }
})

module.exports = {}
