'use strict'

/**
 * factorySessionComplete listener
 *
 * Fires when a cc_sessions row transitions to status='complete' or
 * status='rejected'. Wakes the OS session via HTTP POST so it can review
 * and approve/reject the Factory output.
 *
 * Exclusion: if pipeline_stage is 'failed' or 'error' on the same row,
 * this is a failure event - defer to ccSessionsFailure to avoid a double wake.
 *
 * Wakes the OS via HTTP POST to /api/os-session/message.
 * Never imports the session service directly - the registry rejects such modules.
 */

const logger = require('../../config/logger')
const axios = require('axios')

const PORT = process.env.PORT || 3001

async function _wakeOsSession(message, sessionId) {
  try {
    await axios.post(`http://localhost:${PORT}/api/os-session/message`, { message }, {
      timeout: 5000,
    })
  } catch (err) {
    logger.warn('factorySessionComplete: wake POST failed', {
      error: err.message,
      sessionId,
    })
  }
}

module.exports = {
  name: 'factorySessionComplete',
  subscribesTo: ['db:event'],

  relevanceFilter: (event) => {
    const d = event && event.data
    if (!d || d.type !== 'db:event') return false
    if (d.table !== 'cc_sessions') return false
    if (d.action !== 'UPDATE') return false
    if (!d.row) return false

    const status = d.row.status
    const stage = d.row.pipeline_stage

    // Only complete/rejected transitions
    if (status !== 'complete' && status !== 'rejected') return false

    // Failure events belong to ccSessionsFailure
    if (stage === 'failed' || stage === 'error') return false

    return true
  },

  handle: async (event, ctx) => {
    const row = event.data.row
    const message = (
      `Factory session ${row.id} transitioned to status=${row.status}, ` +
      `pipeline_stage=${row.pipeline_stage}. ` +
      `Review and decide approve/reject. ` +
      `Source: factorySessionComplete listener (sourceEventId=${ctx.sourceEventId}).`
    )
    logger.info('factorySessionComplete: handle invoked', { sessionId: row.id, status: row.status })
    await _wakeOsSession(message, row.id)
  },

  ownsWriteSurface: ['os-session-message'],
}
