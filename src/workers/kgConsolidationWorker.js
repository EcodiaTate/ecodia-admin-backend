require('../config/env')
const cron = require('node-cron')
const logger = require('../config/logger')
const env = require('../config/env')
const { recordHeartbeat } = require('./heartbeat')

if (!env.NEO4J_URI || !env.DEEPSEEK_API_KEY) {
  logger.info('KG consolidation worker skipped — NEO4J_URI or DEEPSEEK_API_KEY not set')
  return
}

const consolidation = require('../services/kgConsolidationService')

logger.info('KG consolidation worker started')

// Track last Director run to avoid running 6h dedup immediately after a full cycle
let lastDirectorRunAt = null

// ─── ConsolidationDirector: nightly at 3 AM AEST (17:00 UTC) ────────
// The Director reads the graph state and AI-selects which phases to run.
// Replaces the old hardcoded 10-phase sequential pipeline.
cron.schedule('0 17 * * *', async () => {
  logger.info('KG consolidation: nightly Director cycle triggered')
  try {
    const results = await consolidation.runConsolidationPipeline()
    lastDirectorRunAt = Date.now()
    logger.info('KG consolidation: nightly Director cycle complete', {
      phases: results.plan?.map(p => p.phase),
      durationMs: results.durationMs,
    })
    await recordHeartbeat('kg_consolidation', 'active')
  } catch (err) {
    logger.error('KG consolidation: nightly Director failed', { error: err.message })
    await recordHeartbeat('kg_consolidation', 'error', err.message)
  }
})

// ─── Lightweight dedup: runs every 6 hours ───────────────────────────
// Catches duplicates from high-volume ingestion before they accumulate.
// Skip if the Director ran in the last 2 hours (it may have already deduped).
cron.schedule('0 */6 * * *', async () => {
  if (lastDirectorRunAt && Date.now() - lastDirectorRunAt < 2 * 60 * 60 * 1000) {
    logger.debug('KG consolidation: skipping 6h dedup (Director ran recently)')
    return
  }
  try {
    const merged = await consolidation.deduplicateNodes()
    if (merged.length > 0) {
      logger.info(`KG consolidation: 6h dedup merged ${merged.length} nodes`)
    }
  } catch (err) {
    logger.error('KG consolidation: 6h dedup failed', { error: err.message })
  }
})
