/**
 * perfEmit.js
 *
 * Phase E (Layer 6) per-primitive performance telemetry emitter.
 * See: ~/ecodiaos/patterns/decision-quality-self-optimization-architecture.md
 *
 * JS-side mirror of `~/ecodiaos/scripts/hooks/lib/emit-perf.sh`. Used by
 * Node-resident hot primitives that want to emit a `primitive_perf_event`
 * datapoint without paying the round-trip cost of shelling out to bash.
 *
 * Hard constraint (from the spec):
 *   "perf instrumentation MUST NOT itself add measurable overhead. Target
 *    overhead < 100us per primitive call."
 *
 * Mechanism:
 *   - Append-only JSONL writes to ~/ecodiaos/logs/telemetry/perf-events.jsonl.
 *   - perfEventConsumer.js drains the JSONL into Postgres every 15 minutes.
 *   - All errors are swallowed silently. NEVER let perf instrumentation crash
 *     the calling primitive.
 *
 * Usage:
 *   const perfEmit = require('./telemetry/perfEmit')
 *   const span = perfEmit.start('forkService.spawnFork')
 *   try {
 *     // ... do the actual work ...
 *     span.end({ status: 'ok' })
 *   } catch (err) {
 *     span.end({ status: 'error', metadata: { error: err.message } })
 *     throw err
 *   }
 *
 * Or for one-shot emission with a known duration:
 *   perfEmit.emit('macroSuite.run', durationMs, { status: 'ok' })
 */

'use strict'

const fs = require('fs')
const path = require('path')

const PERF_DIR = process.env.ECODIAOS_PERF_TELEMETRY_DIR
  || '/home/tate/ecodiaos/logs/telemetry'
const PERF_FILE = process.env.ECODIAOS_PERF_TELEMETRY_FILE
  || path.join(PERF_DIR, 'perf-events.jsonl')

// Ensure dir exists at module-load time. mkdirSync is cheap (a no-op if it
// already exists) and is the only sync IO we do up front. We tolerate any
// error here because perf emission MUST NOT crash the host process.
try { fs.mkdirSync(PERF_DIR, { recursive: true }) } catch { /* ignore */ }

/**
 * Emit a single perf event. Async-safe (returns immediately, write happens
 * via fs.appendFile in the background).
 *
 * @param {string} primitiveName - canonical hot-primitive name, e.g.
 *   'forkService.spawnFork', 'macroSuite.run', 'mcp__neo4j__graph_semantic_search'
 * @param {number} durationMs - elapsed wall-clock time in milliseconds.
 * @param {object} [opts]
 * @param {string} [opts.status='ok'] - 'ok' | 'error' | 'timeout'
 * @param {number} [opts.payloadSizeBytes] - optional rough payload size for
 *   slicing perf by request size (useful for spawnFork where larger briefs
 *   plausibly cost more).
 * @param {object} [opts.metadata] - free-form JSON-safe object. Avoid PII.
 */
function emit(primitiveName, durationMs, opts) {
  if (typeof primitiveName !== 'string' || primitiveName.length === 0) return
  // Coerce duration to a non-negative integer. Defensive against
  // performance.now() returning fractional values.
  const dur = Math.max(0, Math.floor(Number(durationMs) || 0))
  const o = opts || {}
  const line = {
    ts: new Date().toISOString(),
    primitive_name: primitiveName,
    duration_ms: dur,
    status: o.status || 'ok',
    payload_size_bytes: (() => {
      // Accept both camelCase (preferred) and snake_case (matches the
      // forkService.spawnFork emission shape and the JSONL line schema).
      const v = (typeof o.payloadSizeBytes === 'number') ? o.payloadSizeBytes
        : (typeof o.payload_size_bytes === 'number') ? o.payload_size_bytes
        : null
      return (typeof v === 'number') ? Math.max(0, Math.floor(v)) : null
    })(),
    metadata: (o.metadata && typeof o.metadata === 'object') ? o.metadata : null,
  }
  // Async append. We deliberately do NOT await - the caller does not block
  // on perf telemetry. Errors are swallowed in the callback.
  let serialised
  try {
    serialised = JSON.stringify(line) + '\n'
  } catch {
    // Metadata may contain a circular ref. Strip it and retry.
    line.metadata = null
    try { serialised = JSON.stringify(line) + '\n' } catch { return }
  }
  fs.appendFile(PERF_FILE, serialised, (err) => {
    // Swallow. Perf emission is best-effort; a full disk or transient IO
    // error must not crash or even warn from a hot primitive.
    if (err) {
      // Optional: in dev-only, surface to stderr. In prod, silent.
      if (process.env.ECODIAOS_PERF_DEBUG === '1') {
        // eslint-disable-next-line no-console
        console.error('[perfEmit] append failed:', err.message)
      }
    }
  })
}

/**
 * Open a timing span. Returns an object with an `end(opts)` method that
 * computes the elapsed ms and emits the event. This is the preferred shape
 * for instrumented async calls.
 *
 * @param {string} primitiveName
 * @returns {{ end: (opts?: object) => void }}
 */
function start(primitiveName) {
  // performance.now() gives sub-ms precision and is monotonic - safe to
  // bracket async work without clock-skew artefacts.
  const t0 = (typeof performance !== 'undefined' && performance.now)
    ? performance.now()
    : Date.now()
  return {
    end(opts) {
      const t1 = (typeof performance !== 'undefined' && performance.now)
        ? performance.now()
        : Date.now()
      emit(primitiveName, t1 - t0, opts)
    },
  }
}

/**
 * Wrap a promise-returning function with timing. Convenience helper.
 *
 *   await perfEmit.measure('forkService.spawnFork', () => realSpawnFork(brief))
 */
async function measure(primitiveName, fn, opts) {
  const span = start(primitiveName)
  try {
    const result = await fn()
    span.end({ status: 'ok', ...(opts || {}) })
    return result
  } catch (err) {
    span.end({
      status: 'error',
      metadata: { error: (err && err.message) ? err.message.slice(0, 200) : String(err).slice(0, 200) },
      ...(opts || {}),
    })
    throw err
  }
}

module.exports = {
  emit,
  start,
  measure,
  // Exposed for tests.
  _PERF_FILE: PERF_FILE,
}
