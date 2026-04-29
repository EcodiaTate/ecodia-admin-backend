/**
 * Cowork V2 MCP — peerage substrate route file.
 *
 * Mount: /api/mcp/cowork in src/app.js (after /api/hands).
 * Auth:  bearer from kv_store.creds.cowork_mcp_bearer via coworkAuth middleware.
 * Tools: 17 V2 endpoints + V1 alias (graph_semantic_search shim).
 *
 * Spec:  ~/ecodiaos/drafts/cowork-deep-integration-architecture-2026-04-30.md
 * Recon: ~/ecodiaos/drafts/cowork-mcp-v2-implementation-recon-2026-04-30.md
 *
 * Authored: 30 Apr 2026 by fork_mokmorc8_24edea (W2-B).
 */
'use strict'

const express = require('express')
const router = express.Router()

const db = require('../../config/db')
const logger = require('../../config/logger')
const { runQuery, runWrite } = require('../../config/neo4j')

const coworkAuth = require('../../middleware/coworkAuth')
const scope = require('../../services/coworkScope')
const audit = require('../../services/coworkAudit')
const idem = require('../../services/coworkIdempotency')
const inbox = require('../../services/coworkInbox')
const patterns = require('../../services/patternsRetrieval')
const neo4jRetrieval = require('../../services/neo4jRetrieval')
const crmService = require('../../services/crmService')
const messageQueue = require('../../services/messageQueue')
const forkService = require('../../services/forkService')
const osSession = require('../../services/osSessionService')

router.use(express.json({ limit: '2mb' }))

// Health probe (NO auth)
router.get('/_health', (_req, res) => {
  res.json({
    ok: true,
    service: 'cowork-mcp-v2',
    version: 2,
    endpoints: 17,
    v1_alias: true,
    mounted_at: new Date().toISOString(),
  })
})

router.use(coworkAuth)

// ── Helpers ──────────────────────────────────────────────────────────────
function _badRequest(res, message, details) {
  return res.status(400).json({ error: 'bad_request', message, details })
}
function _validationFail(res, message, details) {
  return res.status(422).json({ error: 'validation', message, details })
}
function _serverError(res, err) {
  logger.error('cowork-mcp: server error', { error: err.message, stack: err.stack })
  return res.status(500).json({ error: 'server_error', message: err.message })
}

function _parseKvValue(v) {
  if (v == null) return null
  if (typeof v !== 'string') return v
  try { return JSON.parse(v) } catch { return v }
}

async function withIdempotency(req, res, toolName, handler) {
  const key = req.body?.idempotency_key
  if (key) {
    const prior = await idem.check(key)
    if (prior) {
      res.setHeader('X-Cowork-Idempotency', 'replay')
      return res.json(prior)
    }
  }
  try {
    const response = await handler()
    if (key && response) {
      idem.record(key, toolName, response).catch(() => {})
    }
    return res.json(response)
  } catch (err) {
    if (err.httpStatus && err.code) {
      return res.status(err.httpStatus).json({ error: err.code, message: err.message, details: err.details })
    }
    return _serverError(res, err)
  }
}

async function _auditCountSince(toolName, sinceIso) {
  try {
    const [row] = await db`
      SELECT count(*)::int AS n
      FROM cowork_audit_log
      WHERE tool_name = ${toolName}
        AND occurred_at > ${sinceIso}
    `
    return row?.n || 0
  } catch {
    return 0
  }
}

// ── 1. status_board.query ────────────────────────────────────────────────
router.post('/status_board.query', scope.requireScope('read.status_board'), async (req, res) => {
  try {
    const filter = req.body?.filter || {}
    const limit = Math.max(1, Math.min(500, parseInt(req.body?.limit) || 50))
    const orderBy = req.body?.order_by || 'priority_asc'

    const archived = filter.archived === true
    const entity_type = filter.entity_type || null
    const next_action_by = filter.next_action_by || null
    const priority_lte = Number.isFinite(filter.priority_lte) ? filter.priority_lte : null
    const min_last_touched = filter.min_last_touched || null

    const orderClause = orderBy === 'last_touched_desc' ? db`ORDER BY last_touched DESC NULLS LAST`
                      : orderBy === 'due_asc'           ? db`ORDER BY next_action_due ASC NULLS LAST`
                      :                                    db`ORDER BY priority ASC NULLS LAST, last_touched DESC NULLS LAST`

    const rows = await db`
      SELECT id, entity_type, entity_ref, name, status, next_action, next_action_by,
             next_action_due, last_touched, context, priority, archived_at, source,
             cowork_session_id, created_at
      FROM status_board
      WHERE (${archived} OR archived_at IS NULL)
        AND (${entity_type}::text IS NULL OR entity_type = ${entity_type})
        AND (${next_action_by}::text IS NULL OR next_action_by = ${next_action_by})
        AND (${priority_lte}::int IS NULL OR priority <= ${priority_lte})
        AND (${min_last_touched}::timestamptz IS NULL OR last_touched >= ${min_last_touched})
      ${orderClause}
      LIMIT ${limit}
    `
    res.json({ rows, count: rows.length })
  } catch (err) {
    return _serverError(res, err)
  }
})

// ── 2. status_board.upsert ───────────────────────────────────────────────
router.post('/status_board.upsert', scope.requireScope('write.status_board.cowork_owned'), async (req, res) => {
  await withIdempotency(req, res, 'status_board.upsert', async () => {
    const b = req.body || {}
    const id = b.id || null
    const entity_type = b.entity_type
    const name = b.name
    const status = b.status
    const next_action = b.next_action ?? null
    const next_action_by = b.next_action_by ?? null
    const next_action_due = b.next_action_due ?? null
    const context = b.context ?? null
    const priority = Number.isFinite(b.priority) ? b.priority : 3
    const cowork_session_id = b.cowork_session_id ?? null

    const since = new Date(Date.now() - 86400_000).toISOString()
    const count = await _auditCountSince('status_board.upsert', since)
    if (count >= scope.RATE_CAPS.status_board_upsert_per_day) {
      throw Object.assign(new Error('rate_cap_exceeded'), {
        httpStatus: 429, code: 'rate_cap', details: { cap: scope.RATE_CAPS.status_board_upsert_per_day, window: '24h', current: count },
      })
    }

    if (b.archived_at !== undefined) {
      throw Object.assign(new Error('archived_at not settable via cowork upsert'), {
        httpStatus: 422, code: 'archived_at_locked',
      })
    }

    let row, action
    if (id) {
      const [existing] = await db`SELECT entity_type, next_action_by FROM status_board WHERE id = ${id}`
      if (!existing) {
        throw Object.assign(new Error('row not found'), { httpStatus: 404, code: 'not_found' })
      }
      if (!scope.statusBoardEntityTypeIsUpdatable(existing.entity_type)) {
        throw Object.assign(new Error(`cowork cannot update entity_type=${existing.entity_type}`), {
          httpStatus: 403, code: 'scope_denied',
          details: { entity_type: existing.entity_type, denied: scope.STATUS_BOARD_DENIED_UPDATE_TYPES },
        })
      }
      const result = await db`
        UPDATE status_board SET
          entity_type      = COALESCE(${entity_type ?? null}, entity_type),
          name             = COALESCE(${name ?? null}, name),
          status           = COALESCE(${status ?? null}, status),
          next_action      = COALESCE(${next_action}, next_action),
          next_action_by   = COALESCE(${next_action_by}, next_action_by),
          next_action_due  = COALESCE(${next_action_due}, next_action_due),
          context          = COALESCE(${context}, context),
          priority         = COALESCE(${priority}, priority),
          source           = 'cowork',
          cowork_session_id = COALESCE(${cowork_session_id}, cowork_session_id),
          last_touched     = NOW()
        WHERE id = ${id}
        RETURNING *
      `
      row = result[0]
      action = 'updated'
    } else {
      if (!entity_type || !name) {
        throw Object.assign(new Error('entity_type and name required for insert'), {
          httpStatus: 422, code: 'missing_fields',
        })
      }
      const result = await db`
        INSERT INTO status_board (
          entity_type, name, status, next_action, next_action_by, next_action_due,
          context, priority, source, cowork_session_id, last_touched
        ) VALUES (
          ${entity_type}, ${name}, ${status ?? null}, ${next_action}, ${next_action_by},
          ${next_action_due}, ${context}, ${priority}, 'cowork', ${cowork_session_id}, NOW()
        )
        RETURNING *
      `
      row = result[0]
      action = 'inserted'
    }

    audit.logWrite(req, 'status_board.upsert', {
      scope_used: 'write.status_board.cowork_owned',
      cowork_session_id,
      affected_substrate: 'status_board',
      affected_row_ref: row?.id,
      request_summary: { entity_type, name, action },
      response_summary: { action, row_id: row?.id },
    })

    return { row, action, archived: !!row.archived_at }
  })
})

// ── 3. kv_store.get ──────────────────────────────────────────────────────
router.post('/kv_store.get', scope.requireScope('read.kv_store'), async (req, res) => {
  try {
    const b = req.body || {}
    if (b.keys && Array.isArray(b.keys)) {
      const allowed = b.keys.filter(k => scope.kvKeyIsReadable(k))
      const denied = b.keys.filter(k => !scope.kvKeyIsReadable(k))
      const rows = allowed.length ? await db`
        SELECT key, value, updated_at FROM kv_store WHERE key = ANY(${allowed})
      ` : []
      const parsed = rows.map(r => ({ key: r.key, value: _parseKvValue(r.value), updated_at: r.updated_at }))
      return res.json({ rows: parsed, denied })
    }
    if (typeof b.key !== 'string' || !b.key) {
      return _badRequest(res, 'key (string) or keys (array) required')
    }
    if (!scope.kvKeyIsReadable(b.key)) {
      return res.status(403).json({ error: 'scope_denied', message: 'key prefix is read-deny', details: { key: b.key } })
    }
    const [row] = await db`SELECT key, value, updated_at FROM kv_store WHERE key = ${b.key}`
    if (!row) return res.status(404).json({ error: 'not_found', message: `key not found: ${b.key}` })
    res.json({ key: row.key, value: _parseKvValue(row.value), updated_at: row.updated_at })
  } catch (err) {
    return _serverError(res, err)
  }
})

// ── 4. kv_store.set ──────────────────────────────────────────────────────
router.post('/kv_store.set', scope.requireScope('write.kv_store.cowork_namespace'), async (req, res) => {
  await withIdempotency(req, res, 'kv_store.set', async () => {
    const b = req.body || {}
    if (typeof b.key !== 'string' || !b.key) {
      throw Object.assign(new Error('key required'), { httpStatus: 400, code: 'invalid_key' })
    }
    if (!scope.kvKeyIsWritable(b.key)) {
      throw Object.assign(new Error(`key outside cowork namespace: ${b.key}`), {
        httpStatus: 403, code: 'scope_denied',
        details: { allowed_prefixes: scope.KV_WRITE_NAMESPACES },
      })
    }
    if (b.value === undefined) {
      throw Object.assign(new Error('value required'), { httpStatus: 400, code: 'invalid_value' })
    }
    const valueJson = JSON.stringify(b.value)
    const result = await db`
      INSERT INTO kv_store (key, value, updated_at)
      VALUES (${b.key}, ${valueJson}, NOW())
      ON CONFLICT (key) DO UPDATE
        SET value = EXCLUDED.value, updated_at = NOW()
      RETURNING key, value, updated_at, (xmax = 0) AS inserted
    `
    const row = result[0]
    const action = row.inserted ? 'inserted' : 'updated'

    audit.logWrite(req, 'kv_store.set', {
      scope_used: 'write.kv_store.cowork_namespace',
      cowork_session_id: b.cowork_session_id,
      affected_substrate: 'kv_store',
      affected_row_ref: b.key,
      request_summary: { key: b.key, action },
      response_summary: { action },
    })

    return { key: row.key, value: _parseKvValue(row.value), updated_at: row.updated_at, action }
  })
})

// ── 5. neo4j.search ──────────────────────────────────────────────────────
const WRITE_KEYWORD_REGEX = /\b(CREATE|MERGE|SET|DELETE|REMOVE|DROP|CALL\s+\S+\s+WRITE)\b/i

router.post('/neo4j.search', scope.requireScope('read.neo4j'), async (req, res) => {
  try {
    const b = req.body || {}
    const mode = b.mode || 'semantic'
    const limit = Math.max(1, Math.min(100, parseInt(b.limit) || 20))
    const labels = Array.isArray(b.labels) && b.labels.length > 0 ? b.labels : undefined

    if (mode === 'semantic') {
      const results = await neo4jRetrieval.semanticSearch(b.query || '', { limit, labels, minScore: b.min_score })
      return res.json({ results, count: results.length, mode })
    }
    if (mode === 'substring' || mode === 'keyword') {
      const results = await neo4jRetrieval._internal.keywordSearch(b.query || '', { limit, labels })
      return res.json({ results, count: results.length, mode })
    }
    if (mode === 'cypher') {
      const cypher = b.cypher || ''
      if (!cypher) return _badRequest(res, 'cypher required when mode=cypher')
      const stripped = cypher.replace(/'[^']*'|"[^"]*"/g, '')
      if (WRITE_KEYWORD_REGEX.test(stripped)) {
        return _validationFail(res, 'cypher mode is read-only; write keywords (CREATE/MERGE/SET/DELETE/REMOVE/DROP) detected')
      }
      const records = await runQuery(cypher, b.params || {})
      const results = records.map(r => {
        const out = {}
        for (const k of r.keys) {
          const v = r.get(k)
          if (v && typeof v === 'object' && v.properties) out[k] = { ...v.properties, _labels: v.labels || [] }
          else out[k] = v
        }
        return out
      })
      return res.json({ results, count: results.length, mode })
    }
    return _badRequest(res, `unknown mode: ${mode}`)
  } catch (err) {
    return _serverError(res, err)
  }
})

// V1 alias
router.post('/graph_semantic_search', scope.requireScope('read.neo4j'), async (req, res) => {
  try {
    const b = req.body || {}
    const text = b.text || b.query || ''
    const limit = Math.max(1, Math.min(100, parseInt(b.limit) || 10))
    const minScore = Number.isFinite(b.min_score) ? b.min_score : 0.7
    const labels = b.label ? [b.label] : undefined
    const results = await neo4jRetrieval.semanticSearch(text, { limit, labels, minScore })
    res.json({ results, count: results.length, _v1_alias: true })
  } catch (err) {
    return _serverError(res, err)
  }
})

// ── 6. neo4j.write_episode ───────────────────────────────────────────────
router.post('/neo4j.write_episode', scope.requireScope('write.neo4j.episode'), async (req, res) => {
  await withIdempotency(req, res, 'neo4j.write_episode', async () => {
    const b = req.body || {}
    if (!b.name) throw Object.assign(new Error('name required'), { httpStatus: 422, code: 'missing_name' })
    const type = b.type || 'cowork_dispatch'
    if (!scope.NEO4J_EPISODE_TYPES.includes(type)) {
      throw Object.assign(new Error(`invalid type: ${type}`), {
        httpStatus: 422, code: 'invalid_type',
        details: { allowed: scope.NEO4J_EPISODE_TYPES },
      })
    }
    const props = {
      name: b.name,
      description: b.description || '',
      type,
      transcript_excerpt: (b.transcript_excerpt || '').slice(0, 4000),
      cowork_session_id: b.cowork_session_id || null,
      source: 'cowork',
      authored_by: 'cowork',
    }
    const records = await runWrite(
      `MERGE (e:Episode {name: $name})
       ON CREATE SET e += $props, e.created_at = datetime()
       ON MATCH  SET e += $props, e.updated_at = datetime()
       RETURN id(e) AS id, e`,
      { name: b.name, props }
    )
    const node_id = records[0]?.get('id')?.toNumber?.() ?? records[0]?.get('id') ?? null

    let relationships_created = 0
    if (Array.isArray(b.related_entities)) {
      for (const rel of b.related_entities) {
        if (!rel?.label || !rel?.name || !rel?.rel_type) continue
        try {
          await runWrite(
            `MATCH (e:Episode {name: $epName})
             MERGE (n:\`${rel.label.replace(/[^A-Za-z0-9_]/g, '')}\` {name: $relName})
             MERGE (e)-[r:\`${rel.rel_type.replace(/[^A-Za-z0-9_]/g, '')}\`]->(n)
             RETURN type(r)`,
            { epName: b.name, relName: rel.name }
          )
          relationships_created++
        } catch (relErr) {
          logger.warn('neo4j.write_episode: relationship failed', { error: relErr.message, rel })
        }
      }
    }

    audit.logWrite(req, 'neo4j.write_episode', {
      scope_used: 'write.neo4j.episode',
      cowork_session_id: b.cowork_session_id,
      affected_substrate: 'neo4j',
      affected_row_ref: b.name,
      request_summary: { name: b.name, type, related_entities_count: (b.related_entities || []).length },
      response_summary: { node_id, relationships_created },
    })

    return { node_id, name: b.name, created_at: new Date().toISOString(), relationships_created }
  })
})

// ── 7. neo4j.write_decision ──────────────────────────────────────────────
router.post('/neo4j.write_decision', scope.requireScope('write.neo4j.decision'), async (req, res) => {
  await withIdempotency(req, res, 'neo4j.write_decision', async () => {
    const b = req.body || {}
    if (!b.name) throw Object.assign(new Error('name required'), { httpStatus: 422, code: 'missing_name' })

    let supersedes_archived = false
    if (b.supersedes) {
      try {
        const supRecords = await runQuery(
          `MATCH (d:Decision {name: $supName})
           RETURN coalesce(d.authored_by, 'conductor') AS authored_by`,
          { supName: b.supersedes }
        )
        const authoredBy = supRecords[0]?.get('authored_by')
        if (authoredBy && authoredBy !== 'cowork') {
          throw Object.assign(new Error(`cowork cannot supersede non-cowork Decision (${authoredBy})`), {
            httpStatus: 403, code: 'supersede_denied',
            details: { supersedes: b.supersedes, authored_by: authoredBy },
          })
        }
        await runWrite(
          `MATCH (d:Decision {name: $supName})
           SET d.archived_at = datetime(), d.superseded_by = $newName
           RETURN d`,
          { supName: b.supersedes, newName: b.name }
        )
        supersedes_archived = true
      } catch (supErr) {
        if (supErr.httpStatus) throw supErr
        logger.warn('neo4j.write_decision: supersede failed', { error: supErr.message })
      }
    }

    const props = {
      name: b.name,
      description: b.description || '',
      rationale: b.rationale || '',
      supersedes: b.supersedes || null,
      cowork_session_id: b.cowork_session_id || null,
      authored_by: 'cowork',
      source: 'cowork',
    }
    const records = await runWrite(
      `MERGE (d:Decision {name: $name})
       ON CREATE SET d += $props, d.date = date(), d.created_at = datetime()
       ON MATCH  SET d += $props, d.updated_at = datetime()
       RETURN id(d) AS id, d`,
      { name: b.name, props }
    )
    const node_id = records[0]?.get('id')?.toNumber?.() ?? records[0]?.get('id') ?? null

    audit.logWrite(req, 'neo4j.write_decision', {
      scope_used: 'write.neo4j.decision',
      cowork_session_id: b.cowork_session_id,
      affected_substrate: 'neo4j',
      affected_row_ref: b.name,
      request_summary: { name: b.name, supersedes: b.supersedes },
      response_summary: { node_id, supersedes_archived },
    })

    return { node_id, name: b.name, created_at: new Date().toISOString(), supersedes_archived }
  })
})

// ── 8. forks.spawn ───────────────────────────────────────────────────────
router.post('/forks.spawn', scope.requireScope('write.forks.cowork_pool'), async (req, res) => {
  try {
    const b = req.body || {}
    if (!b.brief) {
      return _badRequest(res, 'brief required')
    }
    const context_mode = b.context_mode || 'recent'

    const since = new Date(Date.now() - 86400_000).toISOString()
    const count = await _auditCountSince('forks.spawn', since)
    if (count >= scope.RATE_CAPS.forks_spawn_per_day) {
      return res.status(429).json({
        error: 'rate_cap',
        message: 'forks.spawn day cap reached',
        details: { cap: scope.RATE_CAPS.forks_spawn_per_day, window: '24h', current: count },
      })
    }

    const [{ active }] = await db`
      SELECT count(*)::int AS active FROM os_forks
      WHERE parent = 'cowork' AND status IN ('spawning','running','reporting')
    `
    if (active >= scope.COWORK_FORK_CAP) {
      return res.status(429).json({
        error: 'cowork_pool_full',
        message: 'cowork-pool fork cap reached',
        details: { cap: scope.COWORK_FORK_CAP, active },
      })
    }

    const snap = await forkService.spawnFork({ brief: b.brief, context_mode })
    if (snap?.fork_id) {
      try {
        await db`
          UPDATE os_forks SET parent = 'cowork', cowork_session_id = ${b.cowork_session_id || null}
          WHERE fork_id = ${snap.fork_id}
        `
      } catch (uErr) {
        logger.warn('forks.spawn: parent UPDATE failed (non-fatal)', { error: uErr.message })
      }
    }

    audit.logWrite(req, 'forks.spawn', {
      scope_used: 'write.forks.cowork_pool',
      cowork_session_id: b.cowork_session_id,
      affected_substrate: 'os_forks',
      affected_row_ref: snap.fork_id,
      request_summary: { brief_chars: b.brief.length, context_mode },
      response_summary: { fork_id: snap.fork_id, status: snap.status },
    })

    res.json({
      fork_id: snap.fork_id,
      status: snap.status,
      position: snap.position,
      started_at: snap.started_at,
      cowork_pool_active: active + 1,
      cowork_pool_cap: scope.COWORK_FORK_CAP,
    })
  } catch (err) {
    if (err.httpStatus && err.code) {
      return res.status(err.httpStatus).json({ error: err.code, message: err.message, details: err.details })
    }
    return _serverError(res, err)
  }
})

// ── 9. forks.list ────────────────────────────────────────────────────────
router.post('/forks.list', scope.requireScope('read.forks'), async (req, res) => {
  try {
    const b = req.body || {}
    const filter = b.filter || {}
    const limit = Math.max(1, Math.min(200, parseInt(b.limit) || 50))
    const parent = filter.parent === '*' ? null : (filter.parent || 'cowork')
    const status = filter.status || null

    const rows = parent
      ? (status
        ? await db`
            SELECT fork_id, parent_id, brief, context_mode, status, position, provider,
                   tokens_input, tokens_output, tool_calls, current_tool,
                   started_at, ended_at, parent, cowork_session_id
            FROM os_forks WHERE parent = ${parent} AND status = ${status}
            ORDER BY started_at DESC LIMIT ${limit}
          `
        : await db`
            SELECT fork_id, parent_id, brief, context_mode, status, position, provider,
                   tokens_input, tokens_output, tool_calls, current_tool,
                   started_at, ended_at, parent, cowork_session_id
            FROM os_forks WHERE parent = ${parent}
            ORDER BY started_at DESC LIMIT ${limit}
          `)
      : (status
        ? await db`
            SELECT fork_id, parent_id, brief, context_mode, status, position, provider,
                   tokens_input, tokens_output, tool_calls, current_tool,
                   started_at, ended_at, parent, cowork_session_id
            FROM os_forks WHERE status = ${status}
            ORDER BY started_at DESC LIMIT ${limit}
          `
        : await db`
            SELECT fork_id, parent_id, brief, context_mode, status, position, provider,
                   tokens_input, tokens_output, tool_calls, current_tool,
                   started_at, ended_at, parent, cowork_session_id
            FROM os_forks
            ORDER BY started_at DESC LIMIT ${limit}
          `)
    res.json({ forks: rows, count: rows.length })
  } catch (err) {
    return _serverError(res, err)
  }
})

// ── 10. patterns.semantic_search ─────────────────────────────────────────
router.post('/patterns.semantic_search', scope.requireScope('read.patterns'), async (req, res) => {
  try {
    const b = req.body || {}
    if (!b.query) return _badRequest(res, 'query required')
    const limit = Math.max(1, Math.min(50, parseInt(b.limit) || 10))
    const matches = await patterns.semanticSearch(b.query, { limit })
    res.json({ matches, count: matches.length })
  } catch (err) {
    return _serverError(res, err)
  }
})

// ── 11. email_threads.read ───────────────────────────────────────────────
router.post('/email_threads.read', scope.requireScope('read.email_threads'), async (req, res) => {
  try {
    const b = req.body || {}
    const filter = b.filter || {}
    const limit = Math.max(1, Math.min(100, parseInt(b.limit) || 20))
    const fromContains = filter.from_contains || null
    const since = filter.since || null
    const threadId = filter.thread_id || null
    const clientId = filter.client_id || null
    const triagePriority = filter.triage_priority || null
    const inboxColumn = filter.inbox || null

    const rows = await db`
      SELECT id, gmail_thread_id, subject, from_email, from_name, snippet,
             labels, client_id, triage_priority, triage_summary, status,
             received_at, created_at,
             array_length(gmail_message_ids, 1) AS message_count
      FROM email_threads
      WHERE (${fromContains}::text IS NULL OR from_email ILIKE ${'%' + (fromContains || '') + '%'})
        AND (${since}::timestamptz IS NULL OR received_at >= ${since})
        AND (${threadId}::text IS NULL OR gmail_thread_id = ${threadId})
        AND (${clientId}::uuid IS NULL OR client_id = ${clientId})
        AND (${triagePriority}::text IS NULL OR triage_priority = ${triagePriority})
        AND (${inboxColumn}::text IS NULL OR labels @> ARRAY[${inboxColumn}])
      ORDER BY received_at DESC NULLS LAST
      LIMIT ${limit}
    `
    res.json({ threads: rows, count: rows.length })
  } catch (err) {
    return _serverError(res, err)
  }
})

// ── 12. crm.get_intelligence ─────────────────────────────────────────────
router.post('/crm.get_intelligence', scope.requireScope('read.crm'), async (req, res) => {
  try {
    const b = req.body || {}
    let clientId = b.client_id

    if (!clientId && (b.client_slug || b.search)) {
      const term = b.client_slug || b.search
      const [row] = await db`
        SELECT id FROM clients
        WHERE name ILIKE ${'%' + term + '%'} OR slug = ${term}
        ORDER BY status = 'active' DESC
        LIMIT 1
      `
      clientId = row?.id
    }
    if (!clientId) {
      return res.status(404).json({ error: 'not_found', message: 'no client matched lookup' })
    }
    const intel = await crmService.getClientIntelligence(clientId)
    if (!intel) return res.status(404).json({ error: 'not_found', message: 'client not found' })
    res.json(intel)
  } catch (err) {
    return _serverError(res, err)
  }
})

// ── 13. os_session.message ───────────────────────────────────────────────
router.post('/os_session.message', scope.requireScope('write.os_session.message'), async (req, res) => {
  try {
    const b = req.body || {}
    if (!b.message || typeof b.message !== 'string') {
      return _badRequest(res, 'message (string) required')
    }
    const mode = b.mode || 'queue'
    const cowork_session_id = b.cowork_session_id || null

    const since = new Date(Date.now() - 3600_000).toISOString()
    const count = await _auditCountSince('os_session.message', since)
    if (count >= scope.RATE_CAPS.os_session_message_per_hour) {
      return res.status(429).json({
        error: 'rate_cap',
        message: 'os_session.message hour cap reached',
        details: { cap: scope.RATE_CAPS.os_session_message_per_hour, window: '1h', current: count },
      })
    }

    const stamped = `[from-cowork${cowork_session_id ? ':' + cowork_session_id : ''}] ${b.message}`

    let response
    if (mode === 'queue') {
      const row = await messageQueue.enqueueMessage({
        body: stamped,
        source: 'cowork',
        mode: 'queue',
      })
      response = { accepted: true, queued_id: row.id, queued_at: row.queued_at, mode }
    } else if (mode === 'direct') {
      osSession.sendMessage(stamped, { priority: false }).catch(err => {
        logger.error('cowork-mcp: os_session.message direct send failed', { error: err.message })
      })
      response = { accepted: true, status: 'streaming', mode }
    } else {
      return _badRequest(res, `unknown mode: ${mode} (expected queue|direct)`)
    }

    audit.logWrite(req, 'os_session.message', {
      scope_used: 'write.os_session.message',
      cowork_session_id,
      affected_substrate: mode === 'queue' ? 'message_queue' : 'os_session',
      affected_row_ref: response.queued_id || 'direct-stream',
      request_summary: { mode, message_chars: b.message.length },
      response_summary: { accepted: true, mode },
    })

    res.json(response)
  } catch (err) {
    return _serverError(res, err)
  }
})

// ── 14. cowork.log_session ───────────────────────────────────────────────
router.post('/cowork.log_session', scope.requireScope('write.cowork.session_log'), async (req, res) => {
  await withIdempotency(req, res, 'cowork.log_session', async () => {
    const b = req.body || {}
    if (!b.cowork_session_id) {
      throw Object.assign(new Error('cowork_session_id required'), { httpStatus: 422, code: 'missing_session_id' })
    }
    await db`
      INSERT INTO cowork_sessions (session_id, started_at, intent, ended_at, outcome, outcome_reason)
      VALUES (
        ${b.cowork_session_id},
        ${b.started_at || new Date().toISOString()},
        ${b.transcript_summary || null},
        ${b.ended_at || new Date().toISOString()},
        ${b.outcome || 'completed'},
        ${b.outcome_reason || null}
      )
      ON CONFLICT (session_id) DO UPDATE SET
        ended_at       = COALESCE(EXCLUDED.ended_at, cowork_sessions.ended_at),
        outcome        = COALESCE(EXCLUDED.outcome, cowork_sessions.outcome),
        outcome_reason = COALESCE(EXCLUDED.outcome_reason, cowork_sessions.outcome_reason)
    `

    const episodeName = `Cowork session ${b.cowork_session_id} — ${b.outcome || 'completed'}`
    const props = {
      name: episodeName,
      description: (b.transcript_summary || '').slice(0, 4000),
      type: 'cowork_dispatch',
      cowork_session_id: b.cowork_session_id,
      tools_called: Array.isArray(b.tools_called) ? b.tools_called : [],
      transcript_full_url: b.transcript_full_url || null,
      outcome: b.outcome || 'completed',
      authored_by: 'cowork',
      source: 'cowork',
    }
    let episode_node_id = null
    try {
      const records = await runWrite(
        `MERGE (e:Episode {name: $name})
         ON CREATE SET e += $props, e.created_at = datetime()
         ON MATCH  SET e += $props, e.updated_at = datetime()
         RETURN id(e) AS id`,
        { name: episodeName, props }
      )
      episode_node_id = records[0]?.get('id')?.toNumber?.() ?? records[0]?.get('id') ?? null
    } catch (neoErr) {
      logger.warn('cowork.log_session: neo4j write failed (non-fatal)', { error: neoErr.message })
    }

    audit.logWrite(req, 'cowork.log_session', {
      scope_used: 'write.cowork.session_log',
      cowork_session_id: b.cowork_session_id,
      affected_substrate: 'cowork_sessions',
      affected_row_ref: b.cowork_session_id,
      request_summary: { outcome: b.outcome, tools_called_count: (b.tools_called || []).length },
      response_summary: { episode_node_id },
    })

    return { logged: true, episode_node_id, cowork_session_id: b.cowork_session_id }
  })
})

// ── 15. cowork.heartbeat ─────────────────────────────────────────────────
router.post('/cowork.heartbeat', scope.requireScope('write.cowork.heartbeat'), async (req, res) => {
  try {
    const b = req.body || {}
    if (!b.cowork_session_id) {
      return _validationFail(res, 'cowork_session_id required')
    }
    const status = b.status || 'active'
    if (!['active', 'idle', 'thinking'].includes(status)) {
      return _validationFail(res, `status must be active|idle|thinking, got: ${status}`)
    }
    const payload = {
      cowork_session_id: b.cowork_session_id,
      status,
      current_action: b.current_action || null,
      ts: new Date().toISOString(),
    }
    await db`
      INSERT INTO kv_store (key, value, updated_at)
      VALUES ('cowork.last_heartbeat', ${JSON.stringify(payload)}, NOW())
      ON CONFLICT (key) DO UPDATE
        SET value = EXCLUDED.value, updated_at = NOW()
    `

    try {
      const { broadcast } = require('../../websocket/wsManager')
      broadcast('cowork:heartbeat', payload)
    } catch (wsErr) {
      logger.debug('cowork.heartbeat: ws broadcast failed (non-fatal)', { error: wsErr.message })
    }

    const [{ n }] = await db`SELECT count(*)::int AS n FROM cowork_inbox WHERE acked_at IS NULL`

    audit.logWrite(req, 'cowork.heartbeat', {
      scope_used: 'write.cowork.heartbeat',
      cowork_session_id: b.cowork_session_id,
      affected_substrate: 'kv_store',
      affected_row_ref: 'cowork.last_heartbeat',
      request_summary: { status, current_action_chars: (b.current_action || '').length },
      response_summary: { inbox_count: n },
    })

    res.json({
      ack: true,
      conductor_inbox_count: n,
      suggested_action: n > 0 ? 'pull-from-cowork-queue' : null,
    })
  } catch (err) {
    return _serverError(res, err)
  }
})

// ── 16. cowork.session_started ───────────────────────────────────────────
router.post('/cowork.session_started', scope.requireScope('write.cowork.session_log'), async (req, res) => {
  try {
    const b = req.body || {}
    if (!b.cowork_session_id) {
      return _validationFail(res, 'cowork_session_id required')
    }
    const initiated_by = b.initiated_by || 'cowork-self'
    if (!['cowork-self', 'conductor-dispatched', 'tate-dispatched'].includes(initiated_by)) {
      return _validationFail(res, `initiated_by must be cowork-self|conductor-dispatched|tate-dispatched`)
    }
    const [row] = await db`
      INSERT INTO cowork_sessions (session_id, started_at, intent, initiated_by)
      VALUES (${b.cowork_session_id}, NOW(), ${b.intent || null}, ${initiated_by})
      ON CONFLICT (session_id) DO UPDATE SET
        intent = COALESCE(EXCLUDED.intent, cowork_sessions.intent),
        initiated_by = COALESCE(EXCLUDED.initiated_by, cowork_sessions.initiated_by)
      RETURNING session_id, started_at, initiated_by
    `

    audit.logWrite(req, 'cowork.session_started', {
      scope_used: 'write.cowork.session_log',
      cowork_session_id: b.cowork_session_id,
      affected_substrate: 'cowork_sessions',
      affected_row_ref: b.cowork_session_id,
      request_summary: { initiated_by, intent_chars: (b.intent || '').length },
      response_summary: { registered: true },
    })

    res.json({ registered: true, ...row })
  } catch (err) {
    return _serverError(res, err)
  }
})

// ── 17. inbox.read ───────────────────────────────────────────────────────
router.post('/inbox.read', scope.requireScope('read.cowork.inbox'), async (req, res) => {
  try {
    const b = req.body || {}
    const limit = Math.max(1, Math.min(100, parseInt(b.limit) || 20))
    const ack = !!b.ack
    const since = b.since || null
    const messages = await inbox.read({ since, limit, ack })
    res.json({ messages, count: messages.length })
  } catch (err) {
    return _serverError(res, err)
  }
})

module.exports = router
