'use strict'

/**
 * Smoke listener — proves the registry pipeline end-to-end.
 * TEMP (Apr 23 2026 22:33 AEST): relevanceFilter flipped to true + handle logs each fire.
 * Revert to `() => false` + empty handle once Tate has seen the logs.
 */

const logger = require('../../config/logger')

let _fireCount = 0

module.exports = {
  name: 'smoke',
  model: 'haiku-4-5',
  subscribesTo: ['text_delta'],
  relevanceFilter: () => true,
  handle: async (event) => {
    _fireCount++
    logger.info(`[smoke-listener] fired #${_fireCount}`, {
      type: event.type,
      ws_seq: event.ws_seq,
      text_len: event && event.text ? event.text.length : 0,
    })
  },
  ownsWriteSurface: [],
}
