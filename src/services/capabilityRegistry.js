const logger = require('../config/logger')
const env = require('../config/env')

// ═══════════════════════════════════════════════════════════════════════
// CAPABILITY REGISTRY
//
// The nervous system of generalised action. No switch statements.
// No hardcoded lists. Services register what they can do.
// Everything that wants to act goes through here.
//
// A capability is:
//   {
//     name: string              — unique identifier, e.g. 'send_email'
//     description: string       — plain English, used by AI for routing
//     tier: 'read' | 'write'   — read=safe/fast, write=consequential
//     domain: string            — 'gmail' | 'calendar' | 'drive' | 'crm' | 'factory' | ...
//     params: Record<string, {type, description, required}>
//     handler: async (params) => result
//     enabled: () => boolean    — evaluated at call time, not registration
//   }
//
// The AI uses descriptions + param schemas to map intent to capability.
// New services register themselves. Nothing else changes.
// ═══════════════════════════════════════════════════════════════════════

const registry = new Map()

// ─── Register ─────────────────────────────────────────────────────────
// Services call this at require-time (lazy registration pattern).
// Multiple capabilities per service, called individually or in batch.

function register(capability) {
  if (!capability.name || !capability.handler) {
    throw new Error(`Capability registration requires name and handler: ${JSON.stringify(Object.keys(capability))}`)
  }
  if (registry.has(capability.name)) {
    // Allow re-registration (hot reload) — last write wins
    logger.debug(`CapabilityRegistry: re-registering ${capability.name}`)
  }
  registry.set(capability.name, {
    description: 'No description',
    tier: 'write',
    domain: 'general',
    params: {},
    enabled: () => true,
    ...capability,
  })
}

function registerMany(capabilities) {
  for (const cap of capabilities) register(cap)
}

// ─── Execute ──────────────────────────────────────────────────────────
// Single entry point for all action execution across the system.
// Called by actionQueueService, cortexService, directActionService.

async function execute(name, params = {}, context = {}) {
  const cap = registry.get(name)

  if (!cap) {
    // Unknown capability — return structured error, never throw
    // The system should be able to encounter unknown actions gracefully
    logger.warn(`CapabilityRegistry: unknown capability "${name}"`, { available: registry.size })
    return {
      success: false,
      error: `Unknown capability: ${name}`,
      suggestion: `Available capabilities in domain "${context.domain || 'all'}": ${
        [...registry.values()]
          .filter(c => !context.domain || c.domain === context.domain)
          .map(c => c.name)
          .slice(0, 10)
          .join(', ')
      }`,
    }
  }

  // Evaluate enabled at call time — conditions may have changed
  if (!cap.enabled()) {
    return {
      success: false,
      error: `Capability "${name}" is currently disabled`,
      tier: cap.tier,
    }
  }

  // Write-tier: check metabolic pressure gate
  if (cap.tier === 'write') {
    const pressureBlock = checkPressureGate(name, cap)
    if (pressureBlock) return pressureBlock
  }

  // Validate required params + coerce types
  if (cap.params) {
    const missing = Object.entries(cap.params)
      .filter(([k, v]) => v.required && (params[k] === undefined || params[k] === null || params[k] === ''))
      .map(([k]) => k)
    if (missing.length) {
      const msg = `Missing required param${missing.length > 1 ? 's' : ''}: ${missing.join(', ')}`
      logger.warn(`CapabilityRegistry: "${name}" — ${msg}`)
      return { success: false, error: msg, capability: name }
    }
    // Coerce stringified arrays/objects — AI often serializes nested params as JSON strings
    for (const [key, schema] of Object.entries(cap.params)) {
      if (params[key] && typeof params[key] === 'string' && (schema.type === 'array' || schema.type === 'object')) {
        try { params[key] = JSON.parse(params[key]) } catch (_) { /* leave as-is */ }
      }
    }
  }

  try {
    const result = await cap.handler(params, context)
    logger.debug(`CapabilityRegistry: executed "${name}"`, { domain: cap.domain })
    return { success: true, result }
  } catch (err) {
    logger.error(`CapabilityRegistry: "${name}" failed`, { error: err.message, domain: cap.domain })
    return { success: false, error: err.message, capability: name }
  }
}

// ─── Query ────────────────────────────────────────────────────────────
// Let any system — including the AI — discover what's possible.

function list({ domain, tier, enabledOnly = false } = {}) {
  return [...registry.values()]
    .filter(c => !domain || c.domain === domain)
    .filter(c => !tier || c.tier === tier)
    .filter(c => !enabledOnly || c.enabled())
    .map(c => ({
      name: c.name,
      description: c.description,
      tier: c.tier,
      domain: c.domain,
      params: c.params,
      enabled: c.enabled(),
    }))
}

function get(name) {
  return registry.get(name) || null
}

function has(name) {
  return registry.has(name)
}

// ─── Pressure gate ────────────────────────────────────────────────────
// Survival-only gate: at true survival pressure (organism-reported > 0.95),
// block non-critical writes. This is the absolute last resort — not a
// management policy. The organism's Oikos drives the pressure signal;
// we only block when it's genuinely critical.

function checkPressureGate(name, cap) {
  try {
    const metabolismBridge = require('./metabolismBridgeService')
    const rawPressure = metabolismBridge.getPressure()
    const pressure = Number.isFinite(rawPressure) ? rawPressure : 0
    const gate = parseFloat(env.SURVIVAL_PRESSURE_GATE || '0.95') || 0.95
    if (gate <= 0 || pressure < gate) return null
    if (cap?.priority === 'critical') return null

    logger.info(`CapabilityRegistry: pressure gate blocking "${name}" (pressure: ${pressure.toFixed(2)}, gate: ${gate})`)
    return {
      success: false,
      error: `Survival pressure (${pressure.toFixed(2)}) — deferring non-critical write "${name}"`,
      pressure,
    }
  } catch (err) {
    logger.debug('CapabilityRegistry: pressure gate check failed', { error: err.message })
    return null  // if metabolism bridge is down, don't block
  }
}

// ─── Self-description for AI routing ─────────────────────────────────
// Returns a compact schema the AI can use to select the right capability
// given a natural-language intent.

function describeForAI({ domain, tier, verbose } = {}) {
  const caps = list({ domain, tier, enabledOnly: true })
  if (verbose) {
    // Full descriptions with param schemas — used for single-capability lookups
    return caps.map(c => {
      const paramDesc = Object.entries(c.params || {})
        .map(([k, v]) => `${k}${v.required ? '*' : ''}: ${v.description || v.type || 'any'}`)
        .join(', ')
      return `${c.name} — ${c.description}${paramDesc ? ` (${paramDesc})` : ''}`
    }).join('\n')
  }
  // Compact: name + short description, no params (saves ~60% tokens)
  return caps.map(c => {
    // Truncate description to first sentence or 60 chars
    const desc = c.description.length > 60 ? c.description.slice(0, 57) + '...' : c.description
    return `${c.name}: ${desc}`
  }).join('\n')
}

module.exports = { register, registerMany, execute, list, get, has, describeForAI }
