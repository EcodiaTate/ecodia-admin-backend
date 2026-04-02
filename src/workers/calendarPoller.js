require('../config/env')
const cron = require('node-cron')
const logger = require('../config/logger')
const env = require('../config/env')

if (!env.GOOGLE_SERVICE_ACCOUNT_JSON || env.GOOGLE_SERVICE_ACCOUNT_JSON === '{}') {
  logger.info('Calendar poller skipped — GOOGLE_SERVICE_ACCOUNT_JSON not set')
  return
}

const calendarService = require('../services/calendarService')
const { createNotification } = require('../db/queries/transactions')
const { recordHeartbeat } = require('./heartbeat')

logger.info('Calendar poller started')

// Poll every 5 minutes — calendar changes are less frequent than email
cron.schedule('*/5 * * * *', async () => {
  try {
    await calendarService.pollCalendars()
    await recordHeartbeat('calendar', 'active')
  } catch (err) {
    logger.error('Calendar poll failed', { error: err.message, stack: err.stack })
    await recordHeartbeat('calendar', 'error', err.message)
    await createNotification({
      type: 'system',
      message: `Calendar poller failed: ${err.message}`,
      link: '/calendar',
      metadata: { error: err.message, worker: 'calendarPoller' },
    }).catch(notifErr => logger.error('Failed to create calendar poller notification', { error: notifErr.message }))
  }
})

// Proactive meeting prep — check every 30 minutes for upcoming meetings needing prep
cron.schedule('*/30 * * * *', async () => {
  try {
    await calendarService.surfaceUpcomingMeetingPrep()
  } catch (err) {
    logger.debug('Calendar meeting prep surfacing failed', { error: err.message })
  }
})
