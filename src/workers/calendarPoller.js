require('../config/env')
const cron = require('node-cron')
const logger = require('../config/logger')
const env = require('../config/env')

if (!env.GOOGLE_SERVICE_ACCOUNT_JSON || env.GOOGLE_SERVICE_ACCOUNT_JSON === '{}') {
  logger.info('Calendar poller skipped — GOOGLE_SERVICE_ACCOUNT_JSON not set')
  return
}

const calendarService = require('../services/calendarService')

logger.info('Calendar poller started')

// Poll every 5 minutes — calendar changes are less frequent than email
cron.schedule('*/5 * * * *', async () => {
  try {
    await calendarService.pollCalendars()
  } catch (err) {
    logger.error('Calendar poll failed', { error: err.message })
  }
})
