'use strict'

/**
 * ccSessionsFailure listener
 *
 * Fires when a cc_sessions row enters an error or failed state:
 *   - status='error'
 *   - pipeline_stage='failed'
 *   - pipeline_stage='error'
 *
 * Exclusion: does NOT fire when status='complete' (those transitions belong
 * to factorySessionComplete, even if pipeline_stage is also set to something).
 *
 * Wakes the OS session via HTTP POST so it can investigate and decide
 * whether to reject or re-dispatch.
 *
 * Wakes the OS via HTTP POST - never imports the session service directly.
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
    logger.warn('ccSessionsFailure: wake POST failed', {
      error: err.message,
      sessionId,
    })
  }
}

module.exports = {
  name: 'ccSessionsFailure',
  subscribesTo: ['db:event'],

  relevanceFilter: (event) => {
    const d = event && event.data
    if (!d || d.type !== 'db:event') return false
    if (d.table !== 'cc_sessions') return false
    if (d.action !== 'UPDATE') return false
    if (!d.row) return false

    const status = d.row.status
    const stage = d.row.pipeline_stage

    // Exclude clean completions - those go to factorySessionComplete
    if (status === 'complete') return false

    // Match failure conditions
    const isError = status === 'error'
    const isFailedStage = stage === 'failed' || stage === 'error'

    return isError || isFailedStage
  },

  handle: async (event, ctx) => {
    const row = event.data.row
    const message = (
      `Factory session ${row.id} failed: status=${row.status}, ` +
      `pipeline_stage=${row.pipeline_stage}. ` +
      `Investigate the failure reason and decide reject/redispatch. ` +
      `Source: ccSessionsFailure listener (sourceEventId=${ctx.sourceEventId}).`
    )
    logger.info('ccSessionsFailure: handle invoked', { sessionId: row.id, status: row.status, stage: row.pipeline_stage })
    await _wakeOsSession(message, row.id)
  },

  ownsWriteSurface: ['os-session-message'],
}
