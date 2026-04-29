/**
 * failureClassifier.js
 *
 * Phase D (Layer 5) of the Decision Quality Self-Optimization Architecture.
 * See: ~/ecodiaos/patterns/decision-quality-self-optimization-architecture.md
 *
 * For each outcome_event with outcome='correction' and classification IS NULL,
 * classify the failure into one of three modes so the remediation routes to
 * the right layer:
 *
 *   usage_failure      - relevant pattern surfaced AND was tagged [APPLIED]
 *                        AND outcome was still a correction. Doctrine was
 *                        right; application was wrong (or doctrine incomplete).
 *                        Action: refine the pattern.
 *
 *   surfacing_failure  - relevant pattern existed but did NOT surface (no
 *                        surface_event row for it). Triggers missed.
 *                        Action: tighten/expand triggers OR add canonical.
 *
 *   doctrine_failure   - no relevant pattern existed in the corpus (semantic
 *                        search returned nothing above similarity threshold).
 *                        Action: author a new pattern.
 *
 * Conservative defaults: when in doubt, classify as `usage_failure` (least
 * invasive remediation). Phase D is about routing, not 100% accuracy.
 *
 * Hot-path safe: classifier runs from cron only, NEVER on dispatch hot path.
 *
 * Embedding cost budget: at most 50 outcomes/tick × 24 ticks = 1200/day. Each
 * call uses one Neo4j semantic search (one OpenAI text-embedding-3-small
 * embedding). Cap is enforced via tickClassifier({ max }).
 *
 * CLI: `node src/services/telemetry/failureClassifier.js --once`
 *      `node src/services/telemetry/failureClassifier.js --once --max=50`
 */

'use strict'

const { Client } = require('pg')

// Lazy require so module import doesn't hard-require env at test time.
let _env = null
function getEnv() {
  if (_env) return _env
  _env = require('../../config/env')
  return _env
}

// Reuse the shared Neo4j retrieval helpers (semanticSearch wraps the vector
// index call + cosine threshold + label filtering). This is the same primitive
// the conductor already trusts for context surfacing.
const neo4jRetrieval = require('../neo4jRetrieval')

const DEFAULT_MAX_PER_TICK = 50
// Similarity threshold for "this pattern is relevant to this correction."
// Tuned conservatively (>=0.70) to avoid spurious doctrine_failure -> usage_failure
// reclassifications. Below this, the result is treated as "no semantic match"
// and the classifier falls through to doctrine_failure.
const SEMANTIC_SIM_THRESHOLD = 0.70
// Top-K results we consider "patterns that should have surfaced" for this
// correction. Higher K = more chances to find an existing pattern; cost is one
// vector index probe per row regardless of K, so the trade-off is cheap.
const SEMANTIC_TOP_K = 5
// Labels we semantically search across. Patterns are the primary doctrine
// surface; Decisions and Episodes carry contextual evidence the classifier
// uses for tie-breaking but are not authoritative for the doctrine_failure
// decision.
const PATTERN_SEARCH_LABELS = ['Pattern']

async function withClient(fn) {
  const env = getEnv()
  const client = new Client({ connectionString: env.DATABASE_URL })
  await client.connect()
  try {
    return await fn(client)
  } finally {
    try { await client.end() } catch { /* ignore */ }
  }
}

/**
 * Build the natural-language query string used to embed and probe Neo4j.
 *
 * Inputs we have to work with:
 *   - correction_text  (Tate's actual rebuke / correction)
 *   - dispatch.action_type, tool_name, context_keywords
 *
 * Heuristic: prepend the action context so the embedding picks up doctrine
 * keyed on tool/action types ("factory dispatch", "fork spawn") not just
 * raw correction text. Cap at 4000 chars to stay well under embedding limits.
 */
function buildQueryText(outcome, dispatch) {
  const parts = []
  const correction = (outcome.correction_text || '').trim()
  if (correction) parts.push(correction)
  const actionType = dispatch?.action_type || ''
  const toolName = dispatch?.tool_name || ''
  if (actionType) parts.push(`action: ${actionType}`)
  if (toolName) parts.push(`tool: ${toolName}`)
  const kws = Array.isArray(dispatch?.context_keywords) ? dispatch.context_keywords : []
  if (kws.length > 0) parts.push(`context: ${kws.slice(0, 12).join(' ')}`)
  // If we have nothing else, fall back to evidence text.
  if (parts.length === 0 && outcome.evidence) parts.push(outcome.evidence)
  return parts.join(' | ').slice(0, 4000)
}

/**
 * Pull the surface_event + application_event rows for a given dispatch.
 * Returns:
 *   surfaced_paths       - Set<string> of pattern_paths that surfaced for this dispatch
 *   applied_paths        - Set<string> of pattern_paths the conductor tagged [APPLIED]
 *   silent_paths         - Set<string> of pattern_paths that surfaced but were silent / not_applied
 */
async function getDispatchTagState(client, dispatchEventId) {
  const surfaced = new Set()
  const applied = new Set()
  const silent = new Set()
  if (!dispatchEventId) return { surfaced, applied, silent }
  const r = await client.query(
    `SELECT s.pattern_path,
            ae.applied,
            ae.tagged_silent,
            ae.id AS app_id
     FROM surface_event s
     LEFT JOIN application_event ae
       ON ae.dispatch_event_id = s.dispatch_event_id
      AND ae.pattern_path = s.pattern_path
     WHERE s.dispatch_event_id = $1`,
    [dispatchEventId]
  )
  for (const row of r.rows) {
    const p = row.pattern_path
    if (!p) continue
    surfaced.add(p)
    if (row.applied === true) applied.add(p)
    else if (row.app_id === null || row.tagged_silent === true) silent.add(p)
    // explicit applied=false (NOT-APPLIED) is neither applied nor silent;
    // the conductor named the pattern and explicitly chose not to apply it.
  }
  return { surfaced, applied, silent }
}

/**
 * Core classifier for a single outcome_event row.
 *
 * Returns:
 *   {
 *     classification: 'usage_failure' | 'surfacing_failure' | 'doctrine_failure',
 *     evidence: {
 *       top_k:          [{name, label, score, description}]
 *       surfaced:       string[]    // pattern_paths from surface_event
 *       applied:        string[]    // pattern_paths tagged [APPLIED]
 *       silent:         string[]    // pattern_paths surfaced but ignored
 *       query_text:     string
 *       similarity_threshold: number
 *       reason:         string      // human-readable explanation of routing
 *     }
 *   }
 *
 * Decision tree (conservative defaults):
 *   1. If semantic search returns NO hits above threshold -> doctrine_failure.
 *   2. If at least one top-K hit's path appears in `applied` set -> usage_failure
 *      (the doctrine surfaced AND was applied AND the outcome was still wrong).
 *   3. If at least one top-K hit exists but NONE of those paths appear in
 *      `surfaced` -> surfacing_failure (the pattern existed but never surfaced).
 *   4. If hits exist AND surfaced AND silent (not applied, not explicitly
 *      not-applied) -> usage_failure (conservative: doctrine reached the
 *      conductor; ignored = usage problem).
 *   5. Anything else falls through to usage_failure (conservative default).
 */
async function classifyOutcome({ outcome, dispatch, pgClient }) {
  const queryText = buildQueryText(outcome, dispatch)
  const tagState = await getDispatchTagState(pgClient, outcome.dispatch_event_id)

  // Semantic search against Neo4j Pattern nodes.
  let topK = []
  try {
    topK = await neo4jRetrieval.semanticSearch(queryText, {
      limit: SEMANTIC_TOP_K,
      minScore: SEMANTIC_SIM_THRESHOLD,
      labels: PATTERN_SEARCH_LABELS,
    })
  } catch (err) {
    // Semantic search failure is non-fatal; we still classify, but conservatively.
    console.warn('[failureClassifier] semantic search failed:', err.message)
    topK = []
  }

  const evidence = {
    query_text: queryText,
    similarity_threshold: SEMANTIC_SIM_THRESHOLD,
    top_k: topK.map(h => ({
      name: h.name,
      label: h.label,
      score: typeof h.score === 'number' ? Number(h.score.toFixed(4)) : h.score,
      description: h.description,
    })),
    surfaced: Array.from(tagState.surfaced),
    applied: Array.from(tagState.applied),
    silent: Array.from(tagState.silent),
    reason: '',
  }

  // Build a Set of "candidate pattern paths" that the semantic search thinks
  // are relevant. The semanticSearch helper returns Pattern node `name` values
  // which are descriptive titles, not file paths. We do best-effort matching:
  // a top-K hit "matches" a surface_event row if either the path basename
  // appears in the hit's name OR vice versa. This is intentionally loose -
  // false positives here only push us toward the more conservative
  // usage_failure label.
  function pathMatchesAny(patternPath, hits) {
    if (!patternPath) return false
    const basename = String(patternPath).split('/').pop().toLowerCase()
    const stem = basename.replace(/\.md$/, '')
    for (const h of hits) {
      const name = String(h.name || '').toLowerCase()
      if (!name) continue
      if (name.includes(stem)) return true
      if (stem.includes(name)) return true
      // Token-level: do any hyphen-tokens of the stem appear in the name?
      const tokens = stem.split(/[-_]/).filter(t => t.length >= 4)
      if (tokens.some(t => name.includes(t))) return true
    }
    return false
  }

  // Case 1: no semantic match at all -> doctrine gap.
  if (topK.length === 0) {
    evidence.reason = 'no semantic match above threshold; doctrine corpus lacks coverage for this correction'
    return { classification: 'doctrine_failure', evidence }
  }

  // Case 2: any hit corresponds to a pattern that was applied -> usage failure.
  for (const appliedPath of tagState.applied) {
    if (pathMatchesAny(appliedPath, topK)) {
      evidence.reason = `relevant pattern ${appliedPath} surfaced and was tagged [APPLIED] yet correction occurred; doctrine right, application or doctrine-completeness wrong`
      return { classification: 'usage_failure', evidence }
    }
  }

  // Case 3: hits exist but NONE of them surfaced -> surfacing failure.
  const anyHitSurfaced = Array.from(tagState.surfaced).some(p => pathMatchesAny(p, topK))
  if (!anyHitSurfaced) {
    evidence.reason = `${topK.length} relevant pattern(s) exist (top hit: ${topK[0].name}) but none surfaced for this dispatch; triggers missed`
    return { classification: 'surfacing_failure', evidence }
  }

  // Case 4: hits surfaced and were silent (no APPLIED tag, no NOT-APPLIED).
  for (const silentPath of tagState.silent) {
    if (pathMatchesAny(silentPath, topK)) {
      evidence.reason = `relevant pattern ${silentPath} surfaced but was silently ignored; conservative classification as usage_failure`
      return { classification: 'usage_failure', evidence }
    }
  }

  // Case 5 (fallthrough): conservative default.
  evidence.reason = 'fallthrough conservative default - hits exist with mixed signals; classified as usage_failure pending Tate ground-truth'
  return { classification: 'usage_failure', evidence }
}

/**
 * Run one classification tick. Pulls up to `max` unclassified correction rows,
 * classifies each, persists classification + evidence + classification_at.
 *
 * Verify-before-redo discipline: the SQL filter explicitly excludes rows that
 * already have a non-NULL classification. Re-running the cron over already-
 * classified data is a no-op. (See
 * ~/ecodiaos/patterns/scheduled-redispatch-verify-not-shipped.md.)
 */
async function tickClassifier({ max = DEFAULT_MAX_PER_TICK } = {}) {
  return withClient(async (client) => {
    let classified = 0
    let skipped = 0
    let errors = 0
    const distribution = { usage_failure: 0, surfacing_failure: 0, doctrine_failure: 0 }

    // Pull oldest unclassified corrections first, capped at `max`.
    // Joined with dispatch_event so we have action context for the query.
    const r = await client.query(
      `SELECT o.id              AS outcome_id,
              o.dispatch_event_id,
              o.outcome,
              o.evidence,
              o.correction_text,
              d.action_type,
              d.tool_name,
              d.context_keywords,
              d.metadata
       FROM outcome_event o
       LEFT JOIN dispatch_event d ON d.id = o.dispatch_event_id
       WHERE o.outcome = 'correction'
         AND o.classification IS NULL
       ORDER BY o.ts ASC
       LIMIT $1`,
      [max]
    )

    for (const row of r.rows) {
      try {
        const outcome = {
          id: row.outcome_id,
          dispatch_event_id: row.dispatch_event_id,
          outcome: row.outcome,
          evidence: row.evidence,
          correction_text: row.correction_text,
        }
        const dispatch = {
          action_type: row.action_type,
          tool_name: row.tool_name,
          context_keywords: row.context_keywords,
          metadata: row.metadata,
        }
        const result = await classifyOutcome({ outcome, dispatch, pgClient: client })

        await client.query(
          `UPDATE outcome_event
             SET classification = $2,
                 classification_evidence = $3::jsonb,
                 classification_at = NOW()
           WHERE id = $1
             AND classification IS NULL`,
          [outcome.id, result.classification, JSON.stringify(result.evidence)]
        )
        classified += 1
        if (distribution[result.classification] !== undefined) {
          distribution[result.classification] += 1
        }
      } catch (err) {
        errors += 1
        console.error('[failureClassifier] error classifying outcome', row.outcome_id, err.message)
      }
    }

    skipped = Math.max(0, r.rowCount - classified - errors)

    // Side-channel maintenance: refresh the auto-vs-tate accuracy kv_store
    // key (rolling 7d). If accuracy < 70%, surface a P2 status_board row.
    try {
      const acc = await computeAutoVsTateAccuracy(client)
      await client.query(
        `INSERT INTO kv_store (key, value, updated_at)
         VALUES ($1, $2, NOW())
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
        ['telemetry.classifier.auto_vs_tate_accuracy', JSON.stringify(acc)]
      )
      if (acc.sample_size >= 5 && acc.match_rate < 0.70) {
        await ensureClassifierAccuracyStatusBoardRow(client, acc)
      }
    } catch (err) {
      console.warn('[failureClassifier] accuracy check failed:', err.message)
    }

    // Doctrine-failure cluster authoring trigger: when a clustered
    // correction-text bucket exceeds 3 doctrine_failure rows over 14d, surface
    // a P2 status_board row "Doctrine gap: <cluster> - author new pattern".
    try {
      await ensureDoctrineGapStatusBoardRows(client)
    } catch (err) {
      console.warn('[failureClassifier] doctrine-gap surface failed:', err.message)
    }

    return { ok: true, classified, skipped, errors, distribution, max }
  })
}

/**
 * % match between auto-classified and Tate-tagged classifications, over the
 * last 7 days. Returns { sample_size, match_rate, computed_at }.
 *
 * "match" means classification = classification_tate_tagged for rows where
 * BOTH are non-NULL.
 */
async function computeAutoVsTateAccuracy(client) {
  const r = await client.query(`
    SELECT COUNT(*) FILTER (WHERE classification = classification_tate_tagged) AS matches,
           COUNT(*) AS total
    FROM outcome_event
    WHERE ts > NOW() - INTERVAL '7 days'
      AND classification IS NOT NULL
      AND classification_tate_tagged IS NOT NULL
  `)
  const total = Number(r.rows[0]?.total || 0)
  const matches = Number(r.rows[0]?.matches || 0)
  const matchRate = total > 0 ? matches / total : null
  return {
    sample_size: total,
    matches,
    match_rate: matchRate,
    computed_at: new Date().toISOString(),
  }
}

async function ensureClassifierAccuracyStatusBoardRow(client, acc) {
  const NAME = 'Classifier accuracy below 70% - re-tune similarity threshold or expand training set'
  const exists = await client.query(
    `SELECT id FROM status_board WHERE name = $1 AND archived_at IS NULL LIMIT 1`,
    [NAME]
  )
  const ctx = `Auto-classifier vs Tate-tagged ground truth: ${(acc.match_rate * 100).toFixed(1)}% match over ${acc.sample_size} samples (last 7d). Threshold = 70%. Either tighten SEMANTIC_SIM_THRESHOLD, expand the doctrine corpus, or audit Tate's recent overrides for systematic bias.`
  if (exists.rowCount > 0) {
    await client.query(
      `UPDATE status_board SET status = 'in-progress', context = $2, last_touched = NOW() WHERE id = $1`,
      [exists.rows[0].id, ctx]
    )
  } else {
    await client.query(
      `INSERT INTO status_board (entity_type, name, status, next_action, next_action_by, priority, context, last_touched)
       VALUES ('infrastructure', $1, 'in-progress', 'Audit recent Tate overrides; tune SEMANTIC_SIM_THRESHOLD or rewrite classifier', 'ecodiaos', 2, $2, NOW())`,
      [NAME, ctx]
    )
  }
}

/**
 * Doctrine-gap clustering: when more than 3 doctrine_failure rows over 14d
 * cluster around the same top-3 most-frequent words (excluding stopwords) in
 * their correction_text, surface as a P2 status_board row prompting a new
 * pattern to be authored.
 */
const DOCTRINE_GAP_STOPWORDS = new Set([
  'the','and','for','are','was','has','have','had','but','not','you','this','that',
  'with','from','they','were','their','what','when','where','which','would','could',
  'should','about','into','your','our','its','his','her','been','will','just','also',
  'than','then','them','these','those','here','some','such','only','very','more',
  'most','much','any','all','one','two','can','may','dont','does','did','isnt','wasnt',
])

function bucketCorrection(correction) {
  if (!correction) return null
  const tokens = String(correction)
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(t => t.length >= 4 && !DOCTRINE_GAP_STOPWORDS.has(t))
  if (tokens.length === 0) return null
  const counts = new Map()
  for (const t of tokens) counts.set(t, (counts.get(t) || 0) + 1)
  const top = Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 3)
    .map(([w]) => w)
  if (top.length === 0) return null
  return top.sort().join('+')
}

async function ensureDoctrineGapStatusBoardRows(client) {
  const r = await client.query(`
    SELECT id, correction_text
    FROM outcome_event
    WHERE outcome = 'correction'
      AND classification = 'doctrine_failure'
      AND ts > NOW() - INTERVAL '14 days'
  `)
  const buckets = new Map()
  for (const row of r.rows) {
    const b = bucketCorrection(row.correction_text)
    if (!b) continue
    if (!buckets.has(b)) buckets.set(b, [])
    buckets.get(b).push(row.id)
  }
  for (const [bucket, ids] of buckets.entries()) {
    if (ids.length < 4) continue // exceeds 3 over 14d
    const NAME = `Doctrine gap: ${bucket} - author new pattern`
    const exists = await client.query(
      `SELECT id FROM status_board WHERE name = $1 AND archived_at IS NULL LIMIT 1`,
      [NAME]
    )
    const ctx = `Cluster '${bucket}' has ${ids.length} doctrine_failure outcomes over rolling 14d. Author a new pattern in ~/ecodiaos/patterns/ that covers this correction class. Sample outcome ids: ${ids.slice(0, 5).join(', ')}.`
    if (exists.rowCount > 0) {
      await client.query(
        `UPDATE status_board SET context = $2, last_touched = NOW() WHERE id = $1`,
        [exists.rows[0].id, ctx]
      )
    } else {
      await client.query(
        `INSERT INTO status_board (entity_type, name, status, next_action, next_action_by, priority, context, last_touched)
         VALUES ('task', $1, 'open', 'Draft a pattern file in ~/ecodiaos/patterns/ covering this correction cluster', 'ecodiaos', 2, $2, NOW())`,
        [NAME, ctx]
      )
    }
  }
}

async function runOnce(opts = {}) {
  try {
    const result = await tickClassifier(opts)
    console.log('[failureClassifier] tick complete:', JSON.stringify(result))
    return result
  } catch (err) {
    console.error('[failureClassifier] tick failed:', err.message)
    return { ok: false, error: err.message }
  }
}

if (require.main === module) {
  // CLI: --once for one-shot, --max=N to override per-tick cap.
  const onceMode = process.argv.includes('--once')
  const maxArg = process.argv.find(a => a.startsWith('--max='))
  const max = maxArg ? Math.max(1, parseInt(maxArg.split('=')[1], 10) || DEFAULT_MAX_PER_TICK) : DEFAULT_MAX_PER_TICK
  if (onceMode) {
    runOnce({ max })
      .then(result => process.exit(result && result.ok ? 0 : 1))
      .catch(err => { console.error(err); process.exit(1) })
  } else {
    // Foreground long-running mode: run every hour, exit on SIGTERM.
    console.log('[failureClassifier] starting periodic loop, interval=3600s')
    runOnce({ max })
    setInterval(() => runOnce({ max }), 60 * 60 * 1000).unref()
    setInterval(() => {}, 60_000).unref()
  }
}

module.exports = {
  classifyOutcome,
  tickClassifier,
  runOnce,
  computeAutoVsTateAccuracy,
  // Exposed for testing / panel reuse.
  buildQueryText,
  bucketCorrection,
  SEMANTIC_SIM_THRESHOLD,
  SEMANTIC_TOP_K,
  DEFAULT_MAX_PER_TICK,
}
