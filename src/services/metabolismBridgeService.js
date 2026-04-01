const db = require('../config/db')
const env = require('../config/env')
const logger = require('../config/logger')

// ═══════════════════════════════════════════════════════════════════════
// METABOLISM BRIDGE SERVICE — Unified Cost Awareness
//
// Reports all EcodiaOS costs to the organism's Oikos system.
// The organism's metabolic cascade considers total cost across
// both bodies for survival/growth decisions.
// ═══════════════════════════════════════════════════════════════════════

let metabolicPressure = false // set by organism when under pressure

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
      metabolic_pressure: metabolicPressure,
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
  const previousPressure = metabolicPressure
  metabolicPressure = payload.pressure === true || payload.metabolic_pressure === true

  if (metabolicPressure && !previousPressure) {
    logger.warn('Metabolic pressure activated — reducing non-essential operations')
  } else if (!metabolicPressure && previousPressure) {
    logger.info('Metabolic pressure released — resuming normal operations')
  }
}

// ─── Query: Is Under Pressure? ──────────────────────────────────────

function isUnderPressure() {
  return metabolicPressure
}

module.exports = {
  reportCosts,
  receiveFromOrganism,
  isUnderPressure,
}
