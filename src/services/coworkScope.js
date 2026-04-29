/**
 * Cowork V2 MCP — scope constants, allowlists, and requireScope helper.
 *
 * The single bearer at `kv_store.creds.cowork_mcp_bearer` carries an
 * embedded `scopes` array. Each route handler asserts the required scope
 * via `requireScope('<name>')` middleware. Scope absent → 403.
 *
 * Spec: ~/ecodiaos/drafts/cowork-deep-integration-architecture-2026-04-30.md §5.1.
 *
 * Authored: 30 Apr 2026 by fork_mokmorc8_24edea (W2-B).
 */
'use strict'

const SCOPES = Object.freeze([
  'read.status_board',
  'read.kv_store',
  'read.neo4j',
  'read.patterns',
  'read.email_threads',
  'read.crm',
  'read.forks',
  'read.cowork.inbox',
  'write.status_board.cowork_owned',
  'write.kv_store.cowork_namespace',
  'write.neo4j.episode',
  'write.neo4j.decision',
  'write.forks.cowork_pool',
  'write.os_session.message',
  'write.cowork.session_log',
  'write.cowork.heartbeat',
])

const KV_WRITE_NAMESPACES = Object.freeze([
  'cowork.',
  'cowork-session.',
])

const KV_WRITE_ALLOWLIST = Object.freeze([])

const KV_READ_DENY_PREFIXES = Object.freeze([
  'creds.',
])

const STATUS_BOARD_DENIED_UPDATE_TYPES = Object.freeze([
  'legal',
  'infrastructure',
])

const NEO4J_EPISODE_TYPES = Object.freeze([
  'cowork_dispatch',
  'cowork_realisation',
  'cowork_audit',
  'conductor_observed',
])

const RATE_CAPS = Object.freeze({
  os_session_message_per_hour: 6,
  forks_spawn_per_day:         30,
  status_board_upsert_per_day: 200,
})

const COWORK_FORK_CAP = 3

function requireScope(scope) {
  if (!SCOPES.includes(scope)) {
    throw new Error(`requireScope: unknown scope ${scope}`)
  }
  return (req, res, next) => {
    if (!Array.isArray(req.coworkScopes) || !req.coworkScopes.includes(scope)) {
      return res.status(403).json({
        error: 'scope_denied',
        message: `requires ${scope}`,
        details: { required: scope, granted: req.coworkScopes || [] },
      })
    }
    next()
  }
}

function kvKeyIsWritable(key) {
  if (typeof key !== 'string' || !key) return false
  if (KV_WRITE_NAMESPACES.some(prefix => key.startsWith(prefix))) return true
  if (KV_WRITE_ALLOWLIST.includes(key)) return true
  return false
}

function kvKeyIsReadable(key) {
  if (typeof key !== 'string' || !key) return false
  if (KV_READ_DENY_PREFIXES.some(prefix => key.startsWith(prefix))) return false
  return true
}

function statusBoardEntityTypeIsUpdatable(entityType) {
  if (!entityType) return true
  return !STATUS_BOARD_DENIED_UPDATE_TYPES.includes(entityType)
}

module.exports = {
  SCOPES,
  KV_WRITE_NAMESPACES,
  KV_WRITE_ALLOWLIST,
  KV_READ_DENY_PREFIXES,
  STATUS_BOARD_DENIED_UPDATE_TYPES,
  NEO4J_EPISODE_TYPES,
  RATE_CAPS,
  COWORK_FORK_CAP,
  requireScope,
  kvKeyIsWritable,
  kvKeyIsReadable,
  statusBoardEntityTypeIsUpdatable,
}
