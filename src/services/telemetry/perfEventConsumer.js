/**
 * perfEventConsumer.js
 *
 * Phase E (Layer 6) batch consumer for per-primitive performance telemetry.
 * See: ~/ecodiaos/patterns/decision-quality-self-optimization-architecture.md
 *
 * Drains two JSONL streams emitted by hot-path instrumentation into Postgres:
 *   1. perf-events.jsonl       -> primitive_perf_event
 *      (forkService.spawnFork, brief-consistency-check.sh, macroSuite.run,
 *      mcp__neo4j__graph_semantic_search)
 *   2. macro-perf-events.jsonl -> macro_perf_event
 *      (one row per macroSuite.run() invocation, with per-step wait timings)
 *
 * Mirrors dispatchEventConsumer.js (Phase B) for the rotate-then-process
 * pattern: source files are renamed to processed/<timestamp>-*.jsonl BEFORE
 * inserts, so concurrent hook fires append to a fresh file. Each line is
 * parsed and inserted within an individual try/catch; one corrupt line cannot
 * poison the whole batch. Tick interval = 15 minutes.
 *
 * Crash safety:
 *   - Rename-before-insert prevents lost events on consumer crash mid-tick.
 *   - On Postgres connect failure, source files are renamed BACK so the next
 *     run retries.
 *   - Processed files are retained 7 days for forensic review.
 *
 * Invocation:
 *   node src/services/telemetry/perfEventConsumer.js --once   (cron use)
 *   node src/services/telemetry/perfEventConsumer.js          (periodic loop)
 *
 * Cron: `telemetry-perf-consumer` runs `every 15m` and POSTs
 *   /api/telemetry/perf-consume which calls runOnce() on this module.
 */

'use strict'

const fs = require('fs')
const path = require('path')
const { Client } = require('pg')

let _env = null
function getEnv() {
  if (_env) return _env
  _env = require('../../config/env')
  return _env
}

const TELEMETRY_DIR = process.env.ECODIAOS_PERF_TELEMETRY_DIR
  || '/home/tate/ecodiaos/logs/telemetry'
const PERF_FILE = process.env.ECODIAOS_PERF_TELEMETRY_FILE
  || path.join(TELEMETRY_DIR, 'perf-events.jsonl')
const MACRO_PERF_FILE = process.env.ECODIAOS_MACRO_PERF_TELEMETRY_FILE
  || path.join(TELEMETRY_DIR, 'macro-perf-events.jsonl')
const PROCESSED_DIR = path.join(TELEMETRY_DIR, 'processed')
const RETENTION_DAYS = 7
const TICK_INTERVAL_MS = 15 * 60 * 1000

/**
 * Drain a primitive_perf_event JSONL file into Postgres.
 * Line shape: {ts, primitive_name, duration_ms, status, payload_size_bytes, metadata}
 */
async function consumePrimitiveFile(filePath, client) {
  const stats = await fs.promises.stat(filePath).catch(() => null)
  if (!stats) return { processed: 0, inserts: 0, lineErrors: 0 }
  const content = await fs.promises.readFile(filePath, 'utf8')
  const lines = content.split('\n').filter(l => l.trim().length > 0)

  let inserts = 0
  let lineErrors = 0

  for (const raw of lines) {
    try {
      const line = JSON.parse(raw)
      const ts = line.ts || new Date().toISOString()
      const primitiveName = line.primitive_name
      if (!primitiveName) { lineErrors += 1; continue }
      const dur = Math.max(0, Math.floor(Number(line.duration_ms) || 0))
      const status = line.status || 'ok'
      const payloadSize = (typeof line.payload_size_bytes === 'number')
        ? Math.max(0, Math.floor(line.payload_size_bytes)) : null
      const metadata = (line.metadata && typeof line.metadata === 'object')
        ? line.metadata : null

      await client.query(
        `INSERT INTO primitive_perf_event (ts, primitive_name, duration_ms, status, payload_size_bytes, metadata)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [ts, primitiveName, dur, status, payloadSize, metadata]
      )
      inserts += 1
    } catch (err) {
      lineErrors += 1
      console.error('[perf-consumer:primitive] insert failed:', err.message, 'raw:', raw.slice(0, 200))
    }
  }
  return { processed: lines.length, inserts, lineErrors }
}

/**
 * Drain a macro_perf_event JSONL file into Postgres.
 * Line shape: {ts, run_id, macro_name, target_host, wait_steps, total_ms, success, error_message, metadata}
 */
async function consumeMacroFile(filePath, client) {
  const stats = await fs.promises.stat(filePath).catch(() => null)
  if (!stats) return { processed: 0, inserts: 0, lineErrors: 0 }
  const content = await fs.promises.readFile(filePath, 'utf8')
  const lines = content.split('\n').filter(l => l.trim().length > 0)

  let inserts = 0
  let lineErrors = 0

  for (const raw of lines) {
    try {
      const line = JSON.parse(raw)
      const ts = line.ts || new Date().toISOString()
      const runId = line.run_id
      const macroName = line.macro_name
      if (!runId || !macroName) { lineErrors += 1; continue }
      const targetHost = line.target_host || null
      const waitSteps = Array.isArray(line.wait_steps) ? line.wait_steps : null
      const totalMs = Math.max(0, Math.floor(Number(line.total_ms) || 0))
      const success = line.success === true
      const errorMessage = line.error_message || null
      const metadata = (line.metadata && typeof line.metadata === 'object')
        ? line.metadata : null

      await client.query(
        `INSERT INTO macro_perf_event (ts, run_id, macro_name, target_host, wait_steps, total_ms, success, error_message, metadata)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [ts, runId, macroName, targetHost, waitSteps, totalMs, success, errorMessage, metadata]
      )
      inserts += 1
    } catch (err) {
      lineErrors += 1
      console.error('[perf-consumer:macro] insert failed:', err.message, 'raw:', raw.slice(0, 200))
    }
  }
  return { processed: lines.length, inserts, lineErrors }
}

async function pruneOldProcessedFiles() {
  try {
    const entries = await fs.promises.readdir(PROCESSED_DIR).catch(() => [])
    const cutoffMs = Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000
    for (const e of entries) {
      // Only prune Phase-E perf files; Phase-B files are pruned by their own consumer.
      if (!/-perf-events\.jsonl$/.test(e) && !/-macro-perf-events\.jsonl$/.test(e)) continue
      const p = path.join(PROCESSED_DIR, e)
      try {
        const st = await fs.promises.stat(p)
        if (st.mtimeMs < cutoffMs) await fs.promises.unlink(p)
      } catch { /* ignore */ }
    }
  } catch { /* non-fatal */ }
}

async function rotateAndConsume() {
  await fs.promises.mkdir(PROCESSED_DIR, { recursive: true })

  const perfStat = await fs.promises.stat(PERF_FILE).catch(() => null)
  const macroStat = await fs.promises.stat(MACRO_PERF_FILE).catch(() => null)
  const perfHasContent = !!(perfStat && perfStat.size > 0)
  const macroHasContent = !!(macroStat && macroStat.size > 0)

  if (!perfHasContent && !macroHasContent) {
    return {
      ok: true,
      primitive: { processed: 0, inserts: 0, lineErrors: 0, note: 'absent or empty' },
      macro:     { processed: 0, inserts: 0, lineErrors: 0, note: 'absent or empty' },
    }
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  let perfProcessedPath = null
  let macroProcessedPath = null

  if (perfHasContent) {
    perfProcessedPath = path.join(PROCESSED_DIR, `${stamp}-perf-events.jsonl`)
    await fs.promises.rename(PERF_FILE, perfProcessedPath)
  }
  if (macroHasContent) {
    macroProcessedPath = path.join(PROCESSED_DIR, `${stamp}-macro-perf-events.jsonl`)
    await fs.promises.rename(MACRO_PERF_FILE, macroProcessedPath)
  }

  const env = getEnv()
  const client = new Client({ connectionString: env.DATABASE_URL })
  try {
    await client.connect()
  } catch (err) {
    console.error('[perf-consumer] cannot connect to Postgres:', err.message)
    // Restore by renaming back so the next tick retries.
    if (perfProcessedPath) {
      try { await fs.promises.rename(perfProcessedPath, PERF_FILE) } catch { /* ignore */ }
    }
    if (macroProcessedPath) {
      try { await fs.promises.rename(macroProcessedPath, MACRO_PERF_FILE) } catch { /* ignore */ }
    }
    throw err
  }

  let primitive = { processed: 0, inserts: 0, lineErrors: 0 }
  let macro = { processed: 0, inserts: 0, lineErrors: 0 }
  try {
    if (perfProcessedPath) primitive = await consumePrimitiveFile(perfProcessedPath, client)
    if (macroProcessedPath) macro = await consumeMacroFile(macroProcessedPath, client)
  } finally {
    try { await client.end() } catch { /* ignore */ }
  }

  await pruneOldProcessedFiles()

  return {
    ok: true,
    primitive: { ...primitive, processedPath: perfProcessedPath },
    macro:     { ...macro, processedPath: macroProcessedPath },
  }
}

async function runOnce() {
  try {
    const result = await rotateAndConsume()
    console.log('[perf-consumer] tick complete:', JSON.stringify(result))
    return result
  } catch (err) {
    console.error('[perf-consumer] tick failed:', err.message)
    return { ok: false, error: err.message }
  }
}

async function runLoop() {
  console.log(`[perf-consumer] starting periodic loop, interval=${TICK_INTERVAL_MS / 1000}s`)
  await runOnce()
  setInterval(runOnce, TICK_INTERVAL_MS).unref()
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
  consumePrimitiveFile,
  consumeMacroFile,
}
