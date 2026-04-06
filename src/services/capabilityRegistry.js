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
const failedDomains = new Set()   // domains that threw during bootstrap
let _recoveryAttempted = false     // prevent infinite reload loops

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
    // Attempt auto-recovery: reload capability domains if registry looks incomplete
    const recovered = attemptRecovery(name)
    if (recovered) {
      // Re-fetch after recovery
      return execute(name, params, context)
    }

    // Fuzzy match — find the closest registered capability name
    const closest = findClosestCapability(name)
    const domainCaps = [...registry.values()]
      .filter(c => !context.domain || c.domain === context.domain)
      .map(c => c.name)

    logger.warn(`CapabilityRegistry: unknown capability "${name}"`, {
      available: registry.size,
      closestMatch: closest?.name || null,
      closestScore: closest?.score || 0,
      failedDomains: failedDomains.size > 0 ? [...failedDomains] : undefined,
    })

    return {
      success: false,
      error: `Unknown capability: ${name}`,
      closestMatch: closest?.name || null,
      suggestion: closest && closest.score > 0.6
        ? `Did you mean "${closest.name}"? (${closest.domain} domain)`
        : `Available in "${context.domain || 'all'}": ${domainCaps.slice(0, 10).join(', ')}`,
      failedDomains: failedDomains.size > 0 ? [...failedDomains] : undefined,
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

// ─── Fuzzy matching ───────────────────────────────────────────────────
// When an unknown capability is requested, find the closest registered name.
// Uses bigram similarity (Dice coefficient) — fast, no dependencies.

function bigrams(str) {
  const s = str.toLowerCase()
  const pairs = []
  for (let i = 0; i < s.length - 1; i++) pairs.push(s.slice(i, i + 2))
  return pairs
}

function diceCoefficient(a, b) {
  const biA = bigrams(a)
  const biB = bigrams(b)
  if (biA.length === 0 && biB.length === 0) return 1
  if (biA.length === 0 || biB.length === 0) return 0
  const setB = new Set(biB)
  let intersection = 0
  for (const bi of biA) { if (setB.has(bi)) intersection++ }
  return (2 * intersection) / (biA.length + biB.length)
}

function findClosestCapability(name) {
  let best = null
  let bestScore = 0
  for (const [capName, cap] of registry) {
    const score = diceCoefficient(name, capName)
    if (score > bestScore) {
      bestScore = score
      best = { name: capName, domain: cap.domain, score }
    }
  }
  return bestScore > 0.4 ? best : null
}

// ─── Auto-recovery ────────────────────────────────────────────────────
// If an unknown capability is requested and we have failed domains,
// attempt to reload capabilities once. Handles transient boot failures.

function attemptRecovery(name) {
  // Always allow recovery when registry is completely empty — the one-shot flag
  // should only gate failed-domain retries, not boot-race recovery
  if (_recoveryAttempted && registry.size > 0) return false
  _recoveryAttempted = true

  // Two recovery paths:
  // 1. Failed domains — specific domains threw during bootstrap
  // 2. Empty registry — capabilities/index hasn't been required yet (boot race)
  if (failedDomains.size === 0 && registry.size === 0) {
    logger.info(`CapabilityRegistry: registry empty — loading capabilities/index for "${name}"`)
    try {
      require('../capabilities/index')
    } catch (err) {
      logger.warn(`CapabilityRegistry: full bootstrap recovery failed`, { error: err.message })
    }
  } else if (failedDomains.size > 0) {
    logger.info(`CapabilityRegistry: attempting recovery for "${name}" (${failedDomains.size} failed domains: ${[...failedDomains].join(', ')})`)
    const recovered = []
    for (const domain of [...failedDomains]) {
      try {
        require(`../capabilities/${domain}`)
        failedDomains.delete(domain)
        recovered.push(domain)
      } catch (err) {
        logger.warn(`CapabilityRegistry: recovery failed for ${domain}`, { error: err.message })
      }
    }
    if (recovered.length > 0) {
      logger.info(`CapabilityRegistry: recovered ${recovered.join(', ')} — registry now has ${registry.size} capabilities`)
    }
  }

  // Reset recovery flag after 60s so we can retry later if needed
  setTimeout(() => { _recoveryAttempted = false }, 60_000)
  return registry.has(name)
}

function recordFailedDomain(domain) {
  failedDomains.add(domain)
}

function getFailedDomains() {
  return [...failedDomains]
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

module.exports = { register, registerMany, execute, list, get, has, describeForAI, recordFailedDomain, getFailedDomains }
