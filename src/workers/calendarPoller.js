const logger = require('../config/logger')
const env = require('../config/env')

if (!env.GOOGLE_SERVICE_ACCOUNT_JSON || env.GOOGLE_SERVICE_ACCOUNT_JSON === '{}') {
  logger.info('Calendar poller skipped — GOOGLE_SERVICE_ACCOUNT_JSON not set')
  module.exports = {}
} else {

// ═══════════════════════════════════════════════════════════════════════
// CALENDAR POLLER — Adaptive loop
//
// Poll frequency adapts to how busy the calendar is:
//   - Events upcoming in <2 hours → poll every 2 min
//   - Events today → poll every 5 min
//   - Nothing imminent → poll every 15 min
// Meeting prep surfaces whenever the loop finds something upcoming.
// ═══════════════════════════════════════════════════════════════════════

const calendarService = require('../services/calendarService')
const { createNotification } = require('../db/queries/transactions')
const { recordHeartbeat } = require('./heartbeat')

logger.info('Calendar poller started — adaptive loop')

let running = true
let pollTimer = null

async function poll() {
  let nextDelayMs = 5 * 60_000  // default 5 min

  try {
    const result = await calendarService.pollCalendars()
    await recordHeartbeat('calendar', 'active')

    // Adapt interval based on how soon the next event is
    const nextEventMs = result?.nextEventMs ?? result?.msUntilNext ?? null
    if (nextEventMs !== null) {
      if (nextEventMs < 2 * 60 * 60 * 1000) nextDelayMs = 2 * 60_000        // <2h → 2 min
      else if (nextEventMs < 8 * 60 * 60 * 1000) nextDelayMs = 5 * 60_000   // <8h → 5 min
      else nextDelayMs = 15 * 60_000                                          // far → 15 min
    }
  } catch (err) {
    logger.error('Calendar poll failed', { error: err.message, stack: err.stack })
    await recordHeartbeat('calendar', 'error', err.message)
    await createNotification({
      type: 'system',
      message: `Calendar poller failed: ${err.message}`,
      link: '/calendar',
      metadata: { error: err.message, worker: 'calendarPoller' },
    }).catch(notifErr => logger.error('Failed to create calendar poller notification', { error: notifErr.message }))
    nextDelayMs = 5 * 60_000  // retry in 5 min on error
  }

  // Meeting prep runs every cycle — calendarService decides if there's anything to surface
  try {
    await calendarService.surfaceUpcomingMeetingPrep()
  } catch (err) {
    logger.debug('Calendar meeting prep surfacing failed', { error: err.message })
  }

  scheduleNext(nextDelayMs)
}

function scheduleNext(delayMs) {
  if (!running) return
  if (pollTimer) clearTimeout(pollTimer)
  pollTimer = setTimeout(poll, delayMs)
}

// Start first poll after 10s boot delay
pollTimer = setTimeout(poll, 10_000)

module.exports = {
  stop() { running = false; if (pollTimer) clearTimeout(pollTimer) },
}
}
