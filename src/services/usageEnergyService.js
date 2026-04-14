/**
 * Usage Energy Service — Dual-Account + Bedrock Fallback
 *
 * Tracks BOTH Claude Max accounts independently and picks the healthiest one.
 * Falls back to Bedrock when both Max accounts are exhausted.
 *
 * How it works:
 *   Every /v1/messages response from Anthropic includes:
 *     anthropic-ratelimit-unified-7d-utilization  — float 0–1 (real weekly % used)
 *     anthropic-ratelimit-unified-7d-reset        — Unix timestamp of next reset
 *     anthropic-ratelimit-unified-5h-utilization  — 5-hour session utilization
 *     anthropic-ratelimit-unified-5h-reset        — Unix seconds when 5h window resets
 *     anthropic-ratelimit-unified-status          — allowed | allowed_warning | rejected
 *
 *   We probe BOTH accounts via lightweight 1-token quota-checks (independent timers).
 *   This lets us always know which account has more headroom — weekly AND 5h session.
 *
 * Provider priority:
 *   1. Healthiest Claude Max account (whichever has lower utilization)
 *   2. The other Claude Max account (if first is capped)
 *   3. Bedrock Opus (final fallback when both Max accounts are exhausted)
 *
 * Energy states (derived from real utilization):
 *   full      0–10%  used  — opus freely, all schedules
 *   healthy  10–40%  used  — normal
 *   conserve 40–70%  used  — prefer sonnet for routine, opus for important
 *   low      70–90%  used  — sonnet only, reduce schedule frequency
 *   critical 90–100% used  — minimal ops, defer non-urgent, wait for weekly reset
 */

const fs = require('fs')
const path = require('path')
const logger = require('../config/logger')
const db = require('../config/db')

// ─── Per-account state ──────────────────────────────────────────────────────
// Each account has its own independent utilization tracking.
function _makeAccountState() {
  return {
    weeklyUtilization: null,     // 0–1 float
    weeklyResetsAt: null,        // Unix seconds
    sessionUtilization: null,    // 0–1 float (5h window)
    sessionResetsAt: null,       // Unix seconds
    rateLimitStatus: 'allowed',  // allowed | allowed_warning | rejected
    rateLimitType: null,         // seven_day | five_hour | overage | etc.
    isUsingOverage: false,
    headersUpdatedAt: null,      // Date.now() when headers were last captured
    quotaCheckInFlight: null,    // promise if a quota-check is running
  }
}

const _accounts = {
  claude_max:   _makeAccountState(),
  claude_max_2: _makeAccountState(),
}

// Which provider is currently active (set by osSessionService)
let _activeProvider = 'claude_max'

// Cache the full energy snapshot (60s TTL)
let _cache = null
let _cacheAt = 0
const CACHE_TTL_MS = 60_000

// How long before we proactively refresh via quota-check (10 min — tighter than before)
const HEADER_STALE_MS = 10 * 60 * 1000

// ─── Called by osSessionService to keep active provider in sync ──────────────
function setProvider(provider) {
  if (_activeProvider !== provider) {
    _activeProvider = provider
    _cache = null
    _cacheAt = 0
  }
}

// ─── Update state from real Anthropic response headers ──────────────────────
// account: 'claude_max' or 'claude_max_2'
function updateFromHeaders(headers, account = null) {
  const acct = account || _activeProvider
  const state = _accounts[acct]
  if (!state) return

  try {
    const get = (k) => {
      if (typeof headers.get === 'function') return headers.get(k)
      if (typeof headers === 'object') return headers[k] ?? headers[k.toLowerCase()] ?? null
      return null
    }

    const weeklyUtil   = get('anthropic-ratelimit-unified-7d-utilization')
    const weeklyReset  = get('anthropic-ratelimit-unified-7d-reset')
    const sessionUtil  = get('anthropic-ratelimit-unified-5h-utilization')
    const sessionReset = get('anthropic-ratelimit-unified-5h-reset')
    const status       = get('anthropic-ratelimit-unified-status')
    const claim        = get('anthropic-ratelimit-unified-representative-claim')
    const overageStatus = get('anthropic-ratelimit-unified-overage-status')

    if (weeklyUtil !== null && weeklyUtil !== undefined) {
      state.weeklyUtilization = Number(weeklyUtil)
      state.headersUpdatedAt  = Date.now()
      _cache = null
      _cacheAt = 0
    }
    if (weeklyReset !== null && weeklyReset !== undefined) {
      state.weeklyResetsAt = Number(weeklyReset)
    }
    if (sessionUtil !== null && sessionUtil !== undefined) {
      state.sessionUtilization = Number(sessionUtil)
    }
    if (sessionReset !== null && sessionReset !== undefined) {
      state.sessionResetsAt = Number(sessionReset)
    }
    if (status) state.rateLimitStatus = status
    if (claim)  state.rateLimitType   = claim
    state.isUsingOverage = overageStatus === 'allowed' || overageStatus === 'allowed_warning'

    logger.debug('Claude usage headers captured', {
      account: acct,
      weeklyUtil: state.weeklyUtilization,
      sessionUtil: state.sessionUtilization,
      status: state.rateLimitStatus,
      type: state.rateLimitType,
    })
  } catch (err) {
    logger.debug('updateFromHeaders failed', { error: err.message, account: acct })
  }
}

// ─── Quota-check: fire a minimal 1-token API call to read headers ────────────
// Now takes an explicit account parameter so we can probe both independently.
function _getConfigDir(account) {
  const home = process.env.HOME || process.env.USERPROFILE || ''
  if (account === 'claude_max_2') {
    return process.env.CLAUDE_CONFIG_DIR_2 || null
  }
  return process.env.CLAUDE_CONFIG_DIR_1 || path.join(home, '.claude')
}

function _readOAuthToken(configDir) {
  if (!configDir) return null

  const credCandidates = [
    path.join(configDir, '.credentials.json'),
    path.join(configDir, 'credentials.json'),
  ]
  const configCandidates = [
    path.join(configDir, '.claude.json'),
    path.join(configDir, 'claude.json'),
    configDir + '.json',
  ]

  for (const p of credCandidates) {
    if (fs.existsSync(p)) {
      try {
        const cred = JSON.parse(fs.readFileSync(p, 'utf8'))
        const token = cred?.claudeAiOauth?.accessToken
          || cred?.oauthAccount?.accessToken
          || cred?.accessToken
          || null
        if (token) return token
      } catch {}
    }
  }

  for (const p of configCandidates) {
    if (fs.existsSync(p)) {
      try {
        const cfg = JSON.parse(fs.readFileSync(p, 'utf8'))
        const token = cfg?.oauthAccount?.accessToken
          || cfg?.claudeAiOauth?.accessToken
          || null
        if (token) return token
      } catch {}
    }
  }

  return null
}

async function _doQuotaCheck(account) {
  const state = _accounts[account]
  if (!state) return

  try {
    const configDir = _getConfigDir(account)
    if (!configDir) {
      logger.debug('quota-check: no config dir, skipping', { account })
      return
    }

    const oauthToken = _readOAuthToken(configDir)
    if (!oauthToken) {
      logger.warn('quota-check: no OAuth token found', { account, configDir })
      return
    }

    const model = process.env.OS_SESSION_MODEL || 'claude-opus-4-5-20250514'

    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${oauthToken}`,
        'Content-Type': 'application/json',
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model,
        max_tokens: 1,
        messages: [{ role: 'user', content: 'quota' }],
      }),
    })

    // Extract headers regardless of status — 429s still carry utilization headers
    updateFromHeaders(resp.headers, account)

    if (resp.status === 429 && state.weeklyUtilization === null) {
      state.weeklyUtilization = 1.0
      state.rateLimitStatus = 'rejected'
      _cache = null
      _cacheAt = 0
    }

    if (resp.status === 401) {
      // Token expired — trigger proactive refresh instead of silently giving up
      logger.warn('quota-check: 401 Unauthorized — triggering token refresh', { account })
      try {
        const tokenRefresh = require('./claudeTokenRefreshService')
        const result = await tokenRefresh.refreshAccount(account, { force: true })
        if (result.refreshed) {
          logger.info('quota-check: token refreshed after 401 — retrying quota check', { account })
          // Retry once with fresh token
          return _doQuotaCheck(account)
        }
        if (result.isRevoked) {
          logger.error('quota-check: REFRESH TOKEN REVOKED — manual login required', { account })
        }
      } catch (refreshErr) {
        logger.warn('quota-check: token refresh failed after 401', { account, error: refreshErr.message })
      }
      return
    }

    logger.info('Claude quota-check complete', {
      account,
      status: resp.status,
      weeklyUtil: state.weeklyUtilization,
      sessionUtil: state.sessionUtilization,
      rateLimitStatus: state.rateLimitStatus,
      rateLimitType: state.rateLimitType,
    })
  } catch (err) {
    logger.debug('quota-check failed', { error: err.message, account })
  } finally {
    state.quotaCheckInFlight = null
  }
}

async function refreshQuotaCheck(account = null) {
  // If no account specified, refresh the active one
  if (!account) account = _activeProvider
  const state = _accounts[account]
  if (!state) return
  if (state.quotaCheckInFlight) return state.quotaCheckInFlight
  state.quotaCheckInFlight = _doQuotaCheck(account)
  return state.quotaCheckInFlight
}

// Refresh BOTH accounts — used on startup and periodically
async function refreshAllAccounts() {
  const promises = []
  promises.push(refreshQuotaCheck('claude_max').catch(() => {}))
  if (process.env.CLAUDE_CONFIG_DIR_2) {
    promises.push(refreshQuotaCheck('claude_max_2').catch(() => {}))
  }
  await Promise.allSettled(promises)
}

// ─── Energy state from real utilization ───────────────────────────────────────
function _energyState(pctUsed) {
  if (pctUsed <= 0.10) return { level: 'full',     label: 'Full energy',        modelRec: 'opus',   scheduleMultiplier: 1.0 }
  if (pctUsed <= 0.40) return { level: 'healthy',  label: 'Healthy',            modelRec: 'opus',   scheduleMultiplier: 1.0 }
  if (pctUsed <= 0.70) return { level: 'conserve', label: 'Conserving',         modelRec: 'sonnet', scheduleMultiplier: 0.75 }
  if (pctUsed <= 0.90) return { level: 'low',      label: 'Low energy',         modelRec: 'sonnet', scheduleMultiplier: 0.5 }
  return                      { level: 'critical',  label: 'Critical — minimal', modelRec: 'sonnet', scheduleMultiplier: 0.25 }
}

// ─── Account health scoring ─────────────────────────────────────────────────
// Returns a numeric score for how usable an account is right now.
// Higher = healthier. Negative = unusable.
function _accountHealth(account) {
  const state = _accounts[account]
  if (!state) return { score: -100, reason: 'no_state' }

  // Check if the config dir exists for this account
  const configDir = _getConfigDir(account)
  if (!configDir) return { score: -100, reason: 'no_config_dir' }

  // Rejected = completely unusable
  if (state.rateLimitStatus === 'rejected') {
    return { score: -10, reason: `rejected (${state.rateLimitType || 'unknown'})` }
  }

  // No data yet — unknown, treat as moderately healthy (prefer known-good accounts)
  if (state.weeklyUtilization === null) {
    return { score: 30, reason: 'no_data' }
  }

  const weeklyPct = state.weeklyUtilization  // 0–1
  const sessionPct = state.sessionUtilization // 0–1 or null

  // 5h session capped (>=95%) — this account can't do heavy work right now
  if (sessionPct !== null && sessionPct >= 0.95) {
    // But it might reset soon — check sessionResetsAt
    const now = Date.now()
    const resetsInMs = state.sessionResetsAt ? (state.sessionResetsAt * 1000 - now) : Infinity
    if (resetsInMs > 5 * 60 * 1000) {
      // More than 5 min until session reset — treat as capped
      return { score: -5, reason: `5h_session_capped (${Math.round(sessionPct * 100)}%, resets in ${Math.round(resetsInMs / 60000)}m)` }
    }
    // Resets soon — still usable but slightly penalised
  }

  // Weekly >= 99% — effectively exhausted
  if (weeklyPct >= 0.99) {
    return { score: -8, reason: `weekly_exhausted (${Math.round(weeklyPct * 100)}%)` }
  }

  // Score: base 100, subtract weekly usage, subtract session pressure
  let score = 100 - (weeklyPct * 80)  // 0% used = 100, 100% used = 20
  if (sessionPct !== null) {
    score -= sessionPct * 20  // 5h session pressure reduces score
  }

  // Penalise "allowed_warning" — it's about to get capped
  if (state.rateLimitStatus === 'allowed_warning') {
    score -= 15
  }

  return { score: Math.round(score), reason: 'healthy' }
}

// ─── Pick the best provider ─────────────────────────────────────────────────
// Returns { provider, reason, isBedrockFallback } for the caller to use.
function getBestProvider() {
  const hasAccount2 = !!process.env.CLAUDE_CONFIG_DIR_2
  const hasBedrock  = !!(process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY)

  const health1 = _accountHealth('claude_max')
  const health2 = hasAccount2 ? _accountHealth('claude_max_2') : { score: -100, reason: 'not_configured' }

  logger.debug('Provider health scores', {
    acct1: { score: health1.score, reason: health1.reason },
    acct2: { score: health2.score, reason: health2.reason },
    hasBedrock,
  })

  // Both usable — pick the healthier one
  if (health1.score > 0 && health2.score > 0) {
    if (health1.score >= health2.score) {
      return { provider: 'claude_max', reason: `acct1 healthier (${health1.score} vs ${health2.score})`, isBedrockFallback: false }
    }
    return { provider: 'claude_max_2', reason: `acct2 healthier (${health2.score} vs ${health1.score})`, isBedrockFallback: false }
  }

  // One usable — use it
  if (health1.score > 0) {
    return { provider: 'claude_max', reason: `acct1 ok (${health1.reason}), acct2 down (${health2.reason})`, isBedrockFallback: false }
  }
  if (health2.score > 0) {
    return { provider: 'claude_max_2', reason: `acct2 ok (${health2.reason}), acct1 down (${health1.reason})`, isBedrockFallback: false }
  }

  // Both down — try Bedrock
  if (hasBedrock) {
    return { provider: 'bedrock', reason: `both Max accounts down (acct1: ${health1.reason}, acct2: ${health2.reason})`, isBedrockFallback: true }
  }

  // Nothing available — return whichever is least bad
  const best = health1.score >= health2.score ? 'claude_max' : 'claude_max_2'
  return {
    provider: best,
    reason: `all providers exhausted — using ${best} as best-effort (acct1: ${health1.reason}, acct2: ${health2.reason})`,
    isBedrockFallback: false,
  }
}

// ─── Get energy snapshot for a specific account ──────────────────────────────
function _getAccountSnapshot(account) {
  const state = _accounts[account]
  if (!state) return null

  const now = Date.now()
  const hasRealData = state.weeklyUtilization !== null
  const pctUsed = hasRealData ? state.weeklyUtilization : null
  const pctRemaining = hasRealData ? Math.max(0, 1 - pctUsed) : null
  const energy = _energyState(pctUsed ?? 0)

  let hoursUntilReset = null
  if (state.weeklyResetsAt) {
    hoursUntilReset = Math.max(0, (state.weeklyResetsAt * 1000 - now) / 3_600_000)
  }

  let sessionHoursUntilReset = null
  if (state.sessionResetsAt) {
    sessionHoursUntilReset = Math.max(0, (state.sessionResetsAt * 1000 - now) / 3_600_000)
  }

  const sessionPctUsed = state.sessionUtilization ?? null

  return {
    source: hasRealData ? 'anthropic_headers' : 'no_data',
    pctUsed: pctUsed != null ? Math.round(pctUsed * 1000) / 10 : null,
    pctRemaining: pctRemaining != null ? Math.round(pctRemaining * 1000) / 10 : null,
    rateLimitStatus: state.rateLimitStatus,
    rateLimitType: state.rateLimitType,
    isUsingOverage: state.isUsingOverage,
    hoursUntilReset: hoursUntilReset != null ? Math.round(hoursUntilReset * 10) / 10 : null,
    sessionPctUsed: sessionPctUsed != null ? Math.round(sessionPctUsed * 1000) / 10 : null,
    sessionHoursUntilReset: sessionHoursUntilReset != null ? Math.round(sessionHoursUntilReset * 10) / 10 : null,
    headersAge: state.headersUpdatedAt ? Math.round((now - state.headersUpdatedAt) / 1000) : null,
    ...energy,
  }
}

// ─── Get current energy snapshot (main API — used by routes + osSession) ─────
async function getEnergy() {
  const now = Date.now()

  // Return cached snapshot if fresh
  if (_cache && (now - _cacheAt) < CACHE_TTL_MS) return _cache

  // Trigger background quota-checks for stale accounts
  for (const [acct, state] of Object.entries(_accounts)) {
    if (acct === 'claude_max_2' && !process.env.CLAUDE_CONFIG_DIR_2) continue
    const headerAge = state.headersUpdatedAt ? (now - state.headersUpdatedAt) : Infinity
    if (headerAge > HEADER_STALE_MS) {
      refreshQuotaCheck(acct).catch(() => {})
    }
  }

  // Build snapshots for both accounts
  const acct1 = _getAccountSnapshot('claude_max')
  const acct2 = process.env.CLAUDE_CONFIG_DIR_2 ? _getAccountSnapshot('claude_max_2') : null

  // Active account's snapshot is the primary one (backwards compat)
  const active = _activeProvider === 'claude_max_2' ? acct2 : acct1
  const hasRealData = active?.source === 'anthropic_headers'

  // Self-tracked turn count
  const selfTracked = await _getSelfTrackedTurns().catch(() => ({ turns: 0 }))

  // Best provider recommendation
  const best = getBestProvider()

  // Token auth health (proactive refresh status)
  let tokenHealth = null
  try {
    const tokenRefresh = require('./claudeTokenRefreshService')
    tokenHealth = tokenRefresh.getTokenHealth()
  } catch {}

  _cache = {
    // ─── Active account (backwards compat with existing consumers)
    source: active?.source || 'no_data',
    currentProvider: _activeProvider,
    headersAge: active?.headersAge,
    pctUsed: active?.pctUsed,
    pctRemaining: active?.pctRemaining,
    rateLimitStatus: active?.rateLimitStatus,
    rateLimitType: active?.rateLimitType,
    isUsingOverage: active?.isUsingOverage,
    hoursUntilReset: active?.hoursUntilReset,
    sessionPctUsed: active?.sessionPctUsed,
    sessionHoursUntilReset: active?.sessionHoursUntilReset,
    // ─── Energy decision layer (from active account)
    level: active?.level || 'full',
    label: active?.label || 'Unknown',
    modelRec: active?.modelRec || 'opus',
    scheduleMultiplier: active?.scheduleMultiplier || 1.0,
    // ─── Both accounts (for dashboard / debugging)
    accounts: {
      claude_max: acct1,
      claude_max_2: acct2,
    },
    // ─── Smart provider recommendation
    recommendedProvider: best.provider,
    providerReason: best.reason,
    isBedrockFallback: best.isBedrockFallback,
    // ─── Self-tracked activity
    turnsThisWeek: selfTracked.turns,
    // ─── Token auth health
    tokenHealth,
    // ─── Human-readable summary
    summary: _buildSummary({ acct1, acct2, active, hasRealData, turns: selfTracked.turns, best }),
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
      WHERE week_start = ${weekStart}
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

function _buildSummary({ acct1, acct2, active, hasRealData, turns, best }) {
  if (!hasRealData && active?.source !== 'anthropic_headers') {
    return `Claude Max energy: unknown (no headers yet). Recommended provider: ${best.provider} (${best.reason}).`
  }

  const lines = []

  // Account 1 summary
  if (acct1) {
    const w = acct1.pctUsed != null ? `${Math.round(acct1.pctUsed)}% weekly` : 'weekly unknown'
    const s = acct1.sessionPctUsed != null ? `, ${Math.round(acct1.sessionPctUsed)}% 5h-session` : ''
    lines.push(`Acct1: ${w}${s} [${acct1.rateLimitStatus}]`)
  }

  // Account 2 summary
  if (acct2) {
    const w = acct2.pctUsed != null ? `${Math.round(acct2.pctUsed)}% weekly` : 'weekly unknown'
    const s = acct2.sessionPctUsed != null ? `, ${Math.round(acct2.sessionPctUsed)}% 5h-session` : ''
    lines.push(`Acct2: ${w}${s} [${acct2.rateLimitStatus}]`)
  }

  lines.push(`Active: ${_activeProvider}. Recommended: ${best.provider} (${best.reason}).`)
  if (turns > 0) lines.push(`${turns} turns tracked this week.`)
  if (active?.hoursUntilReset != null) lines.push(`Week resets in ${Math.round(active.hoursUntilReset)}h.`)
  if (active?.isUsingOverage) lines.push('Using extra usage (overage).')

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

// ─── Mark an account as rejected (called by osSession on 429 / exhaustion) ───
function markAccountRejected(account, rateLimitType = 'unknown') {
  const state = _accounts[account]
  if (!state) return
  state.rateLimitStatus = 'rejected'
  state.rateLimitType = rateLimitType
  if (state.weeklyUtilization === null) state.weeklyUtilization = 1.0
  _cache = null
  _cacheAt = 0
  logger.warn('Account marked rejected', { account, rateLimitType })
}

module.exports = {
  setProvider,
  updateFromHeaders,
  refreshQuotaCheck,
  refreshAllAccounts,
  logUsage,
  getEnergy,
  getWeeklyHistory,
  getBestProvider,
  invalidateCache,
  markAccountRejected,
}
