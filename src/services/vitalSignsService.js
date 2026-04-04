const axios = require('axios')
const os = require('os')
const { execFile } = require('child_process')
const { promisify } = require('util')
const execFileAsync = promisify(execFile)
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
//
// Tracks: DB, Neo4j, memory, CPU, event loop lag, PM2 processes,
// restart storms. Per-anomaly cooldowns prevent alert spam while
// ensuring distinct anomaly types are never silenced by each other.
// ═══════════════════════════════════════════════════════════════════════

let organismHealthState = {
  healthy: null, // null = unknown, true = healthy, false = unhealthy
  lastCheck: null,
  consecutiveFailures: 0,
  lastResponseMs: null,
}

const HEALTH_CHECK_INTERVAL = Number(env.ORGANISM_HEALTH_CHECK_INTERVAL_MS) || 15_000
const MAX_CONSECUTIVE_FAILURES = Number(env.ORGANISM_MAX_CONSECUTIVE_FAILURES) || 3

// Cooldown for Thymos incident dispatch — prevents feedback loop where
// Factory session restarts organism → brief health fail → new incident → repeat.
// Default 10 minutes between dispatches.
const THYMOS_DISPATCH_COOLDOWN_MS = Number(env.THYMOS_DISPATCH_COOLDOWN_MS) || 10 * 60 * 1000
let _lastThymosDispatchAt = 0

// ─── CPU Tracking (rolling average over last N samples) ────────────
let _prevCpuTimes = null
function getCpuUsagePercent() {
  const cpus = os.cpus()
  const totals = { user: 0, nice: 0, sys: 0, idle: 0, irq: 0 }
  for (const cpu of cpus) {
    for (const type of Object.keys(cpu.times)) {
      totals[type] = (totals[type] || 0) + cpu.times[type]
    }
  }
  if (!_prevCpuTimes) {
    _prevCpuTimes = totals
    return null // first sample, need delta
  }
  const prev = _prevCpuTimes
  _prevCpuTimes = totals
  const dIdle = totals.idle - prev.idle
  const dTotal = Object.keys(totals).reduce((s, k) => s + (totals[k] - (prev[k] || 0)), 0)
  if (dTotal <= 0) return 0
  return Math.round(((dTotal - dIdle) / dTotal) * 100)
}

// ─── Event Loop Lag ─────────────────────────────────��──────────────
let _eventLoopLagMs = 0
let _lagTimer = null
function startEventLoopLagMonitor() {
  if (_lagTimer) return
  let lastTs = process.hrtime.bigint()
  _lagTimer = setInterval(() => {
    const now = process.hrtime.bigint()
    const elapsed = Number(now - lastTs) / 1e6 // ms
    _eventLoopLagMs = Math.round(Math.max(0, elapsed - 1000)) // target is 1000ms interval
    lastTs = now
  }, 1000)
  _lagTimer.unref() // don't keep process alive for monitoring
}

// ─── PM2 Process Monitoring ────────────────────────────────────────
let _pm2Cache = { processes: [], lastCheck: 0 }
const PM2_CACHE_TTL_MS = 30_000 // refresh PM2 state every 30s at most

async function getPM2Processes() {
  const now = Date.now()
  if (now - _pm2Cache.lastCheck < PM2_CACHE_TTL_MS) return _pm2Cache.processes
  try {
    const { stdout } = await execFileAsync('pm2', ['jlist'], { timeout: 10_000, maxBuffer: 5 * 1024 * 1024 })
    const list = JSON.parse(stdout)
    _pm2Cache.processes = list.map(p => ({
      name: p.name,
      pm_id: p.pm_id,
      status: p.pm2_env?.status || 'unknown',
      restarts: p.pm2_env?.restart_time || 0,
      unstable_restarts: p.pm2_env?.unstable_restarts || 0,
      uptime: p.pm2_env?.pm_uptime ? now - p.pm2_env.pm_uptime : null,
      memory: p.monit?.memory ? Math.round(p.monit.memory / 1024 / 1024) : null, // MB
      cpu: p.monit?.cpu || 0,
    }))
    _pm2Cache.lastCheck = now
  } catch (err) {
    logger.debug('PM2 process list failed', { error: err.message })
    // Return stale cache rather than nothing
  }
  return _pm2Cache.processes
}

// ─── Restart Storm Detection ─────────────────────────��─────────────
// Track restart counts over time to detect processes that keep crashing
let _prevRestartCounts = new Map() // name → restarts

function detectRestartStorms(pm2Processes) {
  const storms = []
  for (const p of pm2Processes) {
    const prev = _prevRestartCounts.get(p.name) || 0
    const delta = p.restarts - prev
    _prevRestartCounts.set(p.name, p.restarts)
    // If a process has restarted 3+ times since last check (~15s), it's storming
    if (delta >= 3) {
      storms.push({ name: p.name, restartsDelta: delta, totalRestarts: p.restarts })
    }
  }
  return storms
}

// ─── Self Health ────────────────────────────────────────────────────

async function checkSelfHealth() {
  const checks = {
    db: false,
    neo4j: false,
    memory: null,
    cpu: null,
    eventLoopLagMs: _eventLoopLagMs,
    activeCCSessions: 0,
    pm2Processes: [],
    restartStorms: [],
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

  // CPU
  checks.cpu = getCpuUsagePercent()

  // CC sessions
  checks.activeCCSessions = ccService.getActiveSessionCount()

  // PM2 process state
  checks.pm2Processes = await getPM2Processes()
  checks.restartStorms = detectRestartStorms(checks.pm2Processes)

  return checks
}

// ─── Organism Health Check ──────────────────────────────────────────

// ─── Anomaly Detection + Cognitive Broadcast ───────────────────────

// Per-anomaly cooldowns: each anomaly type has its own timer so a DB
// anomaly doesn't silence a restart storm alert that appears 1min later.
const _anomalyCooldowns = new Map() // anomalyType → lastBroadcastTimestamp
const ANOMALY_BROADCAST_COOLDOWN_MS = 5 * 60 * 1000 // 5 min per anomaly type
const CRITICAL_ANOMALY_COOLDOWN_MS = 60 * 1000       // 1 min for critical

const CRITICAL_ANOMALIES = new Set(['database_unreachable', 'restart_storm', 'event_loop_blocked'])

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
  if (selfHealth.cpu != null && selfHealth.cpu > 90) {
    anomalies.push('high_cpu')
  }
  if (selfHealth.eventLoopLagMs > 500) {
    anomalies.push('event_loop_blocked')
  }
  // PM2 process down
  for (const p of selfHealth.pm2Processes || []) {
    if (p.status !== 'online') {
      anomalies.push(`pm2_down:${p.name}`)
    }
  }
  // Restart storms
  for (const storm of selfHealth.restartStorms || []) {
    anomalies.push(`restart_storm:${storm.name}`)
  }
  return anomalies
}

async function broadcastHealthAnomaly(anomalies, selfHealth) {
  if (anomalies.length === 0) return
  const now = Date.now()

  // Filter to only anomalies that have passed their per-type cooldown
  const freshAnomalies = anomalies.filter(a => {
    const baseType = a.split(':')[0] // 'pm2_down:ecodia-api' → 'pm2_down'
    const lastBroadcast = _anomalyCooldowns.get(a) || 0
    const cooldown = CRITICAL_ANOMALIES.has(baseType) ? CRITICAL_ANOMALY_COOLDOWN_MS : ANOMALY_BROADCAST_COOLDOWN_MS
    return (now - lastBroadcast) >= cooldown
  })

  if (freshAnomalies.length === 0) return

  // Mark all fresh anomalies as broadcast
  for (const a of freshAnomalies) _anomalyCooldowns.set(a, now)

  // Broadcast to organism via KG hooks
  try {
    const kgHooks = require('./kgIngestionHooks')
    kgHooks.sendCognitiveBroadcast('health_anomaly', 0.9, {
      anomalies: freshAnomalies,
      db_healthy: selfHealth.db,
      neo4j_healthy: selfHealth.neo4j,
      memory: selfHealth.memory,
      cpu: selfHealth.cpu,
      eventLoopLagMs: selfHealth.eventLoopLagMs,
      pm2Processes: (selfHealth.pm2Processes || []).filter(p => p.status !== 'online'),
      restartStorms: selfHealth.restartStorms,
      active_sessions: selfHealth.activeCCSessions,
      timestamp: new Date().toISOString(),
    })
  } catch (err) {
    logger.warn('Failed to broadcast health anomaly to organism', { error: err.message, anomalies: freshAnomalies })
  }

  // Emit on event bus for local services
  try {
    const eventBus = require('./internalEventBusService')
    eventBus.emit('health:anomaly_detected', { anomalies: freshAnomalies, timestamp: new Date().toISOString() })
  } catch (err) {
    logger.warn('Failed to emit health anomaly to event bus', { error: err.message })
  }

  // Broadcast to WebSocket so Cortex/frontend sees it immediately
  try {
    const wsManager = require('../websocket/wsManager')
    wsManager.broadcast('health:anomaly', {
      anomalies: freshAnomalies,
      selfHealth: {
        db: selfHealth.db,
        neo4j: selfHealth.neo4j,
        cpu: selfHealth.cpu,
        eventLoopLagMs: selfHealth.eventLoopLagMs,
        memory: selfHealth.memory,
        pm2Down: (selfHealth.pm2Processes || []).filter(p => p.status !== 'online').map(p => p.name),
        restartStorms: (selfHealth.restartStorms || []).map(s => s.name),
      },
      timestamp: new Date().toISOString(),
    })
  } catch (err) {
    logger.debug('Failed to broadcast health anomaly via WebSocket', { error: err.message })
  }
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

      // Notify human — DB + WS broadcast
      const notifPayload = {
        type: 'symbiont_down',
        message: 'CRITICAL: Organism is unresponsive',
        metadata: { failures: organismHealthState.consecutiveFailures, lastError: err.message },
      }
      await db`
        INSERT INTO notifications (type, message, metadata)
        VALUES ('symbiont_down', 'CRITICAL: Organism is unresponsive',
                ${JSON.stringify(notifPayload.metadata)})
      `.catch(() => {})
      try { require('../websocket/wsManager').broadcast('notification', { payload: notifPayload }) } catch {}

      // Dispatch Factory investigation — diagnose and fix whatever crashed the organism.
      // Cooldown prevents feedback loop: session restarts organism → brief health fail → new incident → repeat.
      const now = Date.now()
      const timeSinceLastDispatch = now - _lastThymosDispatchAt
      if (timeSinceLastDispatch < THYMOS_DISPATCH_COOLDOWN_MS) {
        logger.warn('Thymos dispatch skipped — cooldown active', {
          cooldownRemainingMs: THYMOS_DISPATCH_COOLDOWN_MS - timeSinceLastDispatch,
          lastDispatchAt: new Date(_lastThymosDispatchAt).toISOString(),
        })
      } else {
        _lastThymosDispatchAt = now
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
  startEventLoopLagMonitor()

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
  if (_lagTimer) {
    clearInterval(_lagTimer)
    _lagTimer = null
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
  getPM2Processes,
}
