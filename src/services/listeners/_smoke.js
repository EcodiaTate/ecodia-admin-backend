'use strict'

/**
 * Smoke listener — proves the registry pipeline end-to-end.
 * relevanceFilter always returns false so handle() is never invoked in production.
 */

module.exports = {
  name: 'smoke',
  model: 'haiku-4-5',
  subscribesTo: ['text_delta'],
  relevanceFilter: () => false,
  handle: async () => {},
  ownsWriteSurface: [],
}
