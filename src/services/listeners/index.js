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

    // Start the DB event bridge - connects via LISTEN/NOTIFY and routes DB
    // state changes into the in-process listener registry. Failure is
    // non-fatal: the listener subsystem continues without the db bridge.
    try {
      await require('./dbBridge').start()
      logger.info(`listener subsystem: started with ${listeners.length} listeners + db bridge`)
    } catch (bridgeErr) {
      logger.warn('listener subsystem: db bridge failed to start (non-fatal)', { error: bridgeErr.message })
      logger.info(`listener subsystem: started with ${listeners.length} listeners (no db bridge)`)
    }

    return registry
  } catch (err) {
    logger.error('listener subsystem: failed to start', { error: err.message })
    return null
  }
}

module.exports = { startListenerSubsystem }
