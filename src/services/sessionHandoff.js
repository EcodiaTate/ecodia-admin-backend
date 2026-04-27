const db = require('../config/db')
const logger = require('../config/logger')

const KV_KEY = 'session.handoff_state'
const MAX_AGE_MS = 6 * 60 * 60 * 1000 // 6 hours

// Guard: emit deprecation warning at most once per process lifetime
let _deprecationWarned = false

// ─── Internal helpers ────────────────────────────────────────────────

async function _fetchState() {
  const rows = await db`SELECT value FROM kv_store WHERE key = ${KV_KEY}`
  if (!rows.length) return null

  const raw = rows[0].value
  const state = typeof raw === 'string' ? JSON.parse(raw) : raw
  if (!state.saved_at) return null

  const age = Date.now() - new Date(state.saved_at).getTime()
  if (age > MAX_AGE_MS) return null

  return { state, age }
}

function _isConsumed(state) {
  if (!state.consumed_at) return false
  return new Date(state.consumed_at) >= new Date(state.saved_at)
}

function _format(state, age) {
  const lines = ['# Session Recovery State']
  lines.push(`_Saved ${Math.round(age / 60000)} minutes ago._\n`)
  if (state.current_work) lines.push(`## Current Work\n${state.current_work}\n`)
  if (state.active_plan) lines.push(`## Active Plan\n${state.active_plan}\n`)
  if (state.tate_last_direction) lines.push(`## Tate's Last Direction\n${state.tate_last_direction}\n`)
  if (state.deliverables_status) lines.push(`## Deliverables Status\n${state.deliverables_status}\n`)
  return lines.join('\n')
}

// ─── Public API ──────────────────────────────────────────────────────

/**
 * peekHandoffState — read-only, no side effects on kv_store.
 * Returns null if the row is absent, too old, or already consumed.
 */
async function peekHandoffState() {
  try {
    const result = await _fetchState()
    if (!result) {
      logger.info('handoff_state.peek', { present: false, consumed: false })
      return null
    }
    const { state, age } = result
    const consumed = _isConsumed(state)
    logger.info('handoff_state.peek', { age_min: Math.round(age / 60000), present: true, consumed })
    if (consumed) return null
    return _format(state, age)
  } catch (err) {
    logger.warn('Failed to peek handoff state', { error: err.message })
    return null
  }
}

/**
 * consumeHandoffState — atomically reads and marks the row consumed.
 * Returns the formatted recovery block, or null if absent/stale/already consumed.
 * Subsequent peek/consume calls return null until saveHandoffState writes a new row.
 */
async function consumeHandoffState() {
  try {
    const result = await _fetchState()
    if (!result) {
      logger.info('handoff_state.consume', { present: false })
      return null
    }
    const { state, age } = result

    if (_isConsumed(state)) {
      logger.info('handoff_state.consume', { age_min: Math.round(age / 60000), already_consumed: true })
      return null
    }

    // Atomically mark as consumed. The WHERE clause prevents a second caller from
    // consuming the same row between our SELECT and this UPDATE.
    const markedConsumedAt = new Date().toISOString()
    const updated = await db`
      UPDATE kv_store
      SET value = jsonb_set(value::jsonb, '{consumed_at}', to_jsonb(${markedConsumedAt}::text), true)
      WHERE key = ${KV_KEY}
        AND (
          (value::jsonb->>'consumed_at') IS NULL
          OR (value::jsonb->>'consumed_at')::timestamptz < (value::jsonb->>'saved_at')::timestamptz
        )
      RETURNING value
    `

    if (!updated.length) {
      // Race condition: another caller consumed the row between our SELECT and UPDATE.
      logger.info('handoff_state.consume', { age_min: Math.round(age / 60000), race_lost: true })
      return null
    }

    logger.info('handoff_state.consume', { age_min: Math.round(age / 60000), marked_consumed_at: markedConsumedAt })
    return _format(state, age)
  } catch (err) {
    logger.warn('Failed to consume handoff state', { error: err.message })
    return null
  }
}

/**
 * saveHandoffState — persists current working state to kv_store.
 * consumed_at is intentionally absent on save; it is added by consumeHandoffState only.
 * This means any existing consumed_at on the row is replaced by EXCLUDED.value (no consumed_at),
 * which resets the consumed flag for the new save.
 */
async function saveHandoffState({ current_work, active_plan, tate_last_direction, deliverables_status }) {
  const value = {
    current_work: current_work || null,
    active_plan: active_plan || null,
    tate_last_direction: tate_last_direction || null,
    deliverables_status: deliverables_status || null,
    saved_at: new Date().toISOString(),
  }

  await db`
    INSERT INTO kv_store (key, value)
    VALUES (${KV_KEY}, ${JSON.stringify(value)})
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value
  `
  return value
}

/**
 * readHandoffState — deprecated alias for peekHandoffState().
 * Callers in the consume path should switch to consumeHandoffState().
 */
function readHandoffState() {
  if (!_deprecationWarned) {
    _deprecationWarned = true
    logger.warn('readHandoffState() is deprecated — use peekHandoffState() or consumeHandoffState()')
  }
  return peekHandoffState()
}

module.exports = { peekHandoffState, consumeHandoffState, saveHandoffState, readHandoffState }
