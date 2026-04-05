const { Router } = require('express')
const axios = require('axios')
const env = require('../config/env')
const logger = require('../config/logger')

const router = Router()

// Auth: JWT or Symbridge secret — same pattern as internalCortexState
router.use((req, res, next) => {
  const header = req.headers.authorization
  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Unauthorized' })
  }
  const token = header.slice(7)

  try {
    const jwt = require('jsonwebtoken')
    jwt.verify(token, env.JWT_SECRET)
    return next()
  } catch { /* not a JWT — try symbridge secret */ }

  if (env.SYMBRIDGE_SECRET && token === env.SYMBRIDGE_SECRET) {
    return next()
  }

  return res.status(401).json({ error: 'Unauthorized' })
})

// GET /api/v1/organism/metrics — real-time organism health + cognitive data
router.get('/', async (_req, res, next) => {
  try {
    const vitals = require('../services/vitalSignsService')
    const orgUrl = env.ORGANISM_API_URL
    const timeout = { timeout: 5000 }

    const result = {
      timestamp: new Date().toISOString(),
      reachable: false,
      cached: vitals.checkOrganismHealth ? null : null,
    }

    // Always include the cached health state from the monitoring loop
    const cachedHealth = await vitals.checkOrganismHealth()
    result.cached = {
      healthy: cachedHealth.healthy,
      lastCheck: cachedHealth.lastCheck,
      consecutiveFailures: cachedHealth.consecutiveFailures,
      lastResponseMs: cachedHealth.lastResponseMs,
    }

    if (!orgUrl) {
      result.error = 'ORGANISM_API_URL not configured'
      return res.json(result)
    }

    // Fetch live data from the organism in parallel
    const live = {}
    const fetches = await Promise.allSettled([
      // Core health endpoint — phase, coherence, systems, cycle info
      axios.get(`${orgUrl}/health`, timeout).then(r => {
        result.reachable = true
        live.health = r.data
      }),

      // Thymos: immune system — active incidents, healing mode, drive state
      axios.get(`${orgUrl}/api/v1/thymos/drive-state`, timeout).then(r => { live.driveState = r.data }),
      axios.get(`${orgUrl}/api/v1/thymos/incidents`, { ...timeout, params: { limit: 5 } }).then(r => { live.incidents = r.data }),

      // Nova: deliberation — active goals, beliefs
      axios.get(`${orgUrl}/api/v1/nova/goals`, timeout).then(r => { live.goals = r.data }),

      // Equor: constitutional health
      axios.get(`${orgUrl}/api/v1/equor/health`, timeout).then(r => { live.constitution = r.data }),

      // Benchmarks: learning velocity
      axios.get(`${orgUrl}/api/v1/benchmarks/latest`, timeout).then(r => { live.benchmarks = r.data }),

      // Telos: effective intelligence
      axios.get(`${orgUrl}/api/v1/telos/report`, timeout).then(r => { live.effectiveI = r.data }),

      // Oikos: economic metabolism
      axios.get(`${orgUrl}/api/v1/oikos/status`, timeout).then(r => { live.economics = r.data }),
    ])

    // Extract structured metrics from the health response
    if (live.health) {
      const h = live.health
      const systems = h.systems || {}
      const synapse = systems.synapse || {}
      const thymos = systems.thymos || {}

      result.phase = h.phase || null
      result.instanceName = h.instance_name || null
      result.coherence = synapse.coherence_composite ?? null
      result.cycleCount = synapse.cycle_count ?? null
      result.rhythmState = synapse.rhythm_state || null
      result.activeIncidents = thymos.active_incidents ?? null
      result.healingMode = thymos.healing_mode || null
      result.systems = systems
    }

    // Attach enrichment data
    if (live.driveState) result.driveState = live.driveState
    if (live.incidents) result.incidents = live.incidents
    if (live.goals) result.goals = live.goals
    if (live.constitution) result.constitution = live.constitution
    if (live.benchmarks) result.benchmarks = live.benchmarks
    if (live.effectiveI) result.effectiveI = live.effectiveI
    if (live.economics) result.economics = live.economics

    // Log partial failures without blocking
    const failures = fetches.filter(f => f.status === 'rejected')
    if (failures.length > 0) {
      result.partialFailures = failures.length
      logger.debug('Organism metrics: some fetches failed', {
        failed: failures.length,
        total: fetches.length,
        errors: failures.slice(0, 3).map(f => f.reason?.message || 'unknown'),
      })
    }

    res.json(result)
  } catch (err) {
    next(err)
  }
})

module.exports = router
