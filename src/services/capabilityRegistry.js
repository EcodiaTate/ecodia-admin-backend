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
    const pressureBlock = checkPressureGate(name)
    if (pressureBlock) return pressureBlock
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
// Generalised: high-priority write capabilities pass at any pressure.
// Non-critical writes are blocked above 0.85.
// The capability itself declares its priority.

function checkPressureGate(name) {
  try {
    const metabolismBridge = require('./metabolismBridgeService')
    const pressure = metabolismBridge.getPressure()
    if (pressure < 0.85) return null

    const cap = registry.get(name)
    if (cap?.priority === 'critical') return null  // critical caps always pass

    return {
      success: false,
      error: `Metabolic pressure too high (${pressure.toFixed(2)}) for non-critical write action "${name}"`,
      pressure,
    }
  } catch {
    return null  // if metabolism bridge is down, don't block
  }
}

// ─── Self-description for AI routing ─────────────────────────────────
// Returns a compact schema the AI can use to select the right capability
// given a natural-language intent.

function describeForAI({ domain, tier } = {}) {
  const caps = list({ domain, tier, enabledOnly: true })
  return caps.map(c => {
    const paramDesc = Object.entries(c.params || {})
      .map(([k, v]) => `${k}${v.required ? '*' : ''}: ${v.description || v.type || 'any'}`)
      .join(', ')
    return `${c.name} — ${c.description}${paramDesc ? ` (${paramDesc})` : ''}`
  }).join('\n')
}

module.exports = { register, registerMany, execute, list, get, has, describeForAI }
