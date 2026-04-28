'use strict'

/**
 * emailArrival listener
 *
 * Fires when a new row is inserted into email_events.
 * Wakes the OS session to run inbox triage on the new email.
 *
 * Does NOT cancel the existing email-triage cron - listener and cron
 * run side-by-side. Cron is decommissioned in a later wave.
 *
 * Wakes the OS via HTTP POST - never imports the session service directly.
 */

const logger = require('../../config/logger')
const axios = require('axios')

const PORT = process.env.PORT || 3001

async function _wakeOsSession(message, eventId) {
  try {
    await axios.post(`http://localhost:${PORT}/api/os-session/message`, { message }, {
      timeout: 5000,
    })
  } catch (err) {
    logger.warn('emailArrival: wake POST failed', {
      error: err.message,
      eventId,
    })
  }
}

module.exports = {
  name: 'emailArrival',
  subscribesTo: ['db:event'],

  relevanceFilter: (event) => {
    const d = event && event.data
    if (!d || d.type !== 'db:event') return false
    if (d.table !== 'email_events') return false
    if (d.action !== 'INSERT') return false
    if (!d.row) return false
    return true
  },

  handle: async (event, ctx) => {
    const row = event.data.row
    const message = (
      `New email event id=${row.id} arrived (kind=${row.kind || 'unknown'}). ` +
      `Run email triage on the inbox: archive junk, draft replies for client emails ` +
      `(do NOT send - per CLAUDE.md zero unilateral client contact), ` +
      `update status_board for any new threads. ` +
      `Source: emailArrival listener (sourceEventId=${ctx.sourceEventId}).`
    )
    logger.info('emailArrival: handle invoked', { eventId: row.id })
    await _wakeOsSession(message, row.id)
  },

  ownsWriteSurface: ['os-session-message'],
}
