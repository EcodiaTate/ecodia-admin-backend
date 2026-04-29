#!/usr/bin/env node
/**
 * episode-resurface-search.js
 *
 * Phase F (Layer 7) backing primitive. The bash hook
 * `~/ecodiaos/scripts/hooks/episode-resurface.sh` invokes this CLI with the
 * brief's "goal sentence" as a positional argument and reads JSON from stdout.
 *
 * Design:
 *   - Reuses src/services/neo4jRetrieval.js semanticSearch (the same primitive
 *     failureClassifier.js uses). NOT a parallel-infrastructure embedding/
 *     search re-implementation; calls the existing helper directly.
 *   - Hard timeout enforced via Promise.race so the hook never blocks > 500ms.
 *   - On any error: prints `{"hits":[],"error":"<msg>"}` and exits 0 (hooks
 *     are warn-only; we degrade gracefully when Neo4j or OpenAI is down).
 *
 * Usage:
 *   node scripts/episode-resurface-search.js "<goal sentence>" [--limit=3] [--min-score=0.75]
 *
 * Output (stdout, single line of JSON):
 *   {
 *     "hits": [
 *       {"label":"Episode","name":"...","description":"...","score":0.83},
 *       ...
 *     ],
 *     "elapsed_ms": 137
 *   }
 *
 * Exit codes:
 *   0 - always (warn-only). Errors land in the JSON output, not the exit code.
 */

'use strict'

const path = require('path')

// Load env from the EcodiaOS .env (the script runs from anywhere; keep it
// portable to invocation via `node /home/tate/ecodiaos/scripts/...`).
try {
  require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') })
} catch (_) {
  // dotenv missing is fine if env vars are already exported.
}

const HARD_TIMEOUT_MS = parseInt(process.env.EPISODE_RESURFACE_TIMEOUT_MS || '500', 10)
const DEFAULT_LIMIT = 3
const DEFAULT_MIN_SCORE = 0.75
// Phase F's labels: Episodes/Decisions carry events, Patterns are the rules,
// Strategic_Direction captures durable strategic moves. All four are valid
// resurface targets per the brief.
const LABELS = ['Episode', 'Decision', 'Pattern', 'Strategic_Direction']

function parseArgs(argv) {
  const out = { goal: '', limit: DEFAULT_LIMIT, minScore: DEFAULT_MIN_SCORE }
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i]
    if (a.startsWith('--limit=')) out.limit = parseInt(a.slice(8), 10) || DEFAULT_LIMIT
    else if (a.startsWith('--min-score=')) out.minScore = parseFloat(a.slice(12)) || DEFAULT_MIN_SCORE
    else if (!a.startsWith('--') && !out.goal) out.goal = a
  }
  return out
}

async function withTimeout(promise, ms, label) {
  let to
  const timeout = new Promise((_, rej) => {
    to = setTimeout(() => rej(new Error(`timeout:${label}:${ms}ms`)), ms)
  })
  try {
    return await Promise.race([promise, timeout])
  } finally {
    clearTimeout(to)
  }
}

async function main() {
  const started = Date.now()
  const { goal, limit, minScore } = parseArgs(process.argv)

  if (!goal || goal.trim().length < 8) {
    process.stdout.write(JSON.stringify({ hits: [], error: 'goal-too-short', elapsed_ms: 0 }) + '\n')
    return
  }

  let hits = []
  let error = null
  try {
    // Lazy require so a missing module never crashes the hook.
    const neo4jRetrieval = require(path.resolve(__dirname, '..', 'src', 'services', 'neo4jRetrieval'))
    hits = await withTimeout(
      neo4jRetrieval.semanticSearch(goal, {
        limit,
        minScore,
        labels: LABELS,
        onlyCurrent: true,
      }),
      HARD_TIMEOUT_MS,
      'semanticSearch'
    )
  } catch (err) {
    error = err && err.message ? err.message : String(err)
    hits = []
  }

  const out = {
    hits: Array.isArray(hits) ? hits.map(h => ({
      label: h.label,
      name: h.name,
      description: (h.description || '').slice(0, 240),
      score: typeof h.score === 'number' ? Number(h.score.toFixed(4)) : null,
    })) : [],
    elapsed_ms: Date.now() - started,
  }
  if (error) out.error = error

  process.stdout.write(JSON.stringify(out) + '\n')
}

main().then(() => {
  // Force-exit so the Neo4j driver does not keep the event loop alive.
  process.exit(0)
}).catch(err => {
  // Last-ditch fallback. Should be unreachable because main() catches all.
  process.stdout.write(JSON.stringify({ hits: [], error: err.message || String(err) }) + '\n')
  process.exit(0)
})
