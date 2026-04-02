const cron = require('node-cron')
const logger = require('../config/logger')
const env = require('../config/env')
const { recordHeartbeat } = require('./heartbeat')

if (!env.NEO4J_URI || !env.DEEPSEEK_API_KEY) {
  logger.info('KG consolidation worker skipped — NEO4J_URI or DEEPSEEK_API_KEY not set')
  // module-level return is not valid — use a flag instead
  module.exports = {}
} else {
  const consolidation = require('../services/kgConsolidationService')

  logger.info('KG consolidation worker started')

  // Track when the Director last ran so the dedup cron can skip if unnecessary
  let lastDirectorRunAt = null

  // ─── ConsolidationDirector: every 6 hours ───────────────────────────
  // The Director reads the graph state and AI-selects which phases to run.
  // This is NOT a fixed-schedule "run everything at 3am" — it runs regularly
  // and lets the Director decide what (if anything) needs doing.
  // The AutonomousMaintenanceMind can also trigger consolidation via the
  // event bus when it detects patterns worth synthesising.
  cron.schedule('0 */6 * * *', async () => {
    logger.info('KG consolidation: Director cycle triggered')
    try {
      const results = await consolidation.runConsolidationPipeline()
      lastDirectorRunAt = Date.now()
      logger.info('KG consolidation: Director cycle complete', {
        phases: results.plan?.map(p => p.phase),
        durationMs: results.durationMs,
      })
      await recordHeartbeat('kg_consolidation', 'active')
    } catch (err) {
      logger.error('KG consolidation: Director cycle failed', { error: err.message })
      await recordHeartbeat('kg_consolidation', 'error', err.message)
    }
  })

  // ─── Lightweight dedup: runs every 2 hours ───────────────────────────
  // Catches duplicates from high-volume ingestion before they accumulate.
  // Skip if the Director ran in the last 2 hours — it already ran dedup
  // when the graph state warranted it.
  cron.schedule('0 */2 * * *', async () => {
    const twoHoursMs = 2 * 60 * 60 * 1000
    if (lastDirectorRunAt && Date.now() - lastDirectorRunAt < twoHoursMs) {
      logger.debug('KG consolidation: 2h dedup skipped — Director ran recently')
      return
    }
    try {
      const merged = await consolidation.deduplicateNodes()
      if (merged.length > 0) {
        logger.info(`KG consolidation: 2h dedup merged ${merged.length} nodes`)
        await recordHeartbeat('kg_consolidation', 'active')
      }
    } catch (err) {
      logger.error('KG consolidation: 2h dedup failed', { error: err.message })
    }
  })

  module.exports = { consolidation }
}
