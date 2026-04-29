// ─── Capability Bootstrap ─────────────────────────────────────────────
// Requiring this file registers all capabilities into the registry.
// Call once at server startup. Order doesn't matter — capabilities
// are looked up by name, not position.
//
// To add a new capability domain: create the file, add it here.
// The registry, actionQueue, cortex, and directAction all pick it up
// automatically. No other files need to change.
//
// Each domain is loaded independently so a failure in one domain
// (e.g. a missing dependency) doesn't prevent ALL other domains
// from registering. The broken domain logs an error and the rest
// of the system continues.

const logger = require('../config/logger')

const domains = [
  './gmail',
  './calendar',
  './drive',
  './crm',
  './social',
  './factory',
  './finance',
  './system',
  './selfhood',
  './self_observability',
  './context',
  './growth',
  './bookkeeping',
  './coding',
  './laptop',
]

const registry = require('../services/capabilityRegistry')

for (const domain of domains) {
  try {
    require(domain)
  } catch (err) {
    // Strip leading './' for the domain name recorded in the registry
    const domainName = domain.replace(/^\.\//, '')
    registry.recordFailedDomain(domainName)
    logger.error(`CapabilityBootstrap: failed to load ${domain}`, { error: err.message, stack: err.stack })
  }
}

const total = registry.list().length
const failed = registry.getFailedDomains()
logger.info(`CapabilityRegistry: ${total} capabilities registered across ${
  [...new Set(registry.list().map(c => c.domain))].join(', ')
}${failed.length > 0 ? ` — FAILED domains: ${failed.join(', ')} (will auto-recover on first use)` : ''}`)

module.exports = registry
