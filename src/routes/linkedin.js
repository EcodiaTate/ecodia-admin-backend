const { Router } = require('express')
const { z } = require('zod')
const auth = require('../middleware/auth')
const validate = require('../middleware/validate')
const linkedinService = require('../services/linkedinService')
const queries = require('../db/queries/linkedin')

const router = Router()
router.use(auth)

// ═══════════════════════════════════════════════════════════════════════
// DMs
// ═══════════════════════════════════════════════════════════════════════

router.get('/dms', async (req, res, next) => {
  try {
    const { limit, offset, status, category, priority, search } = req.query
    const result = await queries.getDMs({
      limit: Math.min(parseInt(limit) || 15, 200),
      offset: parseInt(offset) || 0,
      status, category, priority, search,
    })
    res.json(result)
  } catch (err) { next(err) }
})

router.get('/dms/stats', async (req, res, next) => {
  try {
    res.json(await queries.getDMStats())
  } catch (err) { next(err) }
})

router.get('/dms/:id', async (req, res, next) => {
  try {
    const dm = await queries.getDMById(req.params.id)
    if (!dm) return res.status(404).json({ error: 'DM not found' })
    res.json(dm)
  } catch (err) { next(err) }
})

router.post('/dms/:id/triage', async (req, res, next) => {
  try {
    const result = await linkedinService.triageDM(req.params.id)
    res.json(result)
  } catch (err) { next(err) }
})

router.post('/dms/:id/draft-reply', async (req, res, next) => {
  try {
    const result = await linkedinService.draftDMReply(req.params.id)
    res.json(result)
  } catch (err) { next(err) }
})

router.post('/dms/:id/send', async (req, res, next) => {
  try {
    const result = await linkedinService.sendDMReply(req.params.id)
    res.json(result)
  } catch (err) { next(err) }
})

const updateDMSchema = z.object({
  status: z.enum(['unread', 'drafting', 'replied', 'ignored']).optional(),
  category: z.enum(['lead', 'networking', 'recruiter', 'spam', 'support', 'personal', 'uncategorized']).optional(),
  priority: z.enum(['urgent', 'high', 'normal', 'low', 'spam']).optional(),
})

router.patch('/dms/:id', validate(updateDMSchema), async (req, res, next) => {
  try {
    const result = await queries.updateDM(req.params.id, req.body)
    if (!result) return res.status(404).json({ error: 'DM not found' })
    res.json(result)
  } catch (err) { next(err) }
})

const linkClientSchema = z.object({ clientId: z.string().uuid() })

router.post('/dms/:id/link-client', validate(linkClientSchema), async (req, res, next) => {
  try {
    const result = await linkedinService.linkDMToClient(req.params.id, req.body.clientId)
    res.json(result)
  } catch (err) { next(err) }
})

router.post('/dms/:id/analyze-lead', async (req, res, next) => {
  try {
    const result = await linkedinService.analyzeLeadSignals(req.params.id)
    res.json(result)
  } catch (err) { next(err) }
})

// ═══════════════════════════════════════════════════════════════════════
// Posts
// ═══════════════════════════════════════════════════════════════════════

router.get('/posts', async (req, res, next) => {
  try {
    const { status, type, theme, limit, offset } = req.query
    const posts = await queries.getPosts({
      status, type, theme,
      limit: Math.min(parseInt(limit) || 20, 100),
      offset: parseInt(offset) || 0,
    })
    res.json(posts)
  } catch (err) { next(err) }
})

router.get('/posts/calendar', async (req, res, next) => {
  try {
    const startDate = req.query.start || new Date(Date.now() - 30 * 86400000).toISOString()
    const endDate = req.query.end || new Date(Date.now() + 30 * 86400000).toISOString()
    const posts = await queries.getPostsCalendar(startDate, endDate)
    res.json(posts)
  } catch (err) { next(err) }
})

router.get('/posts/analytics', async (req, res, next) => {
  try {
    res.json(await queries.getPostAnalytics())
  } catch (err) { next(err) }
})

router.get('/posts/suggest-times', async (req, res, next) => {
  try {
    res.json(await linkedinService.suggestPostTimes())
  } catch (err) { next(err) }
})

const createPostSchema = z.object({
  content: z.string().min(1).max(3000),
  postType: z.enum(['text', 'image', 'carousel', 'poll', 'article', 'video']).default('text'),
  hashtags: z.array(z.string()).optional(),
  mediaPaths: z.array(z.string()).optional(),
  scheduledAt: z.string().datetime().optional(),
  theme: z.string().optional(),
  aiGenerated: z.boolean().optional(),
  aiPrompt: z.string().optional(),
})

router.post('/posts', validate(createPostSchema), async (req, res, next) => {
  try {
    const post = await queries.createPost(req.body)
    res.status(201).json(post)
  } catch (err) { next(err) }
})

router.get('/posts/:id', async (req, res, next) => {
  try {
    const post = await queries.getPostById(req.params.id)
    if (!post) return res.status(404).json({ error: 'Post not found' })
    res.json(post)
  } catch (err) { next(err) }
})

const updatePostSchema = z.object({
  content: z.string().min(1).max(3000).optional(),
  postType: z.enum(['text', 'image', 'carousel', 'poll', 'article', 'video']).optional(),
  hashtags: z.array(z.string()).optional(),
  scheduledAt: z.string().datetime().optional(),
  theme: z.string().optional(),
})

router.patch('/posts/:id', validate(updatePostSchema), async (req, res, next) => {
  try {
    const updates = { ...req.body }
    if (req.body.scheduledAt) updates.status = 'scheduled'
    if (req.body.postType) updates.post_type = req.body.postType
    if (req.body.scheduledAt) updates.scheduled_at = req.body.scheduledAt
    const result = await queries.updatePost(req.params.id, updates)
    if (!result) return res.status(404).json({ error: 'Post not found' })
    res.json(result)
  } catch (err) { next(err) }
})

router.delete('/posts/:id', async (req, res, next) => {
  try {
    const result = await queries.deletePost(req.params.id)
    if (!result) return res.status(404).json({ error: 'Post not found or cannot be deleted' })
    res.json({ deleted: true })
  } catch (err) { next(err) }
})

router.post('/posts/:id/schedule', validate(z.object({ scheduledAt: z.string().datetime() })), async (req, res, next) => {
  try {
    const result = await queries.updatePost(req.params.id, { scheduled_at: req.body.scheduledAt, status: 'scheduled' })
    if (!result) return res.status(404).json({ error: 'Post not found' })
    res.json(result)
  } catch (err) { next(err) }
})

const generatePostSchema = z.object({
  theme: z.string().min(1),
  postType: z.enum(['text', 'poll', 'carousel']).optional(),
})

router.post('/posts/generate', validate(generatePostSchema), async (req, res, next) => {
  try {
    const result = await linkedinService.generatePostContent(req.body.theme, { postType: req.body.postType })
    res.json(result)
  } catch (err) { next(err) }
})

// ═══════════════════════════════════════════════════════════════════════
// Profiles
// ═══════════════════════════════════════════════════════════════════════

router.get('/profiles', async (req, res, next) => {
  try {
    const profiles = await queries.getProfiles({
      limit: Math.min(parseInt(req.query.limit) || 20, 100),
      offset: parseInt(req.query.offset) || 0,
      search: req.query.search,
    })
    res.json(profiles)
  } catch (err) { next(err) }
})

router.get('/profiles/:id', async (req, res, next) => {
  try {
    const profile = await queries.getProfileById(req.params.id)
    if (!profile) return res.status(404).json({ error: 'Profile not found' })
    res.json(profile)
  } catch (err) { next(err) }
})

router.post('/profiles/:id/scrape', async (req, res, next) => {
  try {
    const profile = await queries.getProfileById(req.params.id)
    if (!profile) return res.status(404).json({ error: 'Profile not found' })
    const result = await linkedinService.scrapeAndSaveProfile(profile.linkedin_url)
    res.json(result)
  } catch (err) { next(err) }
})

router.post('/profiles/:id/link-client', validate(linkClientSchema), async (req, res, next) => {
  try {
    const result = await linkedinService.linkProfileToClient(req.params.id, req.body.clientId)
    if (!result) return res.status(404).json({ error: 'Profile not found' })
    res.json(result)
  } catch (err) { next(err) }
})

// ═══════════════════════════════════════════════════════════════════════
// Connection Requests
// ═══════════════════════════════════════════════════════════════════════

router.get('/connections/requests', async (req, res, next) => {
  try {
    const requests = await queries.getConnectionRequests({
      status: req.query.status || 'pending',
      limit: Math.min(parseInt(req.query.limit) || 30, 100),
    })
    res.json(requests)
  } catch (err) { next(err) }
})

router.post('/connections/requests/:id/accept', async (req, res, next) => {
  try {
    const result = await linkedinService.acceptConnection(req.params.id)
    res.json(result)
  } catch (err) { next(err) }
})

router.post('/connections/requests/:id/decline', async (req, res, next) => {
  try {
    const result = await linkedinService.declineConnection(req.params.id)
    res.json(result)
  } catch (err) { next(err) }
})

const batchSchema = z.object({
  ids: z.array(z.string().uuid()).min(1),
  action: z.enum(['accept', 'decline']),
})

router.post('/connections/requests/batch', validate(batchSchema), async (req, res, next) => {
  try {
    const results = []
    for (const id of req.body.ids) {
      try {
        if (req.body.action === 'accept') {
          results.push(await linkedinService.acceptConnection(id))
        } else {
          results.push(await linkedinService.declineConnection(id))
        }
      } catch (err) {
        results.push({ id, error: err.message })
      }
    }
    res.json({ results })
  } catch (err) { next(err) }
})

// ═══════════════════════════════════════════════════════════════════════
// Analytics
// ═══════════════════════════════════════════════════════════════════════

router.get('/analytics/network', async (req, res, next) => {
  try {
    const days = parseInt(req.query.days) || 30
    const snapshots = await queries.getNetworkSnapshots(days)
    res.json(snapshots)
  } catch (err) { next(err) }
})

router.get('/analytics/posts', async (req, res, next) => {
  try {
    res.json(await queries.getPostAnalytics())
  } catch (err) { next(err) }
})

router.get('/analytics/summary', async (req, res, next) => {
  try {
    res.json(await queries.getAnalyticsSummary())
  } catch (err) { next(err) }
})

// ═══════════════════════════════════════════════════════════════════════
// Content Themes
// ═══════════════════════════════════════════════════════════════════════

router.get('/content-themes', async (req, res, next) => {
  try {
    res.json(await queries.getContentThemes())
  } catch (err) { next(err) }
})

const themeSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  dayOfWeek: z.number().min(0).max(6).optional(),
  timeOfDay: z.string().optional(),
  promptTemplate: z.string().optional(),
  active: z.boolean().optional(),
})

router.post('/content-themes', validate(themeSchema), async (req, res, next) => {
  try {
    const theme = await queries.createContentTheme(req.body)
    res.status(201).json(theme)
  } catch (err) { next(err) }
})

router.patch('/content-themes/:id', validate(themeSchema.partial()), async (req, res, next) => {
  try {
    const theme = await queries.updateContentTheme(req.params.id, req.body)
    if (!theme) return res.status(404).json({ error: 'Theme not found' })
    res.json(theme)
  } catch (err) { next(err) }
})

router.delete('/content-themes/:id', async (req, res, next) => {
  try {
    const theme = await queries.deleteContentTheme(req.params.id)
    if (!theme) return res.status(404).json({ error: 'Theme not found' })
    res.json({ deleted: true })
  } catch (err) { next(err) }
})

// ═══════════════════════════════════════════════════════════════════════
// Worker / Session
// ═══════════════════════════════════════════════════════════════════════

router.get('/worker/status', async (req, res, next) => {
  try {
    res.json(await linkedinService.getWorkerStatus())
  } catch (err) { next(err) }
})

router.post('/worker/resume', async (req, res, next) => {
  try {
    await linkedinService.resumeWorker()
    res.json({ status: 'ok' })
  } catch (err) { next(err) }
})

router.post('/worker/trigger/:jobType', async (req, res, next) => {
  try {
    const { triggerJob } = require('../workers/linkedinWorker')
    const result = await triggerJob(req.params.jobType)
    res.json(result)
  } catch (err) { next(err) }
})

router.get('/worker/logs', async (req, res, next) => {
  try {
    const logs = await queries.getRecentScrapeLogs(parseInt(req.query.limit) || 20)
    res.json(logs)
  } catch (err) { next(err) }
})

router.post('/session/cookie', validate(z.object({ cookie: z.string().min(10) })), async (req, res, next) => {
  try {
    await linkedinService.setSessionCookie(req.body.cookie)
    res.json({ status: 'ok' })
  } catch (err) { next(err) }
})

router.get('/session/status', async (req, res, next) => {
  try {
    res.json(await linkedinService.getWorkerStatus())
  } catch (err) { next(err) }
})

module.exports = router
