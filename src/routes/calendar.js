const { Router } = require('express')
const { z } = require('zod')
const auth = require('../middleware/auth')
const validate = require('../middleware/validate')
const db = require('../config/db')
const calendarService = require('../services/calendarService')

const router = Router()
router.use(auth)

// GET /api/calendar/events — list events with optional date range
router.get('/events', async (req, res, next) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 50, 200)
    const offset = parseInt(req.query.offset) || 0
    const from = req.query.from || new Date().toISOString()
    const to = req.query.to || new Date(Date.now() + 30 * 86400000).toISOString()

    const events = await db`
      SELECT * FROM calendar_events
      WHERE start_time >= ${from}
        AND start_time <= ${to}
        AND status = 'confirmed'
      ORDER BY start_time ASC
      LIMIT ${limit} OFFSET ${offset}
    `

    const [{ count }] = await db`
      SELECT count(*)::int FROM calendar_events
      WHERE start_time >= ${from}
        AND start_time <= ${to}
        AND status = 'confirmed'
    `

    res.json({ events, total: count })
  } catch (err) {
    next(err)
  }
})

// GET /api/calendar/events/today
router.get('/events/today', async (req, res, next) => {
  try {
    const events = await calendarService.getToday()
    res.json(events)
  } catch (err) {
    next(err)
  }
})

// GET /api/calendar/events/upcoming
router.get('/events/upcoming', async (req, res, next) => {
  try {
    const hours = parseInt(req.query.hours) || 24
    const events = await calendarService.getUpcoming({ hours })
    res.json(events)
  } catch (err) {
    next(err)
  }
})

// GET /api/calendar/events/:id
router.get('/events/:id', async (req, res, next) => {
  try {
    const [event] = await db`SELECT * FROM calendar_events WHERE id = ${req.params.id}`
    if (!event) return res.status(404).json({ error: 'Event not found' })
    res.json(event)
  } catch (err) {
    next(err)
  }
})

// POST /api/calendar/events — create a new event
const createEventSchema = z.object({
  summary: z.string().min(1),
  description: z.string().optional(),
  location: z.string().optional(),
  startTime: z.string(),
  endTime: z.string(),
  attendees: z.array(z.string().email()).optional(),
  calendar: z.string().email().default(require('../config/env').GOOGLE_PRIMARY_ACCOUNT),
})

router.post('/events', validate(createEventSchema), async (req, res, next) => {
  try {
    const event = await calendarService.createEvent(req.body.calendar, req.body)
    res.status(201).json(event)
  } catch (err) {
    next(err)
  }
})

// PATCH /api/calendar/events/:id
router.patch('/events/:id', async (req, res, next) => {
  try {
    const [event] = await db`SELECT * FROM calendar_events WHERE id = ${req.params.id}`
    if (!event) return res.status(404).json({ error: 'Event not found' })

    const updated = await calendarService.updateEvent(
      event.source_calendar,
      event.google_event_id,
      req.body,
    )
    res.json(updated)
  } catch (err) {
    next(err)
  }
})

// DELETE /api/calendar/events/:id
router.delete('/events/:id', async (req, res, next) => {
  try {
    const [event] = await db`SELECT * FROM calendar_events WHERE id = ${req.params.id}`
    if (!event) return res.status(404).json({ error: 'Event not found' })

    await calendarService.deleteEvent(event.source_calendar, event.google_event_id)
    res.json({ status: 'deleted' })
  } catch (err) {
    next(err)
  }
})

// POST /api/calendar/sync — manual sync trigger
router.post('/sync', async (req, res, next) => {
  try {
    await calendarService.pollCalendars()
    res.json({ status: 'ok' })
  } catch (err) {
    next(err)
  }
})

// GET /api/calendar/stats
router.get('/stats', async (req, res, next) => {
  try {
    const stats = await calendarService.getStats()
    res.json(stats)
  } catch (err) {
    next(err)
  }
})

module.exports = router
