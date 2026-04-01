require('../config/env')
const cron = require('node-cron')
const logger = require('../config/logger')
const gmailService = require('../services/gmailService')
const { createNotification } = require('../db/queries/transactions')
const { recordHeartbeat } = require('./heartbeat')

logger.info('Gmail poller worker started')

// Poll inbox every 3 minutes
cron.schedule('*/3 * * * *', async () => {
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
})
