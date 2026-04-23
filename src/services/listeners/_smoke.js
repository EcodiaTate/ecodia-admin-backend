'use strict'

/**
 * Smoke listener — proves the registry pipeline without doing any real work.
 * relevanceFilter always returns false so handle() is never invoked.
 * subscribesTo 'text_delta' so it registers against a real-ish event type
 * while being provably inert.
 */

module.exports = {
  name: 'smoke',
  model: 'haiku-4-5',
  subscribesTo: ['text_delta'],
  relevanceFilter: () => false,
  handle: async () => {},
  ownsWriteSurface: [],
}
