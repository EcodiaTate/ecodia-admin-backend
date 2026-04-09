const db = require('../config/db')
const logger = require('../config/logger')
const env = require('../config/env')

// ═══════════════════════════════════════════════════════════════════════
// DIRECT ACTION SERVICE — Organism Fast-Path
//
// The organism asks "what can you do?" — the system answers with the
// live capability registry. Not a hardcoded list. Everything registered.
//
// The organism executes an action — it goes through the capability registry.
// No switch statement. No static ACTIONS map. Full dynamic dispatch.
//
// ~2 seconds vs ~2-10 minutes through Factory.
//
// READ tier: always enabled — organism can always observe
// WRITE tier: env-gated, pressure-aware, rate-limited per capability
//
// Full audit trail in direct_actions table.
// ═══════════════════════════════════════════════════════════════════════

const READ_ENABLED = (env.DIRECT_ACTION_READ_ENABLED || 'true') === 'true'
const WRITE_ENABLED = (env.DIRECT_ACTION_WRITE_ENABLED || 'true') === 'true'

// Per-capability rate limiting — 1 hour sliding window
// Limit read from env as DA_RATE_<CAPABILITY_NAME_UPPER> (0 = unlimited)
const rateLimitWindows = new Map()
const RATE_WINDOW_MS = 60 * 60 * 1000

// Periodically evict empty/expired entries to prevent unbounded Map growth
setInterval(() => {
  const now = Date.now()
  for (const [key, timestamps] of rateLimitWindows) {
    const active = timestamps.filter(t => now - t < RATE_WINDOW_MS)
    if (active.length === 0) rateLimitWindows.delete(key)
    else rateLimitWindows.set(key, active)
  }
}, RATE_WINDOW_MS).unref()

function getRateLimit(capabilityName) {
  const envKey = `DA_RATE_${capabilityName.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`
  const val = parseInt(env[envKey] || '0', 10)
  return val > 0 ? val : Infinity
}

function isRateLimited(capabilityName) {
  const limit = getRateLimit(capabilityName)
  if (limit === Infinity) return false

  const now = Date.now()
  const timestamps = (rateLimitWindows.get(capabilityName) || []).filter(t => now - t < RATE_WINDOW_MS)
  rateLimitWindows.set(capabilityName, timestamps)

  if (timestamps.length >= limit) return true
  timestamps.push(now)
  return false
}

// ─── Execute ──────────────────────────────────────────────────────────

async function execute({ actionType, params = {}, correlationId, requestedBy = 'organism' }) {
  const registry = require('./capabilityRegistry')
  const cap = registry.get(actionType)

  if (!cap) {
    return {
      success: false,
      error: `Unknown action: ${actionType}`,
      available: registry.list({ enabledOnly: true }).map(c => ({ name: c.name, tier: c.tier, description: c.description })),
    }
  }

  // Tier gating
  if (cap.tier === 'read' && !READ_ENABLED) {
    return { success: false, error: 'Direct read actions are disabled' }
  }
  if (cap.tier === 'write' && !WRITE_ENABLED) {
    return { success: false, error: 'Direct write actions are disabled (DIRECT_ACTION_WRITE_ENABLED=false)' }
  }

  // Write-tier gates
  if (cap.tier === 'write') {
    const pressureBlock = checkPressureGate(actionType, cap)
    if (pressureBlock) return pressureBlock

    if (isRateLimited(actionType)) {
      const limit = getRateLimit(actionType)
      logger.warn(`DirectAction: rate-limited ${actionType}`, { correlationId, limit })
      return { success: false, error: `Rate limit reached for ${actionType}. Max ${limit} per hour.` }
    }
  }

  // Audit trail
  const [record] = await db`
    INSERT INTO direct_actions (action_type, params, status, requested_by, correlation_id)
    VALUES (${actionType}, ${JSON.stringify(params)}, 'executing', ${requestedBy}, ${correlationId || null})
    RETURNING id
  `

  const startTime = Date.now()

  try {
    // Execute via capability registry — single dispatch path
    const outcome = await registry.execute(actionType, params, {
      source: 'direct_action',
      requestedBy,
      correlationId,
    })

    const durationMs = Date.now() - startTime
    const result = outcome.result || {}

    await db`
      UPDATE direct_actions
      SET status = 'completed', result = ${JSON.stringify(result)},
          duration_ms = ${durationMs}, completed_at = now()
      WHERE id = ${record.id}
    `

    logger.info(`DirectAction: ${actionType} completed in ${durationMs}ms`, { correlationId })

    // KG learning + event bus
    const kgHooks = require('./kgIngestionHooks')
    kgHooks.onDirectAction({ actionType, params, result, status: 'completed', durationMs }).catch(() => {})

    try {
      const eventBus = require('./internalEventBusService')
      eventBus.emit('direct:action_complete', { actionType, status: 'completed', durationMs, correlationId })
    } catch {}

    return { success: true, result, durationMs }

  } catch (err) {
    const durationMs = Date.now() - startTime

    await db`
      UPDATE direct_actions
      SET status = 'failed', result = ${JSON.stringify({ error: err.message })},
          duration_ms = ${durationMs}, completed_at = now()
      WHERE id = ${record.id}
    `

    logger.warn(`DirectAction: ${actionType} failed`, { error: err.message, correlationId })
    return { success: false, error: err.message, durationMs }
  }
}

// ─── Pressure gate ────────────────────────────────────────────────────

function checkPressureGate(actionType, cap) {
  try {
    const pressure = 0 // metabolismBridge removed (organism decoupled)
    const gate = parseFloat(env.METABOLIC_PRESSURE_GATE || '0.85')
    if (gate <= 0 || pressure < gate) return null
    if (cap?.priority === 'critical') return null
    return {
      success: false,
      error: `Metabolic pressure ${pressure.toFixed(2)} too high for non-critical write "${actionType}"`,
      pressure,
    }
  } catch {
    return null
  }
}

// ─── Describe for Organism ────────────────────────────────────────────
// The organism asks what's available. We answer with the live registry.

function getAvailableActions() {
  const registry = require('./capabilityRegistry')
  return registry.list({ enabledOnly: true }).map(c => ({
    type: c.name,
    tier: c.tier,
    domain: c.domain,
    description: c.description,
    params: c.params,
    enabled: c.tier === 'read' ? READ_ENABLED : WRITE_ENABLED,
  }))
}

module.exports = { execute, getAvailableActions }
