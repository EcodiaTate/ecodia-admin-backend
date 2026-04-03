const logger = require('../config/logger')
const env = require('../config/env')
const { recordHeartbeat } = require('./heartbeat')

if (!env.NEO4J_URI) {
  logger.info('KG embedding worker skipped — NEO4J_URI not set')
  module.exports = {}
} else {
  const kg = require('../services/knowledgeGraphService')

  // ─── Adaptive embedding loop ───────────────────────────────────────────
  // No fixed cron. Interval adapts to how many stale nodes exist:
  //   backlog > 500 → run every 1 min
  //   backlog > 100 → run every 3 min
  //   quiet         → run every 10 min
  // The graph tells us when it needs work — not the clock.

  let running = true
  let embedTimer = null

  async function embedCycle() {
    if (!running) return

    let nextDelayMs = 10 * 60 * 1000  // 10 min default

    try {
      const count = await kg.embedStaleNodes(100)
      if (count > 0) {
        logger.info(`KG embedding worker: embedded ${count} nodes`)
        // Still work to do — check how much is left
        try {
          const remaining = await kg.countStaleNodes?.() ?? count
          if (remaining > 500) nextDelayMs = 60 * 1000
          else if (remaining > 100) nextDelayMs = 3 * 60 * 1000
        } catch {
          nextDelayMs = 3 * 60 * 1000  // assume more work if count fails
        }
      }
      await recordHeartbeat('kg_embedding', 'active')
    } catch (err) {
      logger.error('KG embedding worker failed', { error: err.message })
      await recordHeartbeat('kg_embedding', 'error', err.message)
      nextDelayMs = 5 * 60 * 1000  // back off on error
    }

    if (running) embedTimer = setTimeout(embedCycle, nextDelayMs)
  }

  // On startup, ensure vector index exists, then begin adaptive loop
  kg.ensureVectorIndex()
    .catch(err => logger.warn('Failed to ensure KG vector index', { error: err.message }))
    .finally(() => {
      embedTimer = setTimeout(embedCycle, 30 * 1000)  // first run after 30s boot delay
    })

  logger.info('KG embedding worker started — adaptive loop, no fixed schedule')

  function stop() {
    running = false
    if (embedTimer) clearTimeout(embedTimer)
  }

  module.exports = { kg, stop }
}
