const db = require('../config/db')
const logger = require('../config/logger')
const env = require('../config/env')

const HANDOFF_KEY = 'session.handoff_state'
const LAST_WAKE_KEY = 'session.last_auto_wake_at'
const WAKE_ENABLED_KEY = 'session.auto_wake_enabled'
const HANDOFF_MAX_AGE_MS = 6 * 60 * 60 * 1000  // 6 hours
const RATE_LIMIT_MS = 5 * 60 * 1000             // 5 minutes
const STARTUP_DELAY_MS = 15_000                  // 15 seconds

// kv_store.value is a TEXT column. Values written via JSON.stringify() must
// be parsed back with JSON.parse() when read. Do not assume JSONB auto-parse.
function parseKvValue(raw) {
  if (raw === null || raw === undefined) return null
  if (typeof raw === 'string') {
    try { return JSON.parse(raw) } catch { return raw }
  }
  return raw
}

async function triggerAutoWakeIfNeeded() {
  await new Promise(resolve => setTimeout(resolve, STARTUP_DELAY_MS))

  try {
    // Kill switch: if explicitly false, skip
    const killRows = await db`SELECT value FROM kv_store WHERE key = ${WAKE_ENABLED_KEY}`
    if (killRows.length > 0) {
      const val = parseKvValue(killRows[0].value)
      if (val === false || val === 'false') {
        logger.info('auto-wake: disabled via kv_store')
        return
      }
    }

    // Handoff state check - value column is TEXT (JSON-encoded object)
    const handoffRows = await db`SELECT value FROM kv_store WHERE key = ${HANDOFF_KEY}`
    if (!handoffRows.length) {
      logger.info('auto-wake: no recent handoff, skipping')
      return
    }
    const handoffState = parseKvValue(handoffRows[0].value)
    if (!handoffState || !handoffState.saved_at) {
      logger.info('auto-wake: no recent handoff, skipping')
      return
    }

    const age = Date.now() - new Date(handoffState.saved_at).getTime()
    if (age > HANDOFF_MAX_AGE_MS) {
      logger.info('auto-wake: no recent handoff, skipping')
      return
    }

    // Rate-limit guard - prevents wake storms during PM2 flap cycles
    const rateRows = await db`SELECT value FROM kv_store WHERE key = ${LAST_WAKE_KEY}`
    if (rateRows.length > 0) {
      try {
        const lastWakeStr = parseKvValue(rateRows[0].value)
        if (lastWakeStr) {
          const sinceLastWake = Date.now() - new Date(lastWakeStr).getTime()
          if (sinceLastWake < RATE_LIMIT_MS) {
            logger.info('auto-wake: rate-limited, skipping - PM2 flap protection')
            return
          }
        }
      } catch {
        // Malformed rate-limit entry - ignore, proceed with wake
      }
    }

    // Fire the wake message
    const ageMinutes = Math.round(age / 60000)
    let res
    try {
      res = await fetch(`http://localhost:${env.PORT}/api/os-session/message`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: `⚡ Back. Handoff state from ${ageMinutes} minutes ago is in your system prompt. Carry on with whatever's most valuable right now. If external blockers are all that's active, default to self-evolution, research, or creative work per CLAUDE.md - don't idle waiting for Tate.`,
        }),
      })
    } catch (fetchErr) {
      logger.warn('auto-wake: fetch failed', { error: fetchErr.message })
      return
    }

    if (!res.ok) {
      logger.warn(`auto-wake: HTTP ${res.status} - message endpoint rejected wake`)
      return
    }

    await db`
      INSERT INTO kv_store (key, value)
      VALUES (${LAST_WAKE_KEY}, ${JSON.stringify(new Date().toISOString())})
      ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value
    `

    logger.info(`auto-wake: fired - handoff was from ${ageMinutes} minutes ago`)
  } catch (err) {
    logger.warn('auto-wake: failed', { error: err.message })
  }
}

module.exports = { triggerAutoWakeIfNeeded }
