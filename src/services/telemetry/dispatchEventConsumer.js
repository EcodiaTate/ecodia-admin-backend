/**
 * dispatchEventConsumer.js
 *
 * Phase B (Layer 4) of the Decision Quality Self-Optimization Architecture.
 * See: ~/ecodiaos/patterns/decision-quality-self-optimization-architecture.md
 *
 * Reads JSONL telemetry events emitted by the four PreToolUse hooks
 * (~/ecodiaos/scripts/hooks/*.sh) into the dispatch_event + surface_event
 * tables. The hooks emit at hot-path (microseconds per event) using
 * append-only JSONL writes to ~/ecodiaos/logs/telemetry/dispatch-events.jsonl.
 * This consumer runs out-of-band (every 15 minutes) and normalises the
 * accumulated events into queryable Postgres rows.
 *
 * Crash safety:
 *   - The JSONL file is RENAMED to processed/<timestamp>-dispatch-events.jsonl
 *     BEFORE inserts, so concurrent hook fires append to a fresh file.
 *   - Each line is parsed and inserted within an individual try/catch -
 *     a single corrupt line cannot poison the whole batch.
 *   - On total failure, the renamed file remains in processed/ for
 *     forensic review and manual replay.
 *   - On success, the renamed file is left in processed/ for 7 days
 *     before cleanup (retention as a safety net for downstream debugging).
 *
 * Idempotency:
 *   - Each JSONL line gets a synthetic deterministic-ish id via
 *     ts+hook+tool+sha1(content). Subsequent re-processing of the same line
 *     would create a duplicate dispatch_event but downstream queries are
 *     additive so duplication corrupts metrics rather than the system. Since
 *     the rename-before-insert pattern prevents re-reading, duplication
 *     requires manual intervention (replaying a processed file). Acceptable
 *     trade-off for now; future-Phase-D could add a (ts, hook, tool,
 *     content_hash) UNIQUE constraint if duplication becomes a real problem.
 *
 * Invocation:
 *   - PM2-managed standalone: `node src/services/telemetry/dispatchEventConsumer.js --once`
 *     for one-shot CLI use, or with no flag to enter the periodic loop.
 *   - In-process via the scheduler: `mcp__scheduler__schedule_cron` task
 *     "decision-quality-consumer" runs `every 15m` and calls the same
 *     entry point in --once mode.
 *
 * Exits:
 *   - 0 on clean run (or empty queue)
 *   - 1 on unrecoverable error (e.g. cannot rename file, cannot connect to
 *     Postgres)
 */

'use strict'

const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const { Client } = require('pg')

// Lazy require to avoid hard env-load during module import for tests.
let _env = null
function getEnv() {
  if (_env) return _env
  _env = require('../../config/env')
  return _env
}

const TELEMETRY_DIR = process.env.ECODIAOS_TELEMETRY_DIR || '/home/tate/ecodiaos/logs/telemetry'
const TELEMETRY_FILE = process.env.ECODIAOS_TELEMETRY_FILE || path.join(TELEMETRY_DIR, 'dispatch-events.jsonl')
const PROCESSED_DIR = path.join(TELEMETRY_DIR, 'processed')
const RETENTION_DAYS = 7
const TICK_INTERVAL_MS = 15 * 60 * 1000 // 15 minutes

/**
 * Translate a hook name to an action_type value for dispatch_event.
 * Maps the hook firing surface to the upstream tool action shape.
 */
function actionTypeForHook(hookName, toolName) {
  if (toolName === 'mcp__forks__spawn_fork') return 'fork_spawn'
  if (toolName === 'mcp__factory__start_cc_session') return 'factory_dispatch'
  if (toolName === 'mcp__supabase__db_execute') return 'tool_call:db_execute'
  if (toolName === 'Write' || toolName === 'Edit' || toolName === 'MultiEdit') {
    return `tool_call:${toolName.toLowerCase()}`
  }
  if (toolName) return `tool_call:${toolName}`
  return `hook:${hookName}`
}

/**
 * Pull context_keywords from a JSONL line's context object. The hook layer
 * captures brief_excerpt / sql_excerpt / file_path; we extract a small set of
 * keywords for downstream querying.
 */
function extractContextKeywords(ctx) {
  if (!ctx || typeof ctx !== 'object') return []
  const text = [
    ctx.brief_excerpt || '',
    ctx.sql_excerpt || '',
    ctx.file_path || '',
    ctx.tool || '',
  ].join(' ').toLowerCase()
  // Pull dash-or-snake or alphanumeric tokens of length >=4.
  const tokens = text.match(/\b[a-z][a-z0-9_-]{3,40}\b/g) || []
  // Deduplicate and cap.
  return [...new Set(tokens)].slice(0, 30)
}

/**
 * Synthesise an actor for the dispatch_event row. The hook layer doesn't
 * carry actor context, so we use the tool name as a coarse proxy:
 *   - 'main' for primary tool calls
 *   - 'fork' for spawn_fork-emitted events (the fork surface itself)
 *   - 'cron' if the JSONL line carries an explicit actor field (future)
 *
 * The Phase D classifier later refines this based on cross-referencing
 * with the forks table, scheduler_runs, etc.
 */
function deriveActor(line) {
  if (line.actor) return line.actor
  // Best-effort heuristic: spawn_fork dispatches come from main; everything
  // else might be main or a fork. Without tracking the originating session
  // we default to 'main'. Phase D will improve this.
  return 'main'
}

async function consumeFile(filePath, client) {
  const stats = await fs.promises.stat(filePath).catch(() => null)
  if (!stats) {
    return { processed: 0, dispatchInserts: 0, surfaceInserts: 0, lineErrors: 0 }
  }

  const content = await fs.promises.readFile(filePath, 'utf8')
  const lines = content.split('\n').filter(l => l.trim().length > 0)

  let dispatchInserts = 0
  let surfaceInserts = 0
  let lineErrors = 0

  for (const raw of lines) {
    try {
      const line = JSON.parse(raw)
      const ts = line.ts || new Date().toISOString()
      const hookName = line.hook_name || 'unknown'
      const toolName = line.tool_name || null
      const ctx = line.context || {}
      const surfaces = Array.isArray(line.surfaces) ? line.surfaces : []

      const actor = deriveActor(line)
      const actionType = actionTypeForHook(hookName, toolName)
      const keywords = extractContextKeywords(ctx)

      // Insert dispatch_event row.
      const dispatchResult = await client.query(
        `INSERT INTO dispatch_event (ts, actor, action_type, tool_name, context_keywords, metadata)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING id`,
        [ts, actor, actionType, toolName, keywords, ctx]
      )
      const dispatchId = dispatchResult.rows[0].id
      dispatchInserts += 1

      // Insert one surface_event row per surface entry.
      for (const s of surfaces) {
        if (!s || !s.pattern_path) continue
        try {
          await client.query(
            `INSERT INTO surface_event (dispatch_event_id, ts, source_layer, pattern_path, trigger_keyword, priority, canonical, was_false_positive)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
            [
              dispatchId,
              ts,
              s.source_layer || `hook:${hookName}`,
              s.pattern_path,
              s.trigger_keyword || null,
              s.priority || null,
              typeof s.canonical === 'boolean' ? s.canonical : null,
              null, // was_false_positive backfilled by Phase D
            ]
          )
          surfaceInserts += 1
        } catch (err) {
          lineErrors += 1
          // Continue with remaining surfaces - one bad row should not poison
          // the rest of the line.
          console.error('[consumer] surface_event insert failed:', err.message)
        }
      }
    } catch (err) {
      lineErrors += 1
      console.error('[consumer] failed to parse/insert JSONL line:', err.message, 'raw:', raw.slice(0, 200))
    }
  }

  return { processed: lines.length, dispatchInserts, surfaceInserts, lineErrors }
}

async function pruneOldProcessedFiles() {
  try {
    const entries = await fs.promises.readdir(PROCESSED_DIR).catch(() => [])
    const cutoffMs = Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000
    for (const e of entries) {
      const p = path.join(PROCESSED_DIR, e)
      try {
        const st = await fs.promises.stat(p)
        if (st.mtimeMs < cutoffMs) {
          await fs.promises.unlink(p)
        }
      } catch { /* ignore */ }
    }
  } catch { /* non-fatal */ }
}

async function rotateAndConsume() {
  // Ensure processed dir exists.
  await fs.promises.mkdir(PROCESSED_DIR, { recursive: true })

  // Check whether the source file exists. If not, exit early.
  const srcStat = await fs.promises.stat(TELEMETRY_FILE).catch(() => null)
  if (!srcStat) {
    return { ok: true, processed: 0, dispatchInserts: 0, surfaceInserts: 0, lineErrors: 0, note: 'no source file' }
  }
  if (srcStat.size === 0) {
    return { ok: true, processed: 0, dispatchInserts: 0, surfaceInserts: 0, lineErrors: 0, note: 'source file empty' }
  }

  // Rename source -> processed/<timestamp>-dispatch-events.jsonl atomically.
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const processedPath = path.join(PROCESSED_DIR, `${stamp}-dispatch-events.jsonl`)
  await fs.promises.rename(TELEMETRY_FILE, processedPath)

  // Connect to Postgres.
  const env = getEnv()
  const client = new Client({ connectionString: env.DATABASE_URL })
  try {
    await client.connect()
  } catch (err) {
    console.error('[consumer] cannot connect to Postgres:', err.message)
    // Restore the file by renaming it back so the next run can retry.
    try { await fs.promises.rename(processedPath, TELEMETRY_FILE) } catch { /* ignore */ }
    throw err
  }

  let result
  try {
    result = await consumeFile(processedPath, client)
  } finally {
    try { await client.end() } catch { /* ignore */ }
  }

  // Best-effort cleanup of old processed files.
  await pruneOldProcessedFiles()

  return { ok: true, ...result, processedPath }
}

async function runOnce() {
  try {
    const result = await rotateAndConsume()
    console.log('[consumer] tick complete:', JSON.stringify(result))
    return result
  } catch (err) {
    console.error('[consumer] tick failed:', err.message)
    return { ok: false, error: err.message }
  }
}

async function runLoop() {
  console.log(`[consumer] starting periodic loop, interval=${TICK_INTERVAL_MS / 1000}s, file=${TELEMETRY_FILE}`)
  // First tick immediately, then on interval.
  await runOnce()
  setInterval(runOnce, TICK_INTERVAL_MS).unref()
  // Keep process alive.
  setInterval(() => {}, 60_000).unref()
}

if (require.main === module) {
  const onceMode = process.argv.includes('--once')
  if (onceMode) {
    runOnce()
      .then(result => process.exit(result && result.ok ? 0 : 1))
      .catch(err => { console.error(err); process.exit(1) })
  } else {
    runLoop().catch(err => { console.error(err); process.exit(1) })
  }
}

module.exports = {
  rotateAndConsume,
  runOnce,
  consumeFile,
  actionTypeForHook,
  extractContextKeywords,
}
