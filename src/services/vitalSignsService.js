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

  monitorInterval = setInterval(async () => {
    try {
      await checkOrganismHealth()
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
