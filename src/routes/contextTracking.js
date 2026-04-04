const { Router } = require('express')
const { z } = require('zod')
const auth = require('../middleware/auth')
const validate = require('../middleware/validate')
const ctx = require('../services/contextTrackingService')

const router = Router()
router.use(auth)

// ─── Dismissed Items ────────────────────────────────────────────────────

router.post('/dismiss', validate(z.object({
  source: z.string().min(1),
  actionType: z.string().min(1),
  identifier: z.string().min(1),
  title: z.string().optional(),
  reason: z.string().optional(),
  metadata: z.record(z.any()).optional(),
  expiresAt: z.string().datetime().optional(),
  permanent: z.boolean().optional(),
})), async (req, res, next) => {
  try {
    const item = await ctx.dismiss(req.body)
    res.json(item || { status: 'already_dismissed' })
  } catch (err) { next(err) }
})

router.post('/undismiss', validate(z.object({
  source: z.string().min(1),
  actionType: z.string().min(1),
  identifier: z.string().min(1),
})), async (req, res, next) => {
  try {
    const item = await ctx.undismiss(req.body)
    if (!item) return res.status(404).json({ error: 'Item not found' })
    res.json(item)
  } catch (err) { next(err) }
})

router.get('/dismissed', async (req, res, next) => {
  try {
    const items = await ctx.getDismissedItems({
      itemType: req.query.type,
      source: req.query.source,
      limit: Math.min(parseInt(req.query.limit) || 50, 200),
      offset: parseInt(req.query.offset) || 0,
    })
    res.json(items)
  } catch (err) { next(err) }
})

router.get('/should-surface', async (req, res, next) => {
  try {
    const { source, type, identifier } = req.query
    if (!source || !type || !identifier) {
      return res.status(400).json({ error: 'source, type, and identifier are required' })
    }
    const itemKey = ctx.buildItemKey(source, type, identifier)
    const result = await ctx.shouldSurface(itemKey)
    res.json(result)
  } catch (err) { next(err) }
})

// ─── Resolved Issues ────────────────────────────────────────────────────

router.post('/resolve', validate(z.object({
  source: z.string().min(1),
  issueType: z.string().min(1),
  identifier: z.string().min(1),
  title: z.string().min(1),
  description: z.string().optional(),
  resolution: z.string().optional(),
  resolvedBy: z.string().optional(),
  sessionId: z.string().uuid().optional(),
  metadata: z.record(z.any()).optional(),
})), async (req, res, next) => {
  try {
    const issue = await ctx.resolve(req.body)
    res.json(issue || { status: 'already_resolved' })
  } catch (err) { next(err) }
})

router.post('/reopen', validate(z.object({
  source: z.string().min(1),
  issueType: z.string().min(1),
  identifier: z.string().min(1),
})), async (req, res, next) => {
  try {
    const issue = await ctx.reopen(req.body)
    if (!issue) return res.status(404).json({ error: 'Resolved issue not found' })
    res.json(issue)
  } catch (err) { next(err) }
})

router.get('/resolved', async (req, res, next) => {
  try {
    const issues = await ctx.getResolvedIssues({
      status: req.query.status,
      limit: Math.min(parseInt(req.query.limit) || 50, 200),
      offset: parseInt(req.query.offset) || 0,
    })
    res.json(issues)
  } catch (err) { next(err) }
})

// ─── User Preferences ───────────────────────────────────────────────────

router.post('/preferences', validate(z.object({
  category: z.string().min(1),
  key: z.string().min(1),
  description: z.string().min(1),
  value: z.record(z.any()).optional(),
  source: z.string().optional(),
})), async (req, res, next) => {
  try {
    const pref = await ctx.setPreference(req.body)
    res.json(pref)
  } catch (err) { next(err) }
})

router.get('/preferences', async (req, res, next) => {
  try {
    const prefs = await ctx.getPreferences({
      category: req.query.category,
      active: req.query.active !== 'false',
    })
    res.json(prefs)
  } catch (err) { next(err) }
})

router.delete('/preferences/:key', async (req, res, next) => {
  try {
    const pref = await ctx.removePreference(req.params.key)
    if (!pref) return res.status(404).json({ error: 'Preference not found' })
    res.json(pref)
  } catch (err) { next(err) }
})

// ─── Conversation Context ───────────────────────────────────────────────

router.post('/topics', validate(z.object({
  topic: z.string().min(1),
  summary: z.string().optional(),
  status: z.enum(['active', 'parked', 'resolved', 'abandoned']).optional(),
  sessionId: z.string().uuid().optional(),
  relatedItems: z.record(z.any()).optional(),
})), async (req, res, next) => {
  try {
    const topic = await ctx.upsertConversationContext(req.body)
    res.json(topic)
  } catch (err) { next(err) }
})

router.patch('/topics/:id', validate(z.object({
  summary: z.string().optional(),
  status: z.enum(['active', 'parked', 'resolved', 'abandoned']).optional(),
  sessionId: z.string().uuid().optional(),
  relatedItems: z.record(z.any()).optional(),
})), async (req, res, next) => {
  try {
    const topic = await ctx.updateConversationContext(req.params.id, req.body)
    if (!topic) return res.status(404).json({ error: 'Topic not found' })
    res.json(topic)
  } catch (err) { next(err) }
})

router.get('/topics', async (req, res, next) => {
  try {
    const topics = req.query.all === 'true'
      ? await ctx.getRecentContexts({ limit: parseInt(req.query.limit) || 20 })
      : await ctx.getActiveContexts({ limit: parseInt(req.query.limit) || 20 })
    res.json(topics)
  } catch (err) { next(err) }
})

// ─── Context Summary (for Cortex injection) ─────────────────────────────

router.get('/summary', async (_req, res, next) => {
  try {
    const summary = await ctx.getContextSummary()
    res.json({ summary })
  } catch (err) { next(err) }
})

module.exports = router
