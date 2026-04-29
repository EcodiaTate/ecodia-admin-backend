/**
 * Cowork V2 MCP — conductor-side inbox helper.
 *
 * Spec: ~/ecodiaos/drafts/cowork-deep-integration-architecture-2026-04-30.md §6.
 *
 * Authored: 30 Apr 2026 by fork_mokmorc8_24edea (W2-B).
 */
'use strict'

const db = require('../config/db')
const logger = require('../config/logger')

const DEFAULT_EXPIRES_HOURS = 24

async function queue({ body, from_actor, expires_in_hours, ack_required = true, metadata = null }) {
  if (!body || typeof body !== 'string') {
    throw Object.assign(new Error('body required'), { code: 'invalid_body' })
  }
  if (!from_actor || typeof from_actor !== 'string') {
    throw Object.assign(new Error('from_actor required'), { code: 'invalid_from_actor' })
  }
  const hours = Number.isFinite(expires_in_hours) ? expires_in_hours : DEFAULT_EXPIRES_HOURS
  const expiresAt = new Date(Date.now() + hours * 3600_000)
  const [row] = await db`
    INSERT INTO cowork_inbox (body, from_actor, ack_required, expires_at, metadata)
    VALUES (${body}, ${from_actor}, ${ack_required}, ${expiresAt}, ${metadata ? JSON.stringify(metadata) : null})
    RETURNING id, queued_at, expires_at
  `
  logger.info('coworkInbox: queued', { id: row.id, from_actor, hours })
  return row
}

async function read({ since, limit = 20, ack = false } = {}) {
  const cap = Math.max(1, Math.min(100, limit | 0))
  const rows = since
    ? await db`
        SELECT id, queued_at, from_actor, body, ack_required, expires_at, metadata
        FROM cowork_inbox
        WHERE acked_at IS NULL
          AND (expires_at IS NULL OR expires_at > NOW())
          AND queued_at >= ${since}
        ORDER BY queued_at ASC
        LIMIT ${cap}
      `
    : await db`
        SELECT id, queued_at, from_actor, body, ack_required, expires_at, metadata
        FROM cowork_inbox
        WHERE acked_at IS NULL
          AND (expires_at IS NULL OR expires_at > NOW())
        ORDER BY queued_at ASC
        LIMIT ${cap}
      `

  if (ack && rows.length > 0) {
    const ids = rows.map(r => r.id)
    await db`UPDATE cowork_inbox SET acked_at = NOW() WHERE id = ANY(${ids})`
  }

  return rows
}

async function peek({ since, limit = 50 } = {}) {
  return read({ since, limit, ack: false })
}

async function archive({ id }) {
  if (!id) throw Object.assign(new Error('id required'), { code: 'invalid_id' })
  const [row] = await db`
    UPDATE cowork_inbox SET acked_at = NOW()
    WHERE id = ${id} AND acked_at IS NULL
    RETURNING id, acked_at
  `
  return row || null
}

module.exports = { queue, read, peek, archive }
