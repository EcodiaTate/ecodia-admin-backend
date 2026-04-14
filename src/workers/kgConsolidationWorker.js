const logger = require('../config/logger')
const env = require('../config/env')
const { recordHeartbeat } = require('./heartbeat')

// LLM calls now route through osSessionService.sendTask, so no API key is
// required at this level — just Neo4j.
if (!env.NEO4J_URI) {
  logger.info('KG consolidation worker skipped — NEO4J_URI not set')
  module.exports = {}
} else {
  const consolidation = require('../services/kgConsolidationService')

  logger.info('KG consolidation worker started — adaptive loop, no fixed schedule')

  // ─── Adaptive state ────────────────────────────────────────────────
  let running = true
  let inCycle = false
  let cycleTimer = null
  let lastDirectorRunAt = null

  // ─── Adaptive loop ─────────────────────────────────────────────────
  // Instead of fixed cron times, the worker asks the graph how stale it is
  // and decides the next interval from that signal. Heavy ingestion = run sooner.
  // Graph stable = wait. The graph tells us when it needs maintenance.

  async function scheduleNext() {
    if (!running) return
    let delayMs

    try {
      const staleCount = await consolidation.countStaleNodes?.() ?? 0
      const dedupBacklog = await consolidation.countDedupCandidates?.() ?? 0

      if (staleCount > 500 || dedupBacklog > 100) {
        delayMs = 30 * 60 * 1000       // 30 min — high pressure
      } else if (staleCount > 100 || dedupBacklog > 20) {
        delayMs = 2 * 60 * 60 * 1000  // 2 hr — moderate
      } else {
        delayMs = 6 * 60 * 60 * 1000  // 6 hr — low pressure
      }
    } catch {
      delayMs = 3 * 60 * 60 * 1000    // 3 hr fallback if health check fails
    }

    cycleTimer = setTimeout(runCycle, delayMs)
    logger.debug(`KG consolidation: next cycle in ${Math.round(delayMs / 60000)}min`)
  }

  async function runCycle() {
    if (inCycle || !running) return
    inCycle = true

    try {
      // Director reads the graph and AI-selects which phases to run
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
    } finally {
      inCycle = false
      scheduleNext()
    }
  }

  // ─── Event-triggered consolidation ─────────────────────────────────
  // High-volume ingestion events trigger the Director immediately rather
  // than waiting for the next scheduled window.
  try {
    const eventBus = require('../services/internalEventBusService')
    eventBus.on('kg:ingestion_spike', () => {
      if (!inCycle && running) {
        logger.info('KG consolidation: ingestion spike detected — triggering early cycle')
        if (cycleTimer) clearTimeout(cycleTimer)
        runCycle()
      }
    })
  } catch {}

  // Start first cycle after a short boot delay
  cycleTimer = setTimeout(runCycle, 5 * 60 * 1000)

  function stop() {
    running = false
    if (cycleTimer) clearTimeout(cycleTimer)
  }

  module.exports = { consolidation, stop }
}
