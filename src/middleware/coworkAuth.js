/**
 * Cowork V2 MCP — bearer auth middleware.
 *
 * Reads `Authorization: Bearer <token>`, looks up the canonical token in
 * `kv_store.creds.cowork_mcp_bearer.token`, constant-time compares, and
 * attaches `req.coworkScopes` (array) on success. 401 on miss.
 *
 * Spec: ~/ecodiaos/drafts/cowork-deep-integration-architecture-2026-04-30.md §5.1.
 *
 * Authored: 30 Apr 2026 by fork_mokmorc8_24edea (W2-B).
 */
'use strict'

const crypto = require('crypto')
const db = require('../config/db')
const logger = require('../config/logger')

const CACHE_TTL_MS = 60_000

let _cached = null
let _cachedAt = 0

async function _fetchBearerRow() {
  if (_cached && Date.now() - _cachedAt < CACHE_TTL_MS) return _cached
  try {
    const [row] = await db`
      SELECT value FROM kv_store WHERE key = 'creds.cowork_mcp_bearer'
    `
    let parsed = null
    if (row?.value) {
      if (typeof row.value === 'string') {
        try { parsed = JSON.parse(row.value) }
        catch (parseErr) {
          logger.warn('coworkAuth: bearer row value not parseable JSON', { error: parseErr.message })
          parsed = null
        }
      } else {
        parsed = row.value
      }
    }
    _cached = parsed
    _cachedAt = Date.now()
    return _cached
  } catch (err) {
    logger.warn('coworkAuth: kv_store fetch failed', { error: err.message })
    return null
  }
}

function _clearCache() {
  _cached = null
  _cachedAt = 0
}

function _safeEq(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false
  if (a.length !== b.length) return false
  try {
    return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b))
  } catch {
    return false
  }
}

function bearerFingerprint(token) {
  if (typeof token !== 'string' || !token) return null
  return crypto.createHash('sha256').update(token).digest('hex').slice(0, 12)
}

async function coworkAuth(req, res, next) {
  const header = req.headers.authorization
  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'missing_bearer', message: 'Authorization: Bearer <token> required' })
  }
  const token = header.slice(7)

  const row = await _fetchBearerRow()
  if (!row || !row.token) {
    logger.warn('coworkAuth: bearer row missing or malformed in kv_store')
    return res.status(401).json({ error: 'bearer_unconfigured', message: 'cowork bearer not provisioned' })
  }

  if (!_safeEq(token, row.token)) {
    return res.status(401).json({ error: 'invalid_bearer', message: 'token does not match' })
  }

  req.coworkScopes = Array.isArray(row.scopes) ? row.scopes : []
  req.coworkBearerFingerprint = bearerFingerprint(token)
  req.coworkBearerRow = row
  next()
}

module.exports = coworkAuth
module.exports.bearerFingerprint = bearerFingerprint
module.exports._clearCache = _clearCache
module.exports._safeEq = _safeEq
