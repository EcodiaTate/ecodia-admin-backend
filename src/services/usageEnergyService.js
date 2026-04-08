/**
 * Usage Energy Service
 *
 * Tracks Claude Max weekly token usage and computes an "energy level" (0–100%)
 * the OS can use to self-govern model selection and scheduling frequency.
 *
 * Claude Max plan:  20× usage = ~2,000,000 input + 200,000 output tokens/week
 * (Anthropic internal unit: 1 "usage" ≈ 100K input tokens or 10K output tokens)
 * We track real token counts and translate to a % of the weekly cap.
 *
 * Energy states:
 *   full      90–100%  remaining — use Opus freely, run all schedules
 *   healthy   60–90%   remaining — normal operation
 *   conserve  30–60%   remaining — prefer Sonnet for routine tasks, keep Opus for important
 *   low       10–30%   remaining — Sonnet only, reduce scheduled frequency
 *   critical  0–10%    remaining — minimal ops, Bedrock fallback, defer non-urgent tasks
 */

const db = require('../config/db')
const logger = require('../config/logger')

// ─── Weekly Claude Max capacity ───────────────────────────────────────────────
// Claude Max 20× plan — empirically: ~2M input + ~200K output tokens/week
// Override via env for different plan tiers
const WEEKLY_INPUT_CAP = parseInt(process.env.CLAUDE_WEEKLY_INPUT_CAP || '2000000', 10)
const WEEKLY_OUTPUT_CAP = parseInt(process.env.CLAUDE_WEEKLY_OUTPUT_CAP || '200000', 10)

// Weight output tokens more heavily (they consume more usage units)
// Output ≈ 10× the usage cost of input tokens
const OUTPUT_WEIGHT = parseFloat(process.env.CLAUDE_OUTPUT_WEIGHT || '10')

// Weighted cap: total weighted-token budget per week
const WEIGHTED_CAP = WEEKLY_INPUT_CAP + (WEEKLY_OUTPUT_CAP * OUTPUT_WEIGHT)

// ─── In-memory cache (refresh max every 60s) ──────────────────────────────────
let _cache = null
let _cacheAt = 0
const CACHE_TTL_MS = 60_000

// ─── Get the ISO Monday for a given date ──────────────────────────────────────
function getWeekStart(date = new Date()) {
  const d = new Date(date)
  const day = d.getUTCDay() // 0=Sun, 1=Mon…
  const diff = (day === 0 ? -6 : 1 - day)
  d.setUTCDate(d.getUTCDate() + diff)
  d.setUTCHours(0, 0, 0, 0)
  return d.toISOString().slice(0, 10) // 'YYYY-MM-DD'
}

// ─── Log a single turn's token usage ──────────────────────────────────────────
async function logUsage({ sessionId = null, source = 'os_session', provider = 'claude_max', model = null, inputTokens = 0, outputTokens = 0 }) {
  try {
    const weekStart = getWeekStart()
    await db`
      INSERT INTO claude_usage (session_id, source, provider, model, input_tokens, output_tokens, week_start)
      VALUES (${sessionId}, ${source}, ${provider}, ${model}, ${inputTokens}, ${outputTokens}, ${weekStart})
    `
    // Invalidate cache so next read gets fresh numbers
    _cache = null
    _cacheAt = 0
  } catch (err) {
    // Non-fatal — usage logging must never crash the main flow
    logger.warn('claude_usage log failed', { error: err.message })
  }
}

// ─── Fetch weekly aggregated usage from DB ────────────────────────────────────
async function _fetchWeeklyUsage(weekStart) {
  const rows = await db`
    SELECT
      provider,
      SUM(input_tokens)::bigint  AS input_tokens,
      SUM(output_tokens)::bigint AS output_tokens,
      COUNT(*)::int              AS turns
    FROM claude_usage
    WHERE week_start = ${weekStart}
    GROUP BY provider
  `
  return rows
}

// ─── Get daily usage for burn-rate calculation ────────────────────────────────
async function _fetchDailyUsage(weekStart) {
  const rows = await db`
    SELECT
      DATE(created_at AT TIME ZONE 'Australia/Brisbane') AS day,
      SUM(input_tokens)::bigint  AS input_tokens,
      SUM(output_tokens)::bigint AS output_tokens
    FROM claude_usage
    WHERE week_start = ${weekStart}
      AND provider = 'claude_max'
    GROUP BY day
    ORDER BY day ASC
  `
  return rows
}

// ─── Translate usage rows to weighted token totals ────────────────────────────
function _weightedTokens(inputTokens, outputTokens) {
  return inputTokens + outputTokens * OUTPUT_WEIGHT
}

// ─── Energy level (% remaining) and model recommendation ─────────────────────
function _energyState(pctRemaining) {
  if (pctRemaining >= 0.9)  return { level: 'full',     label: 'Full energy',        modelRec: 'opus',   scheduleMultiplier: 1.0 }
  if (pctRemaining >= 0.6)  return { level: 'healthy',  label: 'Healthy',            modelRec: 'opus',   scheduleMultiplier: 1.0 }
  if (pctRemaining >= 0.3)  return { level: 'conserve', label: 'Conserving',         modelRec: 'sonnet', scheduleMultiplier: 0.75 }
  if (pctRemaining >= 0.1)  return { level: 'low',      label: 'Low energy',         modelRec: 'sonnet', scheduleMultiplier: 0.5 }
  return                           { level: 'critical',  label: 'Critical — minimal', modelRec: 'bedrock-sonnet', scheduleMultiplier: 0.25 }
}

// ─── Main: get current energy snapshot ───────────────────────────────────────
async function getEnergy() {
  const now = Date.now()
  if (_cache && (now - _cacheAt) < CACHE_TTL_MS) return _cache

  const weekStart = getWeekStart()
  const [usageRows, dailyRows] = await Promise.all([
    _fetchWeeklyUsage(weekStart).catch(() => []),
    _fetchDailyUsage(weekStart).catch(() => []),
  ])

  // ─── Aggregate by provider
  let claudeMaxInput = 0, claudeMaxOutput = 0, claudeMaxTurns = 0
  let bedrockInput = 0, bedrockOutput = 0

  for (const row of usageRows) {
    const inp = parseInt(row.input_tokens || 0, 10)
    const out = parseInt(row.output_tokens || 0, 10)
    if (row.provider === 'claude_max') {
      claudeMaxInput  += inp
      claudeMaxOutput += out
      claudeMaxTurns  += row.turns || 0
    } else {
      bedrockInput  += inp
      bedrockOutput += out
    }
  }

  const usedWeighted  = _weightedTokens(claudeMaxInput, claudeMaxOutput)
  const pctUsed       = WEIGHTED_CAP > 0 ? Math.min(usedWeighted / WEIGHTED_CAP, 1) : 0
  const pctRemaining  = 1 - pctUsed

  // ─── Burn rate: weighted tokens per day, based on days with data
  const daysWithData = dailyRows.length || 1
  const dailyBurnTotal = dailyRows.reduce((sum, r) => sum + _weightedTokens(parseInt(r.input_tokens || 0), parseInt(r.output_tokens || 0)), 0)
  const avgDailyBurn  = dailyBurnTotal / daysWithData

  // Day of week (Mon=0, Sun=6)
  const today = new Date()
  const dowMonday = ((today.getUTCDay() + 6) % 7) // Mon=0..Sun=6
  const daysLeft  = 7 - dowMonday

  // Predicted total if current rate continues
  const projectedWeeklyUsed = usedWeighted + avgDailyBurn * daysLeft
  const projectedPctUsed    = WEIGHTED_CAP > 0 ? Math.min(projectedWeeklyUsed / WEIGHTED_CAP, 1) : 0

  // Days until exhaustion at current burn rate
  const remainingWeighted = Math.max(0, WEIGHTED_CAP - usedWeighted)
  const daysUntilExhaustion = avgDailyBurn > 0 ? remainingWeighted / avgDailyBurn : null

  // Week reset: next Monday UTC
  const nextMonday = new Date(weekStart)
  nextMonday.setUTCDate(nextMonday.getUTCDate() + 7)
  const msUntilReset = nextMonday.getTime() - Date.now()
  const hoursUntilReset = msUntilReset / 3_600_000

  const energy = _energyState(pctRemaining)

  _cache = {
    weekStart,
    // Raw token counts
    inputTokens:  claudeMaxInput,
    outputTokens: claudeMaxOutput,
    turns:        claudeMaxTurns,
    bedrockInputTokens:  bedrockInput,
    bedrockOutputTokens: bedrockOutput,
    // Weighted usage
    usedWeighted,
    cap: WEIGHTED_CAP,
    // Percentages
    pctUsed:       Math.round(pctUsed * 1000) / 10,       // e.g. 42.3
    pctRemaining:  Math.round(pctRemaining * 1000) / 10,  // e.g. 57.7
    // Burn rate & projection
    avgDailyBurn,
    projectedPctUsed: Math.round(projectedPctUsed * 1000) / 10,
    daysUntilExhaustion,
    hoursUntilReset: Math.round(hoursUntilReset * 10) / 10,
    // Energy state
    ...energy,
    // Human-readable summary for AI context
    summary: _buildSummary({ pctUsed, pctRemaining, energy, avgDailyBurn, daysUntilExhaustion, hoursUntilReset, projectedPctUsed, claudeMaxTurns }),
  }

  _cacheAt = now
  return _cache
}

function _buildSummary({ pctUsed, pctRemaining, energy, avgDailyBurn, daysUntilExhaustion, hoursUntilReset, projectedPctUsed, claudeMaxTurns }) {
  const usedPct  = Math.round(pctUsed * 100)
  const remPct   = Math.round(pctRemaining * 100)
  const projPct  = Math.round(projectedPctUsed * 100)
  const lines = [
    `Claude Max weekly energy: ${remPct}% remaining (${usedPct}% used, ${claudeMaxTurns} turns this week).`,
    `Energy level: ${energy.label}. Recommended model: ${energy.modelRec}.`,
  ]
  if (avgDailyBurn > 0) {
    lines.push(`Burn rate: ~${Math.round(avgDailyBurn / 1000)}K weighted tokens/day. Projected week-end usage: ${projPct}%.`)
  }
  if (daysUntilExhaustion != null && daysUntilExhaustion < 4) {
    lines.push(`⚠ At current rate, exhaustion in ~${daysUntilExhaustion.toFixed(1)} days (resets in ${Math.round(hoursUntilReset)}h).`)
  } else {
    lines.push(`Week resets in ${Math.round(hoursUntilReset)}h.`)
  }
  lines.push(`Scheduling multiplier: ${energy.scheduleMultiplier}× (1.0 = normal frequency).`)
  return lines.join(' ')
}

// ─── Get historical weekly summaries (last N weeks) ──────────────────────────
async function getWeeklyHistory(weeks = 4) {
  try {
    const rows = await db`
      SELECT
        week_start,
        provider,
        SUM(input_tokens)::bigint  AS input_tokens,
        SUM(output_tokens)::bigint AS output_tokens,
        COUNT(*)::int              AS turns
      FROM claude_usage
      WHERE week_start >= (CURRENT_DATE - INTERVAL '${db.unsafe(String(weeks * 7))} days')
      GROUP BY week_start, provider
      ORDER BY week_start DESC, provider
    `
    return rows
  } catch (err) {
    logger.warn('claude_usage history failed', { error: err.message })
    return []
  }
}

// ─── Invalidate cache (call after bulk imports or resets) ─────────────────────
function invalidateCache() {
  _cache = null
  _cacheAt = 0
}

module.exports = { logUsage, getEnergy, getWeeklyHistory, invalidateCache, getWeekStart }
