const axios = require('axios')
const os = require('os')
const db = require('../config/db')
const env = require('../config/env')
const logger = require('../config/logger')
const { healthCheck: neo4jHealth } = require('../config/neo4j')
const ccService = require('./ccService')

// ═══════════════════════════════════════════════════════════════════════
// VITAL SIGNS SERVICE — Mutual Health Monitoring
//
// Both bodies continuously monitor each other's health.
// EcodiaOS checks the organism every 15s.
// Reports combined vitals via symbridge for organism consumption.
// ═══════════════════════════════════════════════════════════════════════

let organismHealthState = {
  healthy: null, // null = unknown, true = healthy, false = unhealthy
  lastCheck: null,
  consecutiveFailures: 0,
  lastResponseMs: null,
}

const HEALTH_CHECK_INTERVAL = 15_000 // 15s
const MAX_CONSECUTIVE_FAILURES = 3

// ─── Self Health ────────────────────────────────────────────────────

async function checkSelfHealth() {
  const checks = {
    db: false,
    neo4j: false,
    memory: null,
    activeCCSessions: 0,
  }

  // DB
  try {
    await db`SELECT 1`
    checks.db = true
  } catch (err) {
    checks.db = false
    logger.warn('Vital signs: DB health check failed', { error: err.message })
  }

  // Neo4j
  try {
    checks.neo4j = await neo4jHealth()
  } catch (err) {
    checks.neo4j = false
    logger.debug('Vital signs: Neo4j health check failed', { error: err.message })
  }

  // Memory
  const used = process.memoryUsage()
  checks.memory = {
    rss: Math.round(used.rss / 1024 / 1024),
    heapUsed: Math.round(used.heapUsed / 1024 / 1024),
    heapTotal: Math.round(used.heapTotal / 1024 / 1024),
    systemFree: Math.round(os.freemem() / 1024 / 1024),
  }

  // CC sessions
  checks.activeCCSessions = ccService.getActiveSessionCount()

  return checks
}

// ─── Organism Health Check ──────────────────────────────────────────

// ─── Anomaly Detection + Cognitive Broadcast ───────────────────────

let lastAnomalyBroadcast = 0
const ANOMALY_BROADCAST_COOLDOWN_MS = 5 * 60 * 1000 // 5 min debounce

function detectAnomaly(selfHealth) {
  const anomalies = []
  if (!selfHealth.db) anomalies.push('database_unreachable')
  if (!selfHealth.neo4j) anomalies.push('neo4j_unreachable')
  if (selfHealth.memory && selfHealth.memory.heapUsed > selfHealth.memory.heapTotal * 0.9) {
    anomalies.push('heap_pressure')
  }
  if (selfHealth.memory && selfHealth.memory.systemFree < 256) {
    anomalies.push('low_system_memory')
  }
  return anomalies
}

async function broadcastHealthAnomaly(anomalies, selfHealth) {
  if (anomalies.length === 0) return
  // Debounce: don't spam the organism with repeated anomaly broadcasts
  const now = Date.now()
  if (now - lastAnomalyBroadcast < ANOMALY_BROADCAST_COOLDOWN_MS) return
  lastAnomalyBroadcast = now
  try {
    const kgHooks = require('./kgIngestionHooks')
    kgHooks.sendCognitiveBroadcast('health_anomaly', 0.9, {
      anomalies,
      db_healthy: selfHealth.db,
      neo4j_healthy: selfHealth.neo4j,
      memory: selfHealth.memory,
      active_sessions: selfHealth.activeCCSessions,
      timestamp: new Date().toISOString(),
    })
  } catch {}

  // Also emit on event bus for local services
  try {
    const eventBus = require('./internalEventBusService')
    eventBus.emit('health:anomaly_detected', { anomalies, timestamp: new Date().toISOString() })
  } catch {}
}

async function checkOrganismHealth() {
  if (!env.ORGANISM_API_URL) {
    organismHealthState.healthy = null
    return organismHealthState
  }

  const startMs = Date.now()
  try {
    const res = await axios.get(`${env.ORGANISM_API_URL}/health`, { timeout: 10_000 })
    const responseMs = Date.now() - startMs

    organismHealthState = {
      healthy: res.status >= 200 && res.status < 400,
      lastCheck: new Date().toISOString(),
      consecutiveFailures: 0,
      lastResponseMs: responseMs,
      data: res.data,
    }
  } catch (err) {
    organismHealthState.consecutiveFailures++
    organismHealthState.lastCheck = new Date().toISOString()
    organismHealthState.lastResponseMs = Date.now() - startMs
    organismHealthState.healthy = false

    if (organismHealthState.consecutiveFailures === MAX_CONSECUTIVE_FAILURES) {
      logger.error('SYMBIONT DOWN: Organism unresponsive after 3 consecutive failures')

      // Notify human
      await db`
        INSERT INTO notifications (type, message, metadata)
        VALUES ('symbiont_down', 'CRITICAL: Organism is unresponsive',
                ${JSON.stringify({ failures: organismHealthState.consecutiveFailures, lastError: err.message })})
      `.catch(() => {})

      // Dispatch Factory investigation — diagnose and fix whatever crashed the organism
      try {
        const factoryTrigger = require('./factoryTriggerService')
        factoryTrigger.dispatchFromThymos({
          severity: 'critical',
          affected_system: 'organism',
          codebase_name: 'organism-backend',
          error_message: `Organism unresponsive after ${MAX_CONSECUTIVE_FAILURES} consecutive health check failures. Last error: ${err.message}`,
          description: 'Organism process is down or not responding to health checks on port 8000. Investigate via pm2 logs, check for runtime errors (uncaught exceptions, missing awaits on coroutines, import failures), and restart or fix as needed.',
          stack_trace: '',
          id: `symbiont_down_${Date.now()}`,
        }).catch(dispatchErr => {
          logger.warn('Failed to dispatch Factory investigation for SYMBIONT DOWN', { error: dispatchErr.message })
        })
      } catch (triggerErr) {
        logger.warn('Factory trigger not available for SYMBIONT DOWN', { error: triggerErr.message })
      }
    }

    if (organismHealthState.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
      logger.warn('Organism health check failed', {
        failures: organismHealthState.consecutiveFailures,
        error: err.message,
      })
    }
  }

  return organismHealthState
}

// ─── Receive Organism Health (via symbridge) ────────────────────────

async function receiveOrganismHealth(healthData) {
  // safe_mode and degraded are still "alive" — the organism is responding, just limited
  const aliveStatuses = ['alive', 'healthy', 'safe_mode', 'degraded']
  organismHealthState = {
    healthy: aliveStatuses.includes(healthData.status),
    lastCheck: healthData.timestamp || new Date().toISOString(),
    consecutiveFailures: 0,
    lastResponseMs: null,
    data: healthData,
  }
}

// ─── Combined Vitals Report ─────────────────────────────────────────

async function getVitals() {
  const selfHealth = await checkSelfHealth()
  return {
    ecodiaos: {
      healthy: selfHealth.db && selfHealth.neo4j,
      ...selfHealth,
    },
    organism: organismHealthState,
    timestamp: new Date().toISOString(),
  }
}

// ─── Report Vitals to Organism ──────────────────────────────────────

async function reportVitals() {
  const selfHealth = await checkSelfHealth()
  const symbridge = require('./symbridgeService')
  await symbridge.send('health', {
    status: selfHealth.db ? 'alive' : 'degraded',
    timestamp: new Date().toISOString(),
    ...selfHealth,
  })
}

// ─── Start Monitoring Loop ──────────────────────────────────────────

let monitorInterval = null

function startMonitoring() {
  if (monitorInterval) return

  let cycleCount = 0
  monitorInterval = setInterval(async () => {
    try {
      cycleCount++

      // Check organism health
      await checkOrganismHealth()

      // Check self health + broadcast anomalies to organism's Atune
      const selfHealth = await checkSelfHealth()
      const anomalies = detectAnomaly(selfHealth)
      if (anomalies.length > 0) {
        await broadcastHealthAnomaly(anomalies, selfHealth)
      }

      // Report our own vitals to the organism every 4 cycles (~60s)
      // so Skia stays current without spamming the symbridge
      if (cycleCount % 4 === 0) {
        reportVitals().catch(() => {})
      }
    } catch (err) {
      logger.debug('Vital signs check error', { error: err.message })
    }
  }, HEALTH_CHECK_INTERVAL)

  logger.info('Vital signs monitoring started (every 15s)')
}

function stopMonitoring() {
  if (monitorInterval) {
    clearInterval(monitorInterval)
    monitorInterval = null
  }
}

// Clean up on process exit
process.on('SIGTERM', stopMonitoring)
process.on('SIGINT', stopMonitoring)

module.exports = {
  checkSelfHealth,
  checkOrganismHealth,
  receiveOrganismHealth,
  getVitals,
  reportVitals,
  startMonitoring,
  stopMonitoring,
}
