require('../config/env')
const cron = require('node-cron')
const logger = require('../config/logger')
const env = require('../config/env')

if (!env.NEO4J_URI || !env.DEEPSEEK_API_KEY) {
  logger.info('KG consolidation worker skipped — NEO4J_URI or DEEPSEEK_API_KEY not set')
  return
}

const consolidation = require('../services/kgConsolidationService')

logger.info('KG consolidation worker started')

// ─── Full pipeline: runs daily at 3 AM AEST (17:00 UTC) ─────────────
// Tate is asleep. The graph consolidates, patterns emerge, noise decays.
cron.schedule('0 17 * * *', async () => {
  logger.info('KG consolidation: nightly pipeline triggered')
  try {
    const results = await consolidation.runConsolidationPipeline()
    logger.info('KG consolidation: nightly pipeline complete', results)
  } catch (err) {
    logger.error('KG consolidation: nightly pipeline failed', { error: err.message })
  }
})

// ─── Lightweight dedup: runs every 6 hours ───────────────────────────
// Catches duplicates from high-volume ingestion before they accumulate
cron.schedule('0 */6 * * *', async () => {
  try {
    const merged = await consolidation.deduplicateNodes()
    if (merged.length > 0) {
      logger.info(`KG consolidation: 6h dedup merged ${merged.length} nodes`)
    }
  } catch (err) {
    logger.error('KG consolidation: 6h dedup failed', { error: err.message })
  }
})

// ─── Decay check: runs weekly on Sunday at 4 AM AEST (18:00 UTC) ────
// More aggressive pruning runs less frequently
cron.schedule('0 18 * * 0', async () => {
  try {
    const results = await consolidation.decayStaleNodes()
    logger.info('KG consolidation: weekly decay complete', results)
  } catch (err) {
    logger.error('KG consolidation: weekly decay failed', { error: err.message })
  }
})
