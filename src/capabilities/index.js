// ─── Capability Bootstrap ─────────────────────────────────────────────
// Requiring this file registers all capabilities into the registry.
// Call once at server startup. Order doesn't matter — capabilities
// are looked up by name, not position.
//
// To add a new capability domain: create the file, add it here.
// The registry, actionQueue, cortex, and directAction all pick it up
// automatically. No other files need to change.

require('./gmail')
require('./calendar')
require('./drive')
require('./crm')
require('./social')
require('./factory')
require('./finance')

const registry = require('../services/capabilityRegistry')
const logger = require('../config/logger')

const total = registry.list().length
logger.info(`CapabilityRegistry: ${total} capabilities registered across ${
  [...new Set(registry.list().map(c => c.domain))].join(', ')
}`)

module.exports = registry
