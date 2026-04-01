require('../config/env')
const cron = require('node-cron')
const logger = require('../config/logger')
const linkedinService = require('../services/linkedinService')
const { createNotification } = require('../db/queries/transactions')

logger.info('LinkedIn worker started')

// Check DMs twice daily (9am and 3pm AEST)
cron.schedule('0 9,15 * * *', async () => {
  try {
    await linkedinService.checkDMs()
  } catch (e) {
    // CAPTCHA or challenge detection — suspend worker
    if (e.message?.includes('CAPTCHA') || e.message?.includes('challenge')) {
      linkedinService.suspendWorker(e.message)
      await createNotification({
        type: 'linkedin',
        message: `LinkedIn worker suspended: ${e.message}. Resume via dashboard after manual fix.`,
        link: '/linkedin',
        metadata: { error: e.message, worker: 'linkedinWorker' },
      }).catch(notifErr => logger.error('Failed to create linkedin notification', { error: notifErr.message }))
      return
    }

    logger.error('LinkedIn worker failed', { error: e.message, stack: e.stack })
    await createNotification({
      type: 'system',
      message: `LinkedIn worker failed: ${e.message}`,
      link: '/linkedin',
      metadata: { error: e.message, worker: 'linkedinWorker' },
    }).catch(notifErr => logger.error('Failed to create linkedin notification', { error: notifErr.message }))
  }
})
