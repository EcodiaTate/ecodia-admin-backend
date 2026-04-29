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
const episodeResurface = require('../services/episodeResurface')

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

// ─── Phase F (Layer 7) — Episode resurfacing ────────────────────────────

// GET /api/telemetry/episode-resurface?days=7
// Layer-7 dashboard: resurface frequency by hook + repeated-failure rate.
// See: ~/ecodiaos/patterns/decision-quality-self-optimization-architecture.md
router.get('/episode-resurface', async (req, res, next) => {
  try {
    const days = Math.max(1, Math.min(90, parseInt(req.query.days, 10) || 7))
    const [byHook, healthMetric] = await Promise.all([
      episodeResurface.getResurfaceFrequency({ days }),
      episodeResurface.getRepeatedFailureRate({ days: Math.max(days, 30) }),
    ])
    res.json({
      window_days: days,
      by_hook: byHook,
      health: healthMetric,
    })
  } catch (err) { next(err) }
})

// POST /api/telemetry/episode-resurface/run
// Run a Layer-7 semantic search for the supplied query text and (optionally)
// record the resurface_event rows. Caller passes:
//   { queryText, dispatchEventId?, hookName?, toolName?, limit?, minScore?,
//     metadataExtra?, recordRows?: boolean (default true) }
router.post('/episode-resurface/run', async (req, res, next) => {
  try {
    const body = req.body || {}
    const queryText = body.queryText || ''
    if (!queryText || typeof queryText !== 'string') {
      return res.status(400).json({ error: 'queryText (string) is required' })
    }
    const recordRows = body.recordRows !== false
    if (recordRows) {
      const result = await episodeResurface.runForDispatch({
        queryText,
        dispatchEventId: body.dispatchEventId,
        hookName: body.hookName,
        toolName: body.toolName,
        limit: body.limit,
        minScore: body.minScore,
        metadataExtra: body.metadataExtra,
      })
      return res.json(result)
    }
    const hits = await episodeResurface.resurfaceEpisodes(queryText, {
      limit: body.limit,
      minScore: body.minScore,
    })
    res.json({ hits, recorded: { inserted: 0, ids: [] } })
  } catch (err) { next(err) }
})

// POST /api/telemetry/episode-resurface/:id/acknowledge
// Body: { ack: boolean }
router.post('/episode-resurface/:id/acknowledge', async (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10)
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'invalid id' })
    const ack = req.body && req.body.ack === true
    const result = await episodeResurface.markAcknowledgement({ id, ack })
    res.json(result)
  } catch (err) { next(err) }
})

// POST /api/telemetry/episode-resurface/:id/repeated-failure
// Body: { repeated: boolean }
router.post('/episode-resurface/:id/repeated-failure', async (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10)
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'invalid id' })
    const repeated = req.body && req.body.repeated === true
    const result = await episodeResurface.markRepeatedFailure({ id, repeated })
    res.json(result)
  } catch (err) { next(err) }
})

module.exports = router
