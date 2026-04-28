'use strict'

/**
 * factorySessionComplete listener
 *
 * Fires when a cc_sessions row transitions to status='complete' or
 * status='rejected' AND pipeline_stage is in the meaningful-review allowlist.
 * Wakes the OS session via HTTP POST so it can review and approve/reject.
 *
 * Stage allowlist: only 'awaiting_review' and 'complete' pipeline stages
 * trigger a wake. Post-approval intermediate stages (executing, testing,
 * deploying) are ignored to prevent replay storms on every pipeline transition.
 *
 * Dedupe: same sessionId is suppressed for 60s after the first wake to
 * prevent multiple rapid-fire wakes for the same session.
 *
 * Wakes the OS via HTTP POST to /api/os-session/message.
 * Never imports the session service directly - the registry rejects such modules.
 */

const logger = require('../../config/logger')
const axios = require('axios')

const PORT = process.env.PORT || 3001

// Only wake on these pipeline stages - ignore post-approval pipeline transitions
const ALLOWED_STAGES = new Set(['awaiting_review', 'complete'])

// In-memory dedupe: suppress repeated wakes for the same session within 60s.
// LRU-evict oldest entry when the map exceeds 200 entries to prevent unbounded growth.
const DEDUPE_TTL_MS = 60 * 1000
const DEDUPE_MAX_SIZE = 200
const _recentFires = new Map() // sessionId -> lastFiredAt (ms timestamp)

function _shouldFire(sessionId) {
  const last = _recentFires.get(sessionId)
  const now = Date.now()
  if (last !== undefined && (now - last) < DEDUPE_TTL_MS) return false
  // Evict oldest entry if at capacity (Map preserves insertion order - first key = oldest)
  if (_recentFires.size >= DEDUPE_MAX_SIZE) {
    _recentFires.delete(_recentFires.keys().next().value)
  }
  _recentFires.set(sessionId, now)
  return true
}

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

    // Only complete/rejected status transitions
    if (status !== 'complete' && status !== 'rejected') return false

    // Failure events belong to ccSessionsFailure
    if (stage === 'failed' || stage === 'error') return false

    // Only wake on meaningful pipeline stages - block post-approval churn
    if (!ALLOWED_STAGES.has(stage)) return false

    // Dedupe: suppress duplicate wakes for the same session within 60s
    if (!_shouldFire(d.row.id)) return false

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
