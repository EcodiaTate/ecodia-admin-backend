/**
 * Macro Runbooks — /api/runbooks/*
 *
 * Persistent JSON runbooks for the vision-first learn-by-doing macro
 * doctrine. The agent writes a runbook on the first successful learning
 * run and replays it on subsequent runs.
 *
 * Schema (steps):  array of { action, params, on_failure }
 *   action: 'click' | 'type' | 'shortcut' | 'wait' | 'screenshot' | 'verify'
 *
 * Schema (vision_targets): array of { name, target_description, expected_bbox? }
 * Schema (validations):    array of { type, expected }
 *   type: 'screenshot-match' | 'url-equals' | 'text-present' | 'element-visible'
 *
 * Endpoints:
 *   GET  /api/runbooks              -> list
 *   GET  /api/runbooks/:name        -> single runbook
 *   POST /api/runbooks              body { name, steps, vision_targets?, validations?, description?, goal_state? }
 *   PATCH /api/runbooks/:name/run-outcome  body { outcome }
 *
 * Replay is the AGENT's job (runbook.execute), not the conductor's. The
 * conductor only stores and serves runbooks here.
 *
 * Vision-first macro doctrine prerequisite. Shipped 29 Apr 2026
 * (fork_mojs0mm2_79180b).
 */
const express = require('express')
const router = express.Router()
const db = require('../config/db')
const logger = require('../config/logger')

const VALID_ACTIONS = new Set(['click', 'type', 'shortcut', 'wait', 'screenshot', 'verify'])

function _validateSteps(steps) {
  if (!Array.isArray(steps) || steps.length === 0) return 'steps must be a non-empty array'
  for (let i = 0; i < steps.length; i++) {
    const s = steps[i]
    if (!s || typeof s !== 'object') return `step ${i} must be an object`
    if (!VALID_ACTIONS.has(s.action)) return `step ${i}.action must be one of ${[...VALID_ACTIONS].join('|')}`
    if (s.params && typeof s.params !== 'object') return `step ${i}.params must be an object`
    if (s.on_failure && !['abort', 'retry', 'ask'].includes(s.on_failure)) return `step ${i}.on_failure must be abort|retry|ask`
  }
  return null
}

// List runbooks. Merges:
//   (a) conductor-side macro_runbooks (authored via POST /api/runbooks)
//   (b) agent-side runbook.list on the eos-laptop-agent (authored locally
//       on Corazon and not yet synced up).
// Each row includes step_count + vision_target_count for the visibility
// surface (Tate's "show me the macros" path). Source is 'conductor',
// 'agent', or 'both' so the renderer can flag drift.
router.get('/', async (_req, res) => {
  try {
    const dbRows = await db`
      SELECT
        name,
        version,
        authored_by,
        authored_at,
        last_run_at,
        last_run_outcome,
        description,
        goal_state,
        COALESCE(jsonb_array_length(steps), 0) AS step_count,
        COALESCE(jsonb_array_length(vision_targets), 0) AS vision_target_count
      FROM macro_runbooks
      ORDER BY authored_at DESC LIMIT 200
    `

    const merged = new Map()
    for (const r of dbRows) {
      merged.set(r.name, { ...r, source: 'conductor' })
    }

    // Best-effort merge of agent runbook.list. If the agent is unreachable,
    // the timer fires fast and we return conductor-only rows. Never fail
    // the visibility endpoint on a flaky tunnel.
    let agentReachable = false
    let agentError = null
    try {
      const agentRows = await _fetchAgentRunbooks(2500)
      agentReachable = true
      for (const a of agentRows) {
        const name = a.name || a.macro_name
        if (!name) continue
        const existing = merged.get(name)
        if (existing) {
          merged.set(name, {
            ...existing,
            source: 'both',
            agent_version: a.version ?? null,
            agent_last_run_at: a.last_run_at || a.lastRunAt || null,
            agent_last_run_outcome: a.last_run_outcome || a.lastRunOutcome || null,
          })
        } else {
          merged.set(name, {
            name,
            version: a.version ?? null,
            authored_by: a.authored_by || 'eos-agent',
            authored_at: a.authored_at || null,
            last_run_at: a.last_run_at || a.lastRunAt || null,
            last_run_outcome: a.last_run_outcome || a.lastRunOutcome || null,
            description: a.description || null,
            goal_state: a.goal_state || null,
            step_count: Array.isArray(a.steps) ? a.steps.length : (a.step_count ?? null),
            vision_target_count: Array.isArray(a.vision_targets)
              ? a.vision_targets.length
              : (a.vision_target_count ?? null),
            source: 'agent',
          })
        }
      }
    } catch (err) {
      agentError = err.message
      logger.warn('runbooks: agent runbook.list unreachable', { error: err.message })
    }

    const rows = Array.from(merged.values()).sort((a, b) => {
      const aT = a.authored_at ? new Date(a.authored_at).getTime() : 0
      const bT = b.authored_at ? new Date(b.authored_at).getTime() : 0
      return bT - aT
    })

    res.json({ rows, agent: { reachable: agentReachable, error: agentError } })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// Fetch agent-side runbooks via runbook.list on the eos-laptop-agent.
// Resolves to an array of runbook descriptors. Tolerant of multiple
// shapes the agent has shipped under (rows array, list array, or top-level).
async function _fetchAgentRunbooks(timeoutMs) {
  const fetch = global.fetch
  const [creds] = await db`SELECT value FROM kv_store WHERE key = 'creds.laptop_agent' LIMIT 1`
  if (!creds) throw new Error('creds.laptop_agent missing')
  // value column is text; some rows store JSON, others raw strings
  let parsed
  try {
    parsed = typeof creds.value === 'string' ? JSON.parse(creds.value) : creds.value
  } catch {
    throw new Error('creds.laptop_agent not JSON')
  }
  const ip = parsed.tailscale_ip
  const port = parsed.agent_port
  const token = parsed.agent_token
  if (!ip || !port || !token) throw new Error('creds.laptop_agent missing fields')

  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs || 2500)
  try {
    const r = await fetch(`http://${ip}:${port}/api/tool`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ tool: 'runbook.list', params: {} }),
      signal: ctrl.signal,
    })
    if (!r.ok) throw new Error(`agent HTTP ${r.status}`)
    const body = await r.json()
    // Accept: {ok, result:{rows:[...]}}, {result:[...]}, {rows:[...]}, [...]
    const result = body && body.result !== undefined ? body.result : body
    if (Array.isArray(result)) return result
    if (result && Array.isArray(result.rows)) return result.rows
    if (result && Array.isArray(result.list)) return result.list
    return []
  } finally {
    clearTimeout(timer)
  }
}

router.get('/:name', async (req, res) => {
  try {
    const [row] = await db`
      SELECT id, name, version, steps, vision_targets, validations,
             authored_by, authored_at, last_run_at, last_run_outcome,
             description, goal_state,
             COALESCE(jsonb_array_length(steps), 0) AS step_count,
             COALESCE(jsonb_array_length(vision_targets), 0) AS vision_target_count
      FROM macro_runbooks WHERE name = ${req.params.name}
    `
    if (!row) return res.status(404).json({ error: 'Not found' })
    res.json(row)
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// Save (insert or version-bump on conflict). authored_by=eos-agent by default.
router.post('/', async (req, res) => {
  try {
    const { name, steps, vision_targets, validations, authored_by, description, goal_state } = req.body || {}
    if (!name || typeof name !== 'string') return res.status(400).json({ error: 'name (string) required' })

    const stepsErr = _validateSteps(steps)
    if (stepsErr) return res.status(400).json({ error: stepsErr })

    const [existing] = await db`SELECT id, version FROM macro_runbooks WHERE name = ${name}`
    // postgres.js gotcha: when a string is bound for a jsonb cast, the
    // driver wraps it in JSON.stringify a second time (jsonb-typed text
    // serializer), producing a jsonb scalar string instead of the parsed
    // array. Pass the JS object/array directly to ${} so the driver's
    // jsonb serializer runs once. Same fix for vision_targets/validations.
    // Null is bound as SQL NULL with the ::jsonb cast preserved.
    let row
    if (existing) {
      ;[row] = await db`
        UPDATE macro_runbooks
        SET steps = ${steps}::jsonb,
            vision_targets = ${vision_targets || null}::jsonb,
            validations = ${validations || null}::jsonb,
            description = ${description || null},
            goal_state = ${goal_state || null},
            version = version + 1,
            authored_by = ${authored_by || 'eos-agent'},
            authored_at = NOW()
        WHERE id = ${existing.id}
        RETURNING id, name, version, authored_at
      `
    } else {
      ;[row] = await db`
        INSERT INTO macro_runbooks (name, steps, vision_targets, validations, description, goal_state, authored_by)
        VALUES (
          ${name},
          ${steps}::jsonb,
          ${vision_targets || null}::jsonb,
          ${validations || null}::jsonb,
          ${description || null},
          ${goal_state || null},
          ${authored_by || 'eos-agent'}
        )
        RETURNING id, name, version, authored_at
      `
    }
    res.json(row)
  } catch (err) {
    logger.error('runbooks: save error', { error: err.message })
    res.status(500).json({ error: err.message })
  }
})

router.patch('/:name/run-outcome', async (req, res) => {
  try {
    const { outcome } = req.body || {}
    if (!outcome || typeof outcome !== 'string') return res.status(400).json({ error: 'outcome (string) required' })
    const [row] = await db`
      UPDATE macro_runbooks
      SET last_run_at = NOW(), last_run_outcome = ${outcome}
      WHERE name = ${req.params.name}
      RETURNING name, last_run_at, last_run_outcome
    `
    if (!row) return res.status(404).json({ error: 'Not found' })
    res.json(row)
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

module.exports = router
