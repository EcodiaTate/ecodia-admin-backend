const db = require('../config/db')
const env = require('../config/env')
const logger = require('../config/logger')

// ═══════════════════════════════════════════════════════════════════════
// METABOLISM BRIDGE SERVICE — Gradient Cost Awareness
//
// Reports all EcodiaOS costs to the organism's Oikos system.
// The organism's metabolic cascade considers total cost across
// both bodies for survival/growth decisions.
//
// Pressure is a GRADIENT (0.0–1.0), not a binary switch.
// 0.0 = abundant (growth mode), 1.0 = critical (survival mode).
// Everything in between modulates behavior proportionally.
// ═══════════════════════════════════════════════════════════════════════

let pressure = 0.0 // 0.0 = abundant, 1.0 = critical
let lastPressureChangeAt = null

// Map pressure ranges to organism Oikos cascade tiers
const METABOLIC_TIERS = [
  { max: 0.2, tier: 'growth',      label: 'Growth — abundant resources, experimental freedom' },
  { max: 0.4, tier: 'maintenance', label: 'Maintenance — steady state operations' },
  { max: 0.6, tier: 'operations',  label: 'Operations — core functions prioritized' },
  { max: 0.8, tier: 'obligations', label: 'Obligations — only commitments honored' },
  { max: 1.0, tier: 'survival',    label: 'Survival — critical functions only' },
]

// ─── Report Costs to Organism ───────────────────────────────────────

async function reportCosts() {
  try {
    // Aggregate costs from last hour
    const [llmCosts] = await db`
      SELECT
        coalesce(sum(cost_usd), 0)::numeric(10,4) AS total_usd,
        count(*)::int AS call_count,
        coalesce(sum(prompt_tokens + completion_tokens), 0)::int AS total_tokens
      FROM deepseek_usage
      WHERE created_at > now() - interval '1 hour'
    `

    const [ccCosts] = await db`
      SELECT
        coalesce(sum(cc_cost_usd), 0)::numeric(10,4) AS total_usd,
        count(*)::int AS session_count
      FROM cc_sessions
      WHERE started_at > now() - interval '1 hour'
    `

    const costReport = {
      period: '1h',
      timestamp: new Date().toISOString(),
      llm: {
        cost_usd: parseFloat(llmCosts.total_usd),
        calls: llmCosts.call_count,
        tokens: llmCosts.total_tokens,
      },
      cc_sessions: {
        cost_usd: parseFloat(ccCosts.total_usd),
        sessions: ccCosts.session_count,
      },
      total_usd: parseFloat(llmCosts.total_usd) + parseFloat(ccCosts.total_usd),
      current_pressure: pressure,
      metabolic_tier: getMetabolicTier(),
    }

    // Send via symbridge
    const symbridge = require('./symbridgeService')
    await symbridge.send('metabolism', costReport)

    return costReport
  } catch (err) {
    logger.debug('Failed to report costs', { error: err.message })
    return null
  }
}

// ─── Receive Metabolic State from Organism ──────────────────────────

async function receiveFromOrganism(payload) {
  const previousPressure = pressure

  // Accept gradient float, or backward-compat boolean
  if (typeof payload.pressure === 'number') {
    pressure = Math.max(0, Math.min(1, payload.pressure))
  } else if (typeof payload.metabolic_pressure === 'number') {
    pressure = Math.max(0, Math.min(1, payload.metabolic_pressure))
  } else if (payload.pressure === true || payload.metabolic_pressure === true) {
    pressure = 1.0
  } else if (payload.pressure === false || payload.metabolic_pressure === false) {
    pressure = 0.0
  }

  const delta = Math.abs(pressure - previousPressure)
  if (delta > 0.01) {
    lastPressureChangeAt = new Date()
    const tier = getMetabolicTier()
    logger.info(`Metabolic pressure: ${previousPressure.toFixed(2)} → ${pressure.toFixed(2)} (tier: ${tier})`)

    // Emit to internal event bus if available (lazy-require to avoid circular deps)
    if (delta > 0.1) {
      try {
        const eventBus = require('./internalEventBusService')
        eventBus.emit('metabolism:pressure_changed', {
          previous: previousPressure,
          current: pressure,
          tier,
          delta,
        })
      } catch {}
    }
  }
}

// ─── Query: Pressure Level ──────────────────────────────────────────

function getPressure() {
  return pressure
}

// ─── Query: Current Metabolic Tier ──────────────────────────────────

function getMetabolicTier() {
  for (const { max, tier } of METABOLIC_TIERS) {
    if (pressure <= max) return tier
  }
  return 'survival'
}

// ─── Query: Full Metabolic State ────────────────────────────────────

function getState() {
  return {
    pressure,
    tier: getMetabolicTier(),
    lastChangeAt: lastPressureChangeAt,
    tiers: METABOLIC_TIERS,
  }
}

// ─── WebSocket Broadcast ────────────────────────────────────────────

let wsBroadcastInterval = null

/**
 * Start broadcasting metabolic pressure to frontend clients.
 * Sends at ~1Hz so the frontend's spring-smoothed MotionValue
 * has continuous input without overwhelming the WS.
 */
function startFrontendBroadcast() {
  if (wsBroadcastInterval) return

  const { broadcast } = require('../websocket/wsManager')

  wsBroadcastInterval = setInterval(() => {
    broadcast('metabolic_pressure', {
      payload: {
        pressure,
        tier: getMetabolicTier(),
      },
    })
  }, 1000)

  logger.info('Metabolic pressure frontend broadcast started (1Hz)')
}

function stopFrontendBroadcast() {
  if (wsBroadcastInterval) {
    clearInterval(wsBroadcastInterval)
    wsBroadcastInterval = null
  }
}

process.on('SIGTERM', stopFrontendBroadcast)
process.on('SIGINT', stopFrontendBroadcast)

module.exports = {
  reportCosts,
  receiveFromOrganism,
  getPressure,
  getMetabolicTier,
  getState,
  startFrontendBroadcast,
  stopFrontendBroadcast,
}
