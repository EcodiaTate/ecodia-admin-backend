/**
 * /api/telemetry routes - observability for the Decision Quality
 * Self-Optimization Architecture (Phases B + D).
 *
 * See:
 *   ~/ecodiaos/patterns/decision-quality-self-optimization-architecture.md
 *
 * Endpoints:
 *   GET  /api/telemetry/decision-quality?days=7   - 5-panel dashboard
 *   GET  /api/telemetry/drift                     - active drift flags
 *   POST /api/telemetry/consume                   - one-shot trigger of the
 *                                                   batch consumer (admin/cron use)
 *   POST /api/telemetry/infer-outcomes            - one-shot trigger of the
 *                                                   outcome inferrer (admin/cron use)
 *   POST /api/telemetry/classify-outcomes         - one-shot trigger of the
 *                                                   failureClassifier (Phase D)
 *   POST /api/telemetry/outcome/:id/classify      - Tate-tagged ground-truth
 *                                                   override of an outcome's
 *                                                   classification (Phase D
 *                                                   Task 4)
 *
 * All routes require auth (Bearer token / MCP_INTERNAL_TOKEN). The dashboard
 * route is read-only; consume + infer-outcomes + classify-outcomes mutate by
 * inserting/updating rows. The override route lands a Tate-tagged value the
 * accuracy check uses as ground truth.
 */

'use strict'

const express = require('express')
const router = express.Router()
const auth = require('../middleware/auth')
const decisionQualityService = require('../services/telemetry/decisionQualityService')
const dispatchEventConsumer = require('../services/telemetry/dispatchEventConsumer')
const outcomeInference = require('../services/telemetry/outcomeInference')
const failureClassifier = require('../services/telemetry/failureClassifier')

const VALID_CLASSIFICATIONS = new Set(['usage_failure', 'surfacing_failure', 'doctrine_failure'])

router.use(auth)

// GET /api/telemetry/decision-quality?days=7
router.get('/decision-quality', async (req, res, next) => {
  try {
    const days = Math.max(1, Math.min(90, parseInt(req.query.days, 10) || 7))
    const result = await decisionQualityService.computeDecisionQuality({ days })
    res.json(result)
  } catch (err) { next(err) }
})

// GET /api/telemetry/drift
router.get('/drift', async (_req, res, next) => {
  try {
    const flags = await decisionQualityService.computeDriftSignals()
    res.json({ flags, count: flags.length })
  } catch (err) { next(err) }
})

// POST /api/telemetry/consume
// Triggers a one-shot run of the dispatchEventConsumer (rotates JSONL,
// inserts rows, prunes processed/). Used by the consumer cron when the
// scheduler fires.
router.post('/consume', async (_req, res, next) => {
  try {
    const result = await dispatchEventConsumer.runOnce()
    res.json(result)
  } catch (err) { next(err) }
})

// POST /api/telemetry/infer-outcomes
// Triggers a one-shot run of the outcome inferrer.
router.post('/infer-outcomes', async (_req, res, next) => {
  try {
    const result = await outcomeInference.runOnce()
    res.json(result)
  } catch (err) { next(err) }
})

// POST /api/telemetry/classify-outcomes?max=50
// One-shot trigger of the Phase D failureClassifier. Mirrors /consume +
// /infer-outcomes for cron parity. The default per-tick cap is enforced by
// the classifier itself; pass ?max= to override at the route level.
router.post('/classify-outcomes', async (req, res, next) => {
  try {
    const max = Math.max(
      1,
      Math.min(500, parseInt(req.query.max, 10) || failureClassifier.DEFAULT_MAX_PER_TICK || 50),
    )
    const result = await failureClassifier.runOnce({ max })
    res.json(result)
  } catch (err) { next(err) }
})

// POST /api/telemetry/outcome/:id/classify
// Tate-tagged ground-truth override (Phase D Task 4). Body shape:
//   { classification: 'usage_failure'|'surfacing_failure'|'doctrine_failure',
//     note?: string }
// Writes classification_tate_tagged + (optionally) appends to evidence.note.
// The auto-vs-Tate accuracy check uses this column as the ground-truth source;
// rows without a Tate-tagged value are excluded from accuracy computation.
router.post('/outcome/:id/classify', async (req, res, next) => {
  try {
    const id = req.params.id
    if (!id || !/^[0-9a-f-]{36}$/i.test(id)) {
      return res.status(400).json({ error: 'invalid_outcome_id' })
    }
    const classification = req.body && req.body.classification
    const note = req.body && typeof req.body.note === 'string' ? req.body.note : null
    if (!classification || !VALID_CLASSIFICATIONS.has(classification)) {
      return res.status(400).json({
        error: 'invalid_classification',
        allowed: Array.from(VALID_CLASSIFICATIONS),
      })
    }
    const { Client } = require('pg')
    const env = require('../config/env')
    const client = new Client({ connectionString: env.DATABASE_URL })
    await client.connect()
    try {
      const noteUpdate = note
        ? `, classification_evidence = COALESCE(classification_evidence, '{}'::jsonb) || jsonb_build_object('tate_note', $3::text)`
        : ''
      const params = note ? [id, classification, note] : [id, classification]
      const sql = `
        UPDATE outcome_event
           SET classification_tate_tagged = $2
               ${noteUpdate}
         WHERE id = $1
         RETURNING id,
                   outcome,
                   classification,
                   classification_tate_tagged,
                   classification_at,
                   classification_evidence
      `
      const r = await client.query(sql, params)
      if (r.rowCount === 0) {
        return res.status(404).json({ error: 'outcome_not_found', id })
      }
      res.json({ ok: true, outcome: r.rows[0] })
    } finally {
      try { await client.end() } catch { /* ignore */ }
    }
  } catch (err) { next(err) }
})

module.exports = router
