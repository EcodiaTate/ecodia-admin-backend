const cron = require('node-cron')
const logger = require('../config/logger')
const db = require('../config/db')
const codebaseIntelligence = require('../services/codebaseIntelligenceService')
const { recordHeartbeat } = require('./heartbeat')

// ═══════════════════════════════════════════════════════════════════════
// CODEBASE INDEX WORKER
//
// Every 10 minutes: sync all registered codebases, index changed files,
// and embed any stale chunks. This keeps the codebase intelligence
// layer current and searchable.
// ═══════════════════════════════════════════════════════════════════════

let running = false

async function runIndexCycle() {
  if (running) {
    logger.debug('Codebase index cycle already running, skipping')
    return
  }

  running = true
  try {
    const codebases = await db`SELECT id, name FROM codebases ORDER BY name`

    if (codebases.length === 0) return

    for (const codebase of codebases) {
      try {
        // Sync from git
        await codebaseIntelligence.syncCodebase(codebase.id)

        // Index changed files
        const result = await codebaseIntelligence.indexCodebase(codebase.id)
        if (result.indexed > 0) {
          logger.info(`Codebase ${codebase.name}: indexed ${result.indexed} files`)
        }
      } catch (err) {
        logger.warn(`Failed to index codebase ${codebase.name}`, { error: err.message })
      }
    }

    // Embed any stale chunks across all codebases
    const embedded = await codebaseIntelligence.embedStaleChunks(50)
    if (embedded > 0) {
      logger.info(`Embedded ${embedded} stale code chunks`)
    }
    await recordHeartbeat('codebase_index', 'active')
  } catch (err) {
    logger.error('Codebase index cycle failed', { error: err.message })
    await recordHeartbeat('codebase_index', 'error', err.message)
  } finally {
    running = false
  }
}

// Every 10 minutes
cron.schedule('*/10 * * * *', () => {
  runIndexCycle().catch(err =>
    logger.error('Codebase index cron error', { error: err.message })
  )
})

logger.info('Codebase index worker started (every 10 min)')

module.exports = { runIndexCycle }
