/**
 * Cowork V2 MCP — 24h idempotency cache.
 *
 * Spec: ~/ecodiaos/drafts/cowork-deep-integration-architecture-2026-04-30.md §4.
 *
 * Authored: 30 Apr 2026 by fork_mokmorc8_24edea (W2-B).
 */
'use strict'

const db = require('../config/db')
const logger = require('../config/logger')

const TTL_HOURS = 24

async function check(key) {
  if (!key || typeof key !== 'string') return null
  try {
    const [row] = await db`
      SELECT response_json, created_at
      FROM cowork_idempotency_log
      WHERE key = ${key}
        AND created_at > NOW() - INTERVAL '24 hours'
    `
    if (!row) return null
    return row.response_json
  } catch (err) {
    logger.warn('coworkIdempotency.check failed (non-fatal)', { error: err.message })
    return null
  }
}

async function record(key, toolName, response) {
  if (!key || typeof key !== 'string') return
  try {
    await db`
      INSERT INTO cowork_idempotency_log (key, tool_name, response_json, created_at)
      VALUES (${key}, ${toolName || 'unknown'}, ${JSON.stringify(response)}, NOW())
      ON CONFLICT (key) DO UPDATE
        SET response_json = EXCLUDED.response_json,
            tool_name     = EXCLUDED.tool_name,
            created_at    = NOW()
    `
    if (Math.random() < 0.02) {
      await db`DELETE FROM cowork_idempotency_log WHERE created_at < NOW() - INTERVAL '24 hours'`
    }
  } catch (err) {
    logger.warn('coworkIdempotency.record failed (non-fatal)', { error: err.message })
  }
}

module.exports = { check, record, TTL_HOURS }
