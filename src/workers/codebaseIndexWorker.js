const logger = require('../config/logger')
const db = require('../config/db')
const codebaseIntelligence = require('../services/codebaseIntelligenceService')
const { recordHeartbeat } = require('./heartbeat')

// ═══════════════════════════════════════════════════════════════════════
// CODEBASE INDEX WORKER — Adaptive loop
//
// No fixed schedule. Interval adapts to what the last cycle found:
//   - Files indexed or chunks embedded → check again sooner (2 min)
//   - Nothing to do → back off (up to 30 min)
//   - Error → retry in 5 min
//
// The autonomousMaintenanceWorker can also trigger runIndexCycle()
// directly when the AI decides indexing is warranted.
// ═══════════════════════════════════════════════════════════════════════

let running = false

async function runIndexCycle() {
  if (running) {
    logger.debug('Codebase index cycle already running, skipping')
    return
  }

  running = true
  let totalIndexed = 0
  try {
    const codebases = await db`SELECT id, name FROM codebases ORDER BY name`

    if (codebases.length === 0) return { indexed: 0, embedded: 0 }

    for (const codebase of codebases) {
      try {
        // Sync from git
        await codebaseIntelligence.syncCodebase(codebase.id)

        // Index changed files
        const result = await codebaseIntelligence.indexCodebase(codebase.id)
        if (result.indexed > 0) {
          logger.info(`Codebase ${codebase.name}: indexed ${result.indexed} files`)
          totalIndexed += result.indexed
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
    return { indexed: totalIndexed, embedded }
  } catch (err) {
    logger.error('Codebase index cycle failed', { error: err.message })
    await recordHeartbeat('codebase_index', 'error', err.message)
    return { error: err.message }
  } finally {
    running = false
  }
}

// ─── Adaptive loop ────────────────────────────────────────────────────

let _loopTimer = null

function jitter(ms) {
  return ms + Math.floor(Math.random() * ms * 0.15)
}

async function loop() {
  const result = await runIndexCycle()
  const hadWork = (result?.indexed ?? 0) > 0 || (result?.embedded ?? 0) > 0
  const hadError = !!result?.error

  let nextMs
  if (hadError) {
    nextMs = jitter(5 * 60_000)          // 5 min on error
  } else if (hadWork) {
    nextMs = jitter(2 * 60_000)          // 2 min if there was work to do
  } else {
    // Nothing found — back off up to 30 min
    nextMs = jitter(Math.min(30 * 60_000, (_loopTimer?._backoff ?? 5 * 60_000) * 1.5))
  }

  _loopTimer = setTimeout(loop, nextMs)
  _loopTimer._backoff = nextMs
}

// First run 30s after boot (let other workers settle)
_loopTimer = setTimeout(loop, 30_000)

logger.info('Codebase index worker started — adaptive loop')

module.exports = { runIndexCycle }
