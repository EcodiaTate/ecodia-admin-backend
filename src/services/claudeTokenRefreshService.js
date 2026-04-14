/**
 * Claude OAuth Token Refresh Service
 *
 * Proactively refreshes Claude Max OAuth tokens before they expire,
 * eliminating the need for manual `claude /login` on the VPS.
 *
 * How it works:
 *   1. Reads .credentials.json for each configured account
 *   2. Checks expiresAt — if within REFRESH_BUFFER_MS, refreshes proactively
 *   3. Calls platform.claude.com/v1/oauth/token with the refresh_token
 *   4. Writes new access_token + refresh_token + expiresAt back to disk
 *   5. Runs on a timer (default every 30 min) so tokens never go stale
 *
 * The SDK auto-refreshes 5 min before expiry, but only when a query() is
 * actively running. Between sessions (idle hours, rate-limit waits), nobody
 * refreshes — the token can expire silently. This service fills that gap.
 *
 * If the refresh_token itself is revoked (Anthropic server-side), this logs
 * an alert. That's the only scenario requiring manual intervention.
 */

const fs = require('fs')
const path = require('path')
const logger = require('../config/logger')

// ─── Constants ──────────────────────────────────────────────────────────────

// Claude Code OAuth client ID (same as the CLI uses)
const CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e'
const TOKEN_URL = 'https://platform.claude.com/v1/oauth/token'
const DEFAULT_SCOPES = [
  'user:profile',
  'user:inference',
  'user:sessions:claude_code',
  'user:mcp_servers',
  'user:file_upload',
]

// Refresh 1 hour before expiry (SDK does 5 min — we're more conservative)
const REFRESH_BUFFER_MS = 60 * 60 * 1000

// How often to check all accounts (30 minutes)
const CHECK_INTERVAL_MS = 30 * 60 * 1000

// Retry config for transient failures
const MAX_RETRIES = 3
const RETRY_DELAY_MS = 10_000

// Anthropic API base for live token validation
const ANTHROPIC_API_BASE = 'https://api.anthropic.com'

// ─── State ──────────────────────────────────────────────────────────────────

let _checkTimer = null
const _accountStatus = {}  // account -> { lastRefresh, lastError, consecutiveFailures }

// ─── Credential file operations ─────────────────────────────────────────────

function _getConfigDir(account) {
  const home = process.env.HOME || process.env.USERPROFILE || ''
  if (account === 'claude_max_2') {
    return process.env.CLAUDE_CONFIG_DIR_2 || null
  }
  return process.env.CLAUDE_CONFIG_DIR_1 || path.join(home, '.claude')
}

function _getCredPath(configDir) {
  // Check both naming conventions
  const dotPath = path.join(configDir, '.credentials.json')
  const plainPath = path.join(configDir, 'credentials.json')

  if (fs.existsSync(dotPath)) return dotPath
  if (fs.existsSync(plainPath)) return plainPath
  return dotPath  // default to dot-prefixed for new writes
}

function _readCredentials(account) {
  const configDir = _getConfigDir(account)
  if (!configDir) return null

  const credPath = _getCredPath(configDir)
  if (!fs.existsSync(credPath)) return null

  try {
    const raw = fs.readFileSync(credPath, 'utf8')
    const cred = JSON.parse(raw)
    return { cred, credPath, configDir }
  } catch (err) {
    logger.warn('Token refresh: failed to read credentials', { account, error: err.message })
    return null
  }
}

function _writeCredentials(credPath, cred) {
  // Atomic write: write to temp file then rename
  const tmpPath = credPath + '.tmp'
  fs.writeFileSync(tmpPath, JSON.stringify(cred, null, 2), 'utf8')
  fs.renameSync(tmpPath, credPath)
}

// ─── Token refresh ──────────────────────────────────────────────────────────

async function _refreshToken(refreshToken, scopes) {
  const body = {
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: CLIENT_ID,
    scope: (scopes?.length ? scopes : DEFAULT_SCOPES).join(' '),
  }

  const resp = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  })

  if (resp.status === 401 || resp.status === 403) {
    // Refresh token itself is dead — requires manual login
    const errorBody = await resp.text().catch(() => '')
    throw Object.assign(
      new Error(`Refresh token revoked (${resp.status}): ${errorBody.slice(0, 200)}`),
      { isRevoked: true }
    )
  }

  if (resp.status !== 200) {
    const errorBody = await resp.text().catch(() => '')
    throw new Error(`Token refresh failed (${resp.status}): ${errorBody.slice(0, 200)}`)
  }

  const data = await resp.json()
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token || refreshToken,  // may return new refresh token
    expiresIn: data.expires_in,
    expiresAt: Date.now() + data.expires_in * 1000,
    scope: data.scope,
    account: data.account,
    organization: data.organization,
  }
}

// ─── Live token validation ──────────────────────────────────────────────────
//
// "expiresAt is in the future" is NOT proof a token works. The Anthropic server
// can invalidate a token early (refresh-token rotation race, scope mismatch,
// account-level revocation) and the SDK's local clock has no idea. We hit a
// minimal endpoint to confirm the bearer is actually accepted.
//
// Uses the OAuth-only model listing endpoint with the bearer — it's free,
// fast, and returns 401 when the token is dead.

async function _validateAccessToken(accessToken) {
  try {
    const resp = await fetch(`${ANTHROPIC_API_BASE}/v1/models?limit=1`, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'anthropic-version': '2023-06-01',
        'anthropic-beta': 'oauth-2025-04-20',
      },
      signal: AbortSignal.timeout(10_000),
    })
    if (resp.status === 200) return { valid: true }
    if (resp.status === 401 || resp.status === 403) {
      const body = await resp.text().catch(() => '')
      return { valid: false, status: resp.status, body: body.slice(0, 200) }
    }
    // Other statuses (5xx, 429): treat as inconclusive — don't punish a healthy token
    // for a server hiccup.
    return { valid: true, inconclusive: true, status: resp.status }
  } catch (err) {
    // Network error — inconclusive.
    return { valid: true, inconclusive: true, error: err.message }
  }
}

// ─── Per-account refresh logic ──────────────────────────────────────────────

async function refreshAccount(account, { force = false } = {}) {
  const result = _readCredentials(account)
  if (!result) {
    logger.debug('Token refresh: no credentials for account', { account })
    return { skipped: true, reason: 'no_credentials' }
  }

  const { cred, credPath } = result
  const oauth = cred.claudeAiOauth
  if (!oauth?.refreshToken) {
    logger.warn('Token refresh: no refresh token stored', { account })
    return { skipped: true, reason: 'no_refresh_token' }
  }

  // Check if refresh is needed
  const now = Date.now()
  const expiresAt = oauth.expiresAt || 0
  const timeUntilExpiry = expiresAt - now

  if (!force && timeUntilExpiry > REFRESH_BUFFER_MS) {
    const hoursLeft = Math.round(timeUntilExpiry / 3_600_000 * 10) / 10

    // "expiresAt is in the future" is necessary but not sufficient. Validate the
    // token actually works against the API — Anthropic can revoke it server-side
    // (refresh-token rotation race, scope drift) without telling us.
    const check = await _validateAccessToken(oauth.accessToken)
    if (check.valid) {
      logger.debug('Token refresh: token still fresh and validated', { account, hoursLeft })
      return { skipped: true, reason: 'still_fresh', hoursUntilExpiry: hoursLeft }
    }

    logger.warn('Token refresh: token claims fresh but API rejected it — forcing refresh', {
      account, hoursLeft, status: check.status, body: check.body,
    })
    // Fall through to refresh path below
  }

  // Token needs refresh
  const hoursLeft = Math.round(timeUntilExpiry / 3_600_000 * 10) / 10
  logger.info('Token refresh: refreshing token', {
    account,
    hoursUntilExpiry: hoursLeft,
    forced: force,
  })

  let lastErr = null
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const fresh = await _refreshToken(oauth.refreshToken, oauth.scopes)

      // Update credentials on disk
      cred.claudeAiOauth = {
        ...oauth,
        accessToken: fresh.accessToken,
        refreshToken: fresh.refreshToken,
        expiresAt: fresh.expiresAt,
      }

      // Preserve account metadata if returned
      if (fresh.account) {
        if (!cred.claudeAiOauth.tokenAccount) cred.claudeAiOauth.tokenAccount = {}
        cred.claudeAiOauth.tokenAccount.uuid = fresh.account.uuid
        cred.claudeAiOauth.tokenAccount.emailAddress = fresh.account.email_address
      }

      _writeCredentials(credPath, cred)

      // Validate the new token actually works. The refresh endpoint can return
      // a 200 with a token that the API still rejects (scope mismatch, account
      // state, etc). We must not log SUCCESS until we've confirmed end-to-end.
      const postCheck = await _validateAccessToken(fresh.accessToken)
      if (!postCheck.valid && !postCheck.inconclusive) {
        if (!_accountStatus[account]) _accountStatus[account] = {}
        _accountStatus[account].lastError = `post-refresh validation failed (${postCheck.status})`
        _accountStatus[account].consecutiveFailures = (_accountStatus[account].consecutiveFailures || 0) + 1
        logger.error('Token refresh: refreshed but validation failed — token is dead-on-arrival', {
          account, status: postCheck.status, body: postCheck.body,
        })
        return {
          error: true,
          isRevoked: false,
          deadOnArrival: true,
          message: `Refreshed token rejected by API (${postCheck.status}): ${postCheck.body}`,
        }
      }

      // Update status
      if (!_accountStatus[account]) _accountStatus[account] = {}
      _accountStatus[account].lastRefresh = now
      _accountStatus[account].lastError = null
      _accountStatus[account].consecutiveFailures = 0

      const newHoursLeft = Math.round((fresh.expiresAt - now) / 3_600_000 * 10) / 10
      logger.info('Token refresh: SUCCESS', {
        account,
        newExpiresInHours: newHoursLeft,
        attempt,
        gotNewRefreshToken: fresh.refreshToken !== oauth.refreshToken,
        validated: !postCheck.inconclusive,
      })

      return {
        refreshed: true,
        expiresAt: fresh.expiresAt,
        expiresInHours: newHoursLeft,
        gotNewRefreshToken: fresh.refreshToken !== oauth.refreshToken,
        validated: !postCheck.inconclusive,
      }
    } catch (err) {
      lastErr = err

      if (err.isRevoked) {
        // Refresh token is dead — no point retrying
        logger.error('TOKEN REFRESH: REFRESH TOKEN REVOKED — manual `claude /login` required', {
          account,
          error: err.message,
        })

        if (!_accountStatus[account]) _accountStatus[account] = {}
        _accountStatus[account].lastError = err.message
        _accountStatus[account].consecutiveFailures = (
          _accountStatus[account].consecutiveFailures || 0
        ) + 1
        _accountStatus[account].isRevoked = true

        return { error: true, isRevoked: true, message: err.message }
      }

      if (attempt < MAX_RETRIES) {
        logger.warn('Token refresh: attempt failed, retrying', {
          account, attempt, maxRetries: MAX_RETRIES, error: err.message,
        })
        await new Promise(r => setTimeout(r, RETRY_DELAY_MS * attempt))
      }
    }
  }

  // All retries exhausted
  logger.error('Token refresh: all retries failed', {
    account,
    error: lastErr?.message,
  })

  if (!_accountStatus[account]) _accountStatus[account] = {}
  _accountStatus[account].lastError = lastErr?.message
  _accountStatus[account].consecutiveFailures = (
    _accountStatus[account].consecutiveFailures || 0
  ) + 1

  return { error: true, isRevoked: false, message: lastErr?.message }
}

// ─── Refresh all configured accounts ────────────────────────────────────────

async function refreshAllAccounts({ force = false } = {}) {
  const results = {}

  results.claude_max = await refreshAccount('claude_max', { force })

  if (process.env.CLAUDE_CONFIG_DIR_2) {
    results.claude_max_2 = await refreshAccount('claude_max_2', { force })
  }

  return results
}

// ─── Health check — report token status without refreshing ──────────────────

function getTokenHealth() {
  const now = Date.now()
  const health = {}

  for (const account of ['claude_max', 'claude_max_2']) {
    if (account === 'claude_max_2' && !process.env.CLAUDE_CONFIG_DIR_2) continue

    const result = _readCredentials(account)
    if (!result) {
      health[account] = { status: 'no_credentials' }
      continue
    }

    const oauth = result.cred.claudeAiOauth
    if (!oauth?.accessToken) {
      health[account] = { status: 'no_token' }
      continue
    }

    const expiresAt = oauth.expiresAt || 0
    const timeUntilExpiry = expiresAt - now
    const hoursLeft = Math.round(timeUntilExpiry / 3_600_000 * 10) / 10
    const isExpired = timeUntilExpiry <= 0
    const needsRefresh = timeUntilExpiry <= REFRESH_BUFFER_MS

    const acctStatus = _accountStatus[account] || {}

    health[account] = {
      status: isExpired ? 'expired' : needsRefresh ? 'needs_refresh' : 'healthy',
      hoursUntilExpiry: hoursLeft,
      hasRefreshToken: !!oauth.refreshToken,
      lastRefresh: acctStatus.lastRefresh || null,
      lastError: acctStatus.lastError || null,
      consecutiveFailures: acctStatus.consecutiveFailures || 0,
      isRevoked: acctStatus.isRevoked || false,
    }
  }

  return health
}

// ─── Periodic refresh loop ──────────────────────────────────────────────────

async function _runCheckCycle() {
  try {
    const results = await refreshAllAccounts()

    // Log summary
    const summary = Object.entries(results).map(([acct, r]) => {
      if (r.skipped) return `${acct}: ${r.reason}${r.hoursUntilExpiry ? ` (${r.hoursUntilExpiry}h left)` : ''}`
      if (r.refreshed) return `${acct}: REFRESHED (${r.expiresInHours}h until next expiry)`
      if (r.deadOnArrival) return `${acct}: DEAD-ON-ARRIVAL — refreshed but API rejected new token`
      if (r.error) return `${acct}: ERROR ${r.isRevoked ? '(REVOKED)' : ''} — ${r.message?.slice(0, 100)}`
      return `${acct}: unknown`
    }).join(' | ')

    logger.info('Token refresh cycle complete', { summary })
  } catch (err) {
    logger.error('Token refresh cycle failed', { error: err.message })
  }
}

function start() {
  if (_checkTimer) return  // already running

  logger.info('Claude token refresh service starting', {
    intervalMinutes: CHECK_INTERVAL_MS / 60_000,
    bufferHours: REFRESH_BUFFER_MS / 3_600_000,
  })

  // Run immediately on start
  _runCheckCycle()

  // Then every CHECK_INTERVAL_MS
  _checkTimer = setInterval(_runCheckCycle, CHECK_INTERVAL_MS)
  _checkTimer.unref()  // don't prevent process exit
}

function stop() {
  if (_checkTimer) {
    clearInterval(_checkTimer)
    _checkTimer = null
  }
}

// Public validator — read credentials for an account and check the access token
// against the live API. Used by the OS session to confirm an empty CLI exit was
// actually an auth failure (vs some other CLI bug) before paying the cost of a
// full refresh + retry round-trip.
async function validateAccount(account) {
  const result = _readCredentials(account)
  if (!result) return { valid: false, reason: 'no_credentials' }
  const token = result.cred?.claudeAiOauth?.accessToken
  if (!token) return { valid: false, reason: 'no_token' }
  const check = await _validateAccessToken(token)
  return check
}

module.exports = {
  refreshAccount,
  refreshAllAccounts,
  getTokenHealth,
  validateAccount,
  start,
  stop,
}
