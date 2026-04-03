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
// - Vital signs monitoring
// - Heartbeat sender
// - Memory cross-pollination (adaptive — pressure + delta-driven)
// - Metabolism cost reporting (adaptive — event-triggered)
// ═══════════════════════════════════════════════════════════════════════

// ─── Adaptive memory sync ─────────────────────────────────────────────
// Instead of a fixed 30min clock, sync frequency adapts to how much has
// changed and how high the organism pressure is. Heavy activity → sync sooner.
// Quiet period → sync less often. Max interval caps at 60 min.

let _memorySyncTimer = null
let _memorySyncInProgress = false

async function runMemorySync() {
  if (_memorySyncInProgress) return
  _memorySyncInProgress = true
  try {
    await memoryBridge.syncToOrganism()
    await memoryBridge.syncFromOrganism()
    await memoryBridge.mirrorCriticalNodes()
  } catch (err) {
    logger.debug('Memory bridge cycle failed', { error: err.message })
  } finally {
    _memorySyncInProgress = false
    scheduleMemorySync()
  }
}

function scheduleMemorySync() {
  if (_memorySyncTimer) clearTimeout(_memorySyncTimer)
  const pressure = metabolismBridge.getPressure?.() ?? 0
  // High pressure → sync every 10 min; low pressure → sync every 60 min
  const delayMs = pressure > 0.6
    ? 10 * 60 * 1000
    : pressure > 0.3
      ? 30 * 60 * 1000
      : 60 * 60 * 1000
  _memorySyncTimer = setTimeout(runMemorySync, delayMs)
}

// ─── Adaptive metabolism reporting ───────────────────────────────────
// Cost events trigger immediate reporting. Otherwise reports on a
// pressure-adjusted interval.

let _metabolismTimer = null

async function runMetabolismReport() {
  if (_metabolismTimer) clearTimeout(_metabolismTimer)
  try {
    await metabolismBridge.reportCosts()
  } catch (err) {
    logger.debug('Metabolism report failed', { error: err.message })
  }
  const pressure = metabolismBridge.getPressure?.() ?? 0
  const delayMs = pressure > 0.6 ? 15 * 60 * 1000 : 45 * 60 * 1000
  _metabolismTimer = setTimeout(runMetabolismReport, delayMs)
}

async function init() {
  // Initialize Redis
  await symbridge.initRedis()

  // Start Redis consumer
  await symbridge.startRedisConsumer()

  // Start vital signs monitoring
  vitals.startMonitoring()

  // Neo4j fallback poller (every 30s — infrastructure heartbeat, must be reliable)
  setInterval(() => {
    symbridge.pollNeo4jMessages().catch(() => {})
  }, 30_000)

  // Heartbeat (every 60s)
  setInterval(async () => {
    try {
      const selfHealth = await vitals.checkSelfHealth()
      await symbridge.sendHeartbeat(selfHealth)
    } catch {}
  }, 60_000)

  // Start adaptive memory sync (first run after 5 min boot delay)
  _memorySyncTimer = setTimeout(runMemorySync, 5 * 60 * 1000)

  // Start adaptive metabolism reporting (first run after 10 min)
  _metabolismTimer = setTimeout(runMetabolismReport, 10 * 60 * 1000)

  // React to significant KG events immediately rather than waiting for next window
  try {
    const eventBus = require('../services/internalEventBusService')
    eventBus.on('kg:high_importance_ingestion', () => {
      if (!_memorySyncInProgress) {
        if (_memorySyncTimer) clearTimeout(_memorySyncTimer)
        runMemorySync()
      }
    })
    eventBus.on('factory:session_complete', runMetabolismReport)
  } catch {}

  logger.info('Symbridge worker initialized (Redis consumer + Neo4j poller + vitals + adaptive memory + adaptive metabolism)')
}

init().catch(err => {
  logger.debug('Symbridge worker init failed (non-fatal)', { error: err.message })
})

module.exports = { init }
