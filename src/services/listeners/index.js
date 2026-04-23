'use strict'

/**
 * Listener subsystem boot entry point.
 *
 * Loads all listener modules from this directory, registers them with the
 * in-process wsManager subscriber, and returns the registry instance.
 *
 * On any failure: logs at error, returns null — server stays up.
 */

const logger = require('../../config/logger')
const registry = require('./registry')

async function startListenerSubsystem() {
  try {
    const listeners = registry.loadListeners()
    registry.registerAll()
    logger.info(`listener subsystem: started with ${listeners.length} listeners`)
    return registry
  } catch (err) {
    logger.error('listener subsystem: failed to start', { error: err.message })
    return null
  }
}

module.exports = { startListenerSubsystem }
