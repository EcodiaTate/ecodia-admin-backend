const cron = require('node-cron')
const logger = require('../config/logger')
const symbridge = require('../services/symbridgeService')
const vitals = require('../services/vitalSignsService')
const memoryBridge = require('../services/memoryBridgeService')
const metabolismBridge = require('../services/metabolismBridgeService')

// ═══════════════════════════════════════════════════════════════════════
// SYMBRIDGE WORKER
//
// Initializes all symbiosis components:
// - Redis stream consumer (primary message transport)
// - Neo4j message poller (secondary fallback, every 30s)
// - Vital signs monitoring (organism health check, every 15s)
// - Heartbeat sender (every 15s)
// - Memory cross-pollination (every 30 min)
// - Metabolism cost reporting (every 30 min)
// ═══════════════════════════════════════════════════════════════════════

async function init() {
  // Initialize Redis
  await symbridge.initRedis()

  // Start Redis consumer
  await symbridge.startRedisConsumer()

  // Start vital signs monitoring
  vitals.startMonitoring()

  // Neo4j fallback poller (every 30s)
  setInterval(() => {
    symbridge.pollNeo4jMessages().catch(() => {})
  }, 30_000)

  // Heartbeat (every 60s — less aggressive than vitals check)
  setInterval(async () => {
    try {
      const selfHealth = await vitals.checkSelfHealth()
      await symbridge.sendHeartbeat(selfHealth)
    } catch {}
  }, 60_000)

  // Memory cross-pollination (every 30 min)
  cron.schedule('*/30 * * * *', async () => {
    try {
      await memoryBridge.syncToOrganism()
      await memoryBridge.syncFromOrganism()
      await memoryBridge.mirrorCriticalNodes()
    } catch (err) {
      logger.debug('Memory bridge cycle failed', { error: err.message })
    }
  })

  // Metabolism cost reporting (every 30 min)
  cron.schedule('*/30 * * * *', async () => {
    try {
      await metabolismBridge.reportCosts()
    } catch (err) {
      logger.debug('Metabolism report failed', { error: err.message })
    }
  })

  logger.info('Symbridge worker initialized (Redis consumer + Neo4j poller + vitals + memory + metabolism)')
}

init().catch(err => {
  logger.debug('Symbridge worker init failed (non-fatal)', { error: err.message })
})

module.exports = { init }
