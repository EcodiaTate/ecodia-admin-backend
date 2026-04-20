/**
 * Tate Active Session Gate
 *
 * Tracks whether Tate is actively talking to the OS. When active, background
 * crons stand down instead of interleaving bot-originated turns into his chat.
 *
 * Key: system.tate_active_session_until (kv_store, TEXT column, JSON-encoded)
 * Value: { "until": "<ISO datetime>" }
 * TTL: 15 minutes from last inbound user message
 */

const db = require('../config/db')
const logger = require('../config/logger')

const KV_KEY = 'system.tate_active_session_until'
const ACTIVE_WINDOW_MS = 15 * 60 * 1000 // 15 minutes

function parseKvValue(raw) {
  if (raw === null || raw === undefined) return null
  if (typeof raw === 'string') {
    try { return JSON.parse(raw) } catch { return null }
  }
  return raw
}

/**
 * Stamp the gate: Tate is active until now + 15 minutes.
 * Called on every inbound user message. Fails open — never throws.
 */
async function stampTateActive() {
  const until = new Date(Date.now() + ACTIVE_WINDOW_MS).toISOString()
  const value = JSON.stringify({ until })
  await db`
    INSERT INTO kv_store (key, value)
    VALUES (${KV_KEY}, ${value})
    ON CONFLICT (key) DO UPDATE SET value = ${value}
  `
}

/**
 * Check if Tate is currently active (within the 15-minute window).
 * Fails open — returns false on any error so crons are never blocked by a broken check.
 */
async function isTateActive() {
  try {
    const rows = await db`SELECT value FROM kv_store WHERE key = ${KV_KEY}`
    if (rows.length === 0) return false
    const parsed = parseKvValue(rows[0].value)
    if (!parsed || !parsed.until) return false
    return new Date(parsed.until) > new Date()
  } catch {
    return false
  }
}

module.exports = { stampTateActive, isTateActive }
