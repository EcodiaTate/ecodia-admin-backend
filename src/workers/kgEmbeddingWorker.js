require('../config/env')
const cron = require('node-cron')
const logger = require('../config/logger')
const kg = require('../services/knowledgeGraphService')
const env = require('../config/env')
const { recordHeartbeat } = require('./heartbeat')

if (!env.NEO4J_URI) {
  logger.info('KG embedding worker skipped — NEO4J_URI not set')
  return
}

logger.info('KG embedding worker started')

// Run every 5 minutes — embed stale nodes in batches of 100
cron.schedule('*/5 * * * *', async () => {
  try {
    const count = await kg.embedStaleNodes(100)
    if (count > 0) {
      logger.info(`KG embedding worker: embedded ${count} nodes`)
    }
    await recordHeartbeat('kg_embedding', 'active')
  } catch (err) {
    logger.error('KG embedding worker failed', { error: err.message })
    await recordHeartbeat('kg_embedding', 'error', err.message)
  }
})

// On startup, ensure vector index exists
kg.ensureVectorIndex().catch(err =>
  logger.warn('Failed to ensure KG vector index', { error: err.message })
)
