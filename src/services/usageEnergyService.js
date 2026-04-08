/**
 * Usage Energy Service
 *
 * Gets REAL weekly Claude Max usage % from Anthropic's response headers.
 *
 * How it works:
 *   Every /v1/messages response from Anthropic includes:
 *     anthropic-ratelimit-unified-7d-utilization  — float 0–1 (real weekly % used)
 *     anthropic-ratelimit-unified-7d-reset        — Unix timestamp of next reset
 *     anthropic-ratelimit-unified-5h-utilization  — 5-hour session utilization
 *     anthropic-ratelimit-unified-status          — allowed | allowed_warning | rejected
 *
 *   We capture these headers in two ways:
 *   1. Passively: from every OS session turn (osSessionService calls updateFromHeaders())
 *   2. Actively: a lightweight quota-check call (1-token message) when headers go stale
 *
 *   This is exactly what `claude /usage` does — same headers, same data source.
 *
 * Energy states (derived from real utilization):
 *   full      0–10%  used  — opus freely, all schedules
 *   healthy  10–40%  used  — normal
 *   conserve 40–70%  used  — prefer sonnet for routine, opus for important
 *   low      70–90%  used  — sonnet only, reduce schedule frequency
 *   critical 90–100% used  — minimal ops, bedrock fallback, defer non-urgent
 */

const fs = require('fs')
const path = require('path')
const logger = require('../config/logger')
const db = require('../config/db')

// ─── In-memory state — updated from headers on every API call ─────────────────
let _state = {
  // From Anthropic headers (real data)
  weeklyUtilization: null,    // 0–1 float from anthropic-ratelimit-unified-7d-utilization
  weeklyResetsAt: null,       // Unix seconds from anthropic-ratelimit-unified-7d-reset
  sessionUtilization: null,   // 0–1 float from anthropic-ratelimit-unified-5h-utilization
  sessionResetsAt: null,      // Unix seconds
  rateLimitStatus: 'allowed', // allowed | allowed_warning | rejected
  rateLimitType: null,        // seven_day | five_hour | overage | etc.
  isUsingOverage: false,
  headersUpdatedAt: null,     // Date.now() when headers were last captured
}

// Cache the full energy snapshot (60s TTL)
let _cache = null
let _cacheAt = 0
const CACHE_TTL_MS = 60_000

// How long before we proactively refresh via quota-check (15 min)
const HEADER_STALE_MS = 15 * 60 * 1000

// ─── Update state from real Anthropic response headers ────────────────────────
// Call this from osSessionService whenever we get a response.
// headers can be a Headers object, a plain object, or a Map — we normalise via .get()
function updateFromHeaders(headers) {
  try {
    const get = (k) => {
      if (typeof headers.get === 'function') return headers.get(k)
      if (typeof headers === 'object') return headers[k] ?? headers[k.toLowerCase()] ?? null
      return null
    }

    const weeklyUtil  = get('anthropic-ratelimit-unified-7d-utilization')
    const weeklyReset = get('anthropic-ratelimit-unified-7d-reset')
    const sessionUtil  = get('anthropic-ratelimit-unified-5h-utilization')
    const sessionReset = get('anthropic-ratelimit-unified-5h-reset')
    const status       = get('anthropic-ratelimit-unified-status')
    const claim        = get('anthropic-ratelimit-unified-representative-claim')
    const overageStatus = get('anthropic-ratelimit-unified-overage-status')

    if (weeklyUtil !== null && weeklyUtil !== undefined) {
      _state.weeklyUtilization = Number(weeklyUtil)
      _state.headersUpdatedAt  = Date.now()
      // Invalidate snapshot cache so next read gets fresh energy
      _cache = null
      _cacheAt = 0
    }
    if (weeklyReset !== null && weeklyReset !== undefined) {
      _state.weeklyResetsAt = Number(weeklyReset)
    }
    if (sessionUtil !== null && sessionUtil !== undefined) {
      _state.sessionUtilization = Number(sessionUtil)
    }
    if (sessionReset !== null && sessionReset !== undefined) {
      _state.sessionResetsAt = Number(sessionReset)
    }
    if (status) _state.rateLimitStatus = status
    if (claim)  _state.rateLimitType   = claim
    _state.isUsingOverage = overageStatus === 'allowed' || overageStatus === 'allowed_warning'

    logger.debug('Claude usage headers captured', {
      weeklyUtil: _state.weeklyUtilization,
      status: _state.rateLimitStatus,
    })
  } catch (err) {
    logger.debug('updateFromHeaders failed', { error: err.message })
  }
}

// ─── Quota-check: fire a minimal 1-token API call just to read headers ────────
// Mimics what `claude /usage` does internally.
// Uses ~/.claude.json OAuth credentials (same as the OS session).
let _quotaCheckInFlight = null

async function _doQuotaCheck() {
  try {
    // Load OAuth token from ~/.claude.json
    const claudeConfigPath = path.join(process.env.HOME || process.env.USERPROFILE || '', '.claude.json')
    if (!fs.existsSync(claudeConfigPath)) {
      logger.debug('quota-check: ~/.claude.json not found, skipping')
      return
    }
    const claudeConfig = JSON.parse(fs.readFileSync(claudeConfigPath, 'utf8'))
    const oauthToken = claudeConfig?.oauthAccount?.accessToken

    if (!oauthToken) {
      logger.debug('quota-check: no OAuth token in ~/.claude.json, skipping')
      return
    }

    const model = process.env.OS_SESSION_MODEL || 'claude-opus-4-5-20250514'

    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${oauthToken}`,
        'Content-Type': 'application/json',
        'anthropic-version': '2023-06-01',
        'anthropic-beta': 'interleaved-thinking-2025-05-14',
      },
      body: JSON.stringify({
        model,
        max_tokens: 1,
        messages: [{ role: 'user', content: 'quota' }],
      }),
    })

    // Extract headers regardless of status code
    updateFromHeaders(resp.headers)

    logger.info('Claude quota-check complete', {
      status: resp.status,
      weeklyUtil: _state.weeklyUtilization,
    })
  } catch (err) {
    logger.debug('quota-check failed', { error: err.message })
  } finally {
    _quotaCheckInFlight = null
  }
}

async function refreshQuotaCheck() {
  if (_quotaCheckInFlight) return _quotaCheckInFlight
  _quotaCheckInFlight = _doQuotaCheck()
  return _quotaCheckInFlight
}

// ─── Energy state from real utilization ───────────────────────────────────────
function _energyState(pctUsed) {
  if (pctUsed <= 0.10) return { level: 'full',     label: 'Full energy',        modelRec: 'opus',           scheduleMultiplier: 1.0 }
  if (pctUsed <= 0.40) return { level: 'healthy',  label: 'Healthy',            modelRec: 'opus',           scheduleMultiplier: 1.0 }
  if (pctUsed <= 0.70) return { level: 'conserve', label: 'Conserving',         modelRec: 'sonnet',         scheduleMultiplier: 0.75 }
  if (pctUsed <= 0.90) return { level: 'low',      label: 'Low energy',         modelRec: 'sonnet',         scheduleMultiplier: 0.5 }
  return                      { level: 'critical',  label: 'Critical — minimal', modelRec: 'bedrock-sonnet', scheduleMultiplier: 0.25 }
}

// ─── Get current energy snapshot ──────────────────────────────────────────────
async function getEnergy() {
  const now = Date.now()

  // Return cached snapshot if fresh
  if (_cache && (now - _cacheAt) < CACHE_TTL_MS) return _cache

  // Trigger a background quota-check if headers are stale or missing
  const headerAge = _state.headersUpdatedAt ? (now - _state.headersUpdatedAt) : Infinity
  if (headerAge > HEADER_STALE_MS) {
    // Fire in background — don't await, current call uses whatever we have
    refreshQuotaCheck().catch(() => {})
  }

  const pctUsed      = _state.weeklyUtilization ?? 0
  const pctRemaining = Math.max(0, 1 - pctUsed)
  const energy       = _energyState(pctUsed)

  // Time until reset
  let hoursUntilReset = null
  if (_state.weeklyResetsAt) {
    hoursUntilReset = Math.max(0, (_state.weeklyResetsAt * 1000 - now) / 3_600_000)
  }

  // Session utilization
  const sessionPctUsed = _state.sessionUtilization ?? null

  // Self-tracked turn count (from our own DB log — useful for activity, not for % calc)
  const selfTracked = await _getSelfTrackedTurns().catch(() => ({ turns: 0 }))

  const hasRealData = _state.weeklyUtilization !== null

  _cache = {
    // ─── Real data from Anthropic headers
    source: hasRealData ? 'anthropic_headers' : 'no_data',
    headersAge: _state.headersUpdatedAt ? Math.round((now - _state.headersUpdatedAt) / 1000) : null,
    pctUsed:       Math.round(pctUsed * 1000) / 10,       // e.g. 42.3
    pctRemaining:  Math.round(pctRemaining * 1000) / 10,  // e.g. 57.7
    rateLimitStatus: _state.rateLimitStatus,
    rateLimitType:   _state.rateLimitType,
    isUsingOverage:  _state.isUsingOverage,
    hoursUntilReset: hoursUntilReset != null ? Math.round(hoursUntilReset * 10) / 10 : null,
    sessionPctUsed: sessionPctUsed != null ? Math.round(sessionPctUsed * 1000) / 10 : null,
    // ─── Energy decision layer
    ...energy,
    // ─── Self-tracked activity (supplementary)
    turnsThisWeek: selfTracked.turns,
    // ─── Human-readable summary for AI context
    summary: _buildSummary({ pctUsed, pctRemaining, energy, hoursUntilReset, sessionPctUsed, hasRealData, turns: selfTracked.turns }),
  }

  _cacheAt = now
  return _cache
}

async function _getSelfTrackedTurns() {
  try {
    const weekStart = _getWeekStart()
    const [row] = await db`
      SELECT COUNT(*)::int AS turns
      FROM claude_usage
      WHERE week_start = ${weekStart} AND provider = 'claude_max'
    `
    return { turns: row?.turns || 0 }
  } catch {
    return { turns: 0 }
  }
}

function _getWeekStart(date = new Date()) {
  const d = new Date(date)
  const day = d.getUTCDay()
  const diff = (day === 0 ? -6 : 1 - day)
  d.setUTCDate(d.getUTCDate() + diff)
  d.setUTCHours(0, 0, 0, 0)
  return d.toISOString().slice(0, 10)
}

function _buildSummary({ pctUsed, pctRemaining, energy, hoursUntilReset, sessionPctUsed, hasRealData, turns }) {
  const usedPct = Math.round(pctUsed * 100)
  const remPct  = Math.round(pctRemaining * 100)

  if (!hasRealData) {
    return `Claude Max weekly energy: unknown (no API response headers captured yet). Energy level: ${energy.label}. Recommended model: ${energy.modelRec}.`
  }

  const lines = [
    `Claude Max weekly energy: ${remPct}% remaining (${usedPct}% used${turns > 0 ? `, ${turns} turns tracked` : ''}).`,
    `Energy level: ${energy.label}. Recommended model: ${energy.modelRec}.`,
  ]
  if (sessionPctUsed != null) {
    lines.push(`5-hour session: ${Math.round(sessionPctUsed)}% used.`)
  }
  if (hoursUntilReset != null) {
    lines.push(`Week resets in ${Math.round(hoursUntilReset)}h.`)
  }
  if (_state.isUsingOverage) {
    lines.push('Currently using extra usage (overage).')
  }
  lines.push(`Scheduling multiplier: ${energy.scheduleMultiplier}× (1.0 = normal frequency).`)
  return lines.join(' ')
}

// ─── Log a turn to our DB (for activity tracking / history) ──────────────────
async function logUsage({ sessionId = null, source = 'os_session', provider = 'claude_max', model = null, inputTokens = 0, outputTokens = 0 }) {
  try {
    const weekStart = _getWeekStart()
    await db`
      INSERT INTO claude_usage (session_id, source, provider, model, input_tokens, output_tokens, week_start)
      VALUES (${sessionId}, ${source}, ${provider}, ${model}, ${inputTokens}, ${outputTokens}, ${weekStart})
    `
    _cache = null
    _cacheAt = 0
  } catch (err) {
    logger.warn('claude_usage log failed', { error: err.message })
  }
}

// ─── Get historical weekly summaries ─────────────────────────────────────────
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

function invalidateCache() {
  _cache = null
  _cacheAt = 0
}

module.exports = {
  updateFromHeaders,
  refreshQuotaCheck,
  logUsage,
  getEnergy,
  getWeeklyHistory,
  invalidateCache,
  getWeekStart: _getWeekStart,
}
