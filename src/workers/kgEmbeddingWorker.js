require('../config/env')
const cron = require('node-cron')
const logger = require('../config/logger')
const kg = require('../services/knowledgeGraphService')
const env = require('../config/env')

if (!env.NEO4J_URI) {
  logger.info('KG embedding worker skipped — NEO4J_URI not set')
  return
}

logger.info('KG embedding worker started')

// Run every 15 minutes — embed any stale nodes
cron.schedule('*/15 * * * *', async () => {
  try {
    const count = await kg.embedStaleNodes(30)
    if (count > 0) {
      logger.info(`KG embedding worker: embedded ${count} nodes`)
    }
  } catch (err) {
    logger.error('KG embedding worker failed', { error: err.message })
  }
})

// On startup, ensure vector index exists
kg.ensureVectorIndex().catch(err =>
  logger.warn('Failed to ensure KG vector index', { error: err.message })
)
