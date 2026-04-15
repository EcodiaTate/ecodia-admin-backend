const db = require('../config/db')
const logger = require('../config/logger')

const KV_KEY = 'session.handoff_state'
const MAX_AGE_MS = 6 * 60 * 60 * 1000 // 6 hours

async function readHandoffState() {
  try {
    const rows = await db`SELECT value FROM kv_store WHERE key = ${KV_KEY}`
    if (!rows.length) return null

    const state = rows[0].value
    if (!state.saved_at) return null

    const age = Date.now() - new Date(state.saved_at).getTime()
    if (age > MAX_AGE_MS) return null

    const lines = ['# Session Recovery State']
    lines.push(`_Saved ${Math.round(age / 60000)} minutes ago._\n`)

    if (state.current_work) lines.push(`## Current Work\n${state.current_work}\n`)
    if (state.active_plan) lines.push(`## Active Plan\n${state.active_plan}\n`)
    if (state.tate_last_direction) lines.push(`## Tate's Last Direction\n${state.tate_last_direction}\n`)
    if (state.deliverables_status) lines.push(`## Deliverables Status\n${state.deliverables_status}\n`)

    return lines.join('\n')
  } catch (err) {
    logger.warn('Failed to read handoff state', { error: err.message })
    return null
  }
}

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

module.exports = { readHandoffState, saveHandoffState }
