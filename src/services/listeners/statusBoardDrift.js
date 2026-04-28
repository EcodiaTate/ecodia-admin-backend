'use strict'

/**
 * statusBoardDrift listener - HYBRID: event-driven + timer-driven.
 *
 * Event side (subscribesTo: ['db:event']):
 *   On status_board INSERT/UPDATE, records the row's last_touched timestamp
 *   in an in-memory Map. No OS wake on the event side.
 *
 * Timer side (setInterval, 30 minutes):
 *   Queries the DB for status_board rows where:
 *     - archived_at IS NULL
 *     - next_action_by = 'ecodiaos'
 *     - priority <= 2
 *     - last_touched < NOW() - INTERVAL '24 hours'
 *   For each drifted row not yet alerted, wakes the OS via HTTP POST.
 *   Re-alerts are suppressed per row until last_touched advances past threshold.
 *
 * Exports start() and stop() in addition to the standard listener shape.
 * Wakes the OS via HTTP POST - never imports the session service directly.
 */

const logger = require('../../config/logger')
const axios = require('axios')
const db = require('../../config/db')

const PORT = process.env.PORT || 3001
const DRIFT_INTERVAL_MS = 30 * 60 * 1000   // 30 minutes
const DRIFT_THRESHOLD_HOURS = 24

// In-memory map: row id -> last_touched value seen from events (string)
const _lastTouched = new Map()
// In-memory set: row ids for which a drift alert has been sent
// Reset when last_touched advances past the threshold
const _alertedIds = new Set()

let _timer = null

async function _wakeOsSession(message, rowId) {
  try {
    await axios.post(`http://localhost:${PORT}/api/os-session/message`, { message }, {
      timeout: 5000,
    })
  } catch (err) {
    logger.warn('statusBoardDrift: wake POST failed', {
      error: err.message,
      rowId,
    })
  }
}

async function _checkDrift() {
  try {
    const rows = await db`
      SELECT id, name, last_touched, priority, next_action
      FROM status_board
      WHERE archived_at IS NULL
        AND next_action_by = 'ecodiaos'
        AND priority <= 2
        AND last_touched < NOW() - INTERVAL '24 hours'
    `

    for (const row of rows) {
      const rowId = row.id

      if (_alertedIds.has(rowId)) {
        // Check if last_touched has advanced since we last alerted
        const storedTs = _lastTouched.get(rowId)
        const currentTs = String(row.last_touched)
        if (!storedTs || storedTs === currentTs) {
          // Still the same old value - do not re-alert
          continue
        }
        // last_touched changed - clear the alert so it can re-trigger if it drifts again
        _alertedIds.delete(rowId)
      }

      _alertedIds.add(rowId)
      _lastTouched.set(rowId, String(row.last_touched))

      logger.info('statusBoardDrift: drifted row detected', {
        rowId,
        name: row.name,
        lastTouched: row.last_touched,
        priority: row.priority,
      })

      const message = (
        `Status_board row drifted: id=${rowId}, name=${row.name}, ` +
        `last_touched=${row.last_touched} (over ${DRIFT_THRESHOLD_HOURS}h ago), ` +
        `priority=${row.priority}, next_action="${row.next_action}". ` +
        `Action this or update next_action_by/priority. ` +
        `Source: statusBoardDrift listener.`
      )
      await _wakeOsSession(message, rowId)
    }
  } catch (err) {
    logger.warn('statusBoardDrift: drift check failed', { error: err.message })
  }
}

module.exports = {
  name: 'statusBoardDrift',
  subscribesTo: ['db:event'],

  relevanceFilter: (event) => {
    const d = event && event.data
    if (!d || d.type !== 'db:event') return false
    if (d.table !== 'status_board') return false
    if (d.action !== 'INSERT' && d.action !== 'UPDATE') return false
    if (!d.row) return false
    return true
  },

  handle: async (event, _ctx) => {
    const row = event.data.row
    if (row && row.id) {
      const currentTs = String(row.last_touched || '')
      _lastTouched.set(row.id, currentTs)

      // If this row was previously alerted and is now being touched again,
      // check if last_touched advanced past the drift threshold.
      if (_alertedIds.has(row.id) && row.last_touched) {
        const lastTouched = new Date(row.last_touched)
        const thresholdAgo = new Date(Date.now() - DRIFT_THRESHOLD_HOURS * 60 * 60 * 1000)
        if (!isNaN(lastTouched.getTime()) && lastTouched > thresholdAgo) {
          _alertedIds.delete(row.id)
        }
      }
    }
    // Event side: record only, no OS wake.
  },

  ownsWriteSurface: ['os-session-message'],

  start: async () => {
    if (_timer) return
    _timer = setInterval(_checkDrift, DRIFT_INTERVAL_MS)
    logger.info('statusBoardDrift: drift check timer started (interval: 30m)')
  },

  stop: async () => {
    if (_timer) {
      clearInterval(_timer)
      _timer = null
      logger.info('statusBoardDrift: drift check timer stopped')
    }
  },
}
