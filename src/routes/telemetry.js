/**
 * /api/telemetry routes - Phase B observability for the Decision Quality
 * Self-Optimization Architecture.
 *
 * See:
 *   ~/ecodiaos/patterns/decision-quality-self-optimization-architecture.md
 *
 * Endpoints:
 *   GET  /api/telemetry/decision-quality?days=7   - 4-panel dashboard
 *   GET  /api/telemetry/drift                     - active drift flags
 *   POST /api/telemetry/consume                   - one-shot trigger of the
 *                                                   batch consumer (admin/cron use)
 *   POST /api/telemetry/infer-outcomes            - one-shot trigger of the
 *                                                   outcome inferrer (admin/cron use)
 *
 * All routes require auth (Bearer token / MCP_INTERNAL_TOKEN). The dashboard
 * route is read-only; consume + infer-outcomes mutate by inserting rows.
 */

'use strict'

const express = require('express')
const router = express.Router()
const auth = require('../middleware/auth')
const decisionQualityService = require('../services/telemetry/decisionQualityService')
const dispatchEventConsumer = require('../services/telemetry/dispatchEventConsumer')
const outcomeInference = require('../services/telemetry/outcomeInference')

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

module.exports = router
