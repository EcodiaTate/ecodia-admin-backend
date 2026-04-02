const { google } = require('googleapis')
const env = require('../config/env')
const db = require('../config/db')
const logger = require('../config/logger')
const kgHooks = require('./kgIngestionHooks')

const CALENDARS = ['tate@ecodia.au']

// ─── Calendar Client ────────────────────────────────────────────────────

function getCalendarClient(userEmail) {
  const credentials = JSON.parse(env.GOOGLE_SERVICE_ACCOUNT_JSON)
  const privateKey = credentials.private_key.replace(/\\n/g, '\n')
  const auth = new google.auth.JWT({
    email: credentials.client_email,
    key: privateKey,
    scopes: [
      'https://www.googleapis.com/auth/calendar',
    ],
    subject: userEmail,
  })
  return google.calendar({ version: 'v3', auth })
}

// ─── Sync ───────────────────────────────────────────────────────────────

async function pollCalendars() {
  for (const calendarEmail of CALENDARS) {
    try {
      logger.info(`Polling calendar: ${calendarEmail}`)
      const calendar = getCalendarClient(calendarEmail)

      const [syncState] = await db`
        SELECT * FROM calendar_sync_state WHERE id = ${calendarEmail}
      `

      if (syncState?.sync_token) {
        await incrementalSync(calendar, calendarEmail, syncState.sync_token)
      } else {
        await fullSync(calendar, calendarEmail)
      }
    } catch (err) {
      logger.error(`Failed to poll calendar ${calendarEmail}`, { error: err.message })
    }
  }
}

async function fullSync(calendar, calendarEmail) {
  logger.info(`Full calendar sync: ${calendarEmail}`)

  // Sync events from 30 days ago to 90 days ahead
  const timeMin = new Date(Date.now() - 30 * 86400000).toISOString()
  const timeMax = new Date(Date.now() + 90 * 86400000).toISOString()

  let pageToken = null
  let nextSyncToken = null
  let total = 0

  do {
    const res = await calendar.events.list({
      calendarId: 'primary',
      timeMin,
      timeMax,
      maxResults: 100,
      singleEvents: true,
      orderBy: 'startTime',
      pageToken,
    })

    const events = res.data.items || []
    for (const event of events) {
      await upsertEvent(event, calendarEmail)
      total++
    }

    pageToken = res.data.nextPageToken
    nextSyncToken = res.data.nextSyncToken
  } while (pageToken)

  // Store sync token for incremental sync
  if (nextSyncToken) {
    await db`
      INSERT INTO calendar_sync_state (id, sync_token, updated_at)
      VALUES (${calendarEmail}, ${nextSyncToken}, now())
      ON CONFLICT (id) DO UPDATE SET sync_token = ${nextSyncToken}, updated_at = now()
    `
  }

  logger.info(`Full calendar sync complete: ${calendarEmail} (${total} events)`)
}

async function incrementalSync(calendar, calendarEmail, syncToken) {
  try {
    let pageToken = null
    let nextSyncToken = null
    let total = 0

    do {
      const res = await calendar.events.list({
        calendarId: 'primary',
        syncToken,
        pageToken,
      })

      const events = res.data.items || []
      for (const event of events) {
        if (event.status === 'cancelled') {
          await db`
            UPDATE calendar_events SET status = 'cancelled', updated_at = now()
            WHERE google_event_id = ${event.id}
          `
        } else {
          await upsertEvent(event, calendarEmail)
        }
        total++
      }

      pageToken = res.data.nextPageToken
      nextSyncToken = res.data.nextSyncToken
    } while (pageToken)

    if (nextSyncToken) {
      await db`
        UPDATE calendar_sync_state SET sync_token = ${nextSyncToken}, updated_at = now()
        WHERE id = ${calendarEmail}
      `
    }

    if (total > 0) {
      logger.info(`Incremental calendar sync: ${calendarEmail} (${total} changes)`)
    }
  } catch (err) {
    if (err.code === 410) {
      // Sync token expired — full sync
      logger.warn(`Calendar sync token expired for ${calendarEmail}, falling back to full sync`)
      await db`UPDATE calendar_sync_state SET sync_token = null WHERE id = ${calendarEmail}`
      await fullSync(calendar, calendarEmail)
    } else {
      throw err
    }
  }
}

// ─── Event Upsert ───────────────────────────────────────────────────────

async function upsertEvent(event, calendarEmail) {
  // Check if event already exists (to avoid duplicate KG ingestion on re-sync)
  const [existing] = await db`
    SELECT id, summary, start_time FROM calendar_events WHERE google_event_id = ${event.id}
  `

  const start = event.start?.dateTime || event.start?.date
  const end = event.end?.dateTime || event.end?.date
  const allDay = !event.start?.dateTime

  // Extract conference link
  let conferenceLink = null
  if (event.conferenceData?.entryPoints) {
    const videoEntry = event.conferenceData.entryPoints.find(e => e.entryPointType === 'video')
    conferenceLink = videoEntry?.uri || null
  }
  if (!conferenceLink && event.hangoutLink) {
    conferenceLink = event.hangoutLink
  }

  const attendees = (event.attendees || []).map(a => ({
    email: a.email,
    name: a.displayName || null,
    responseStatus: a.responseStatus,
    organizer: a.organizer || false,
    self: a.self || false,
  }))

  const [upserted] = await db`
    INSERT INTO calendar_events (
      google_event_id, calendar_id, summary, description, location,
      start_time, end_time, all_day, status,
      organizer_email, organizer_name, attendees,
      recurring_event_id, html_link, conference_link,
      source_calendar, raw_data
    ) VALUES (
      ${event.id}, ${event.calendarId || 'primary'},
      ${event.summary || null}, ${event.description || null}, ${event.location || null},
      ${start}, ${end}, ${allDay}, ${event.status || 'confirmed'},
      ${event.organizer?.email || null}, ${event.organizer?.displayName || null},
      ${JSON.stringify(attendees)},
      ${event.recurringEventId || null}, ${event.htmlLink || null}, ${conferenceLink},
      ${calendarEmail}, ${JSON.stringify(event)}
    )
    ON CONFLICT (google_event_id) DO UPDATE SET
      summary = EXCLUDED.summary,
      description = EXCLUDED.description,
      location = EXCLUDED.location,
      start_time = EXCLUDED.start_time,
      end_time = EXCLUDED.end_time,
      all_day = EXCLUDED.all_day,
      status = EXCLUDED.status,
      organizer_email = EXCLUDED.organizer_email,
      organizer_name = EXCLUDED.organizer_name,
      attendees = EXCLUDED.attendees,
      recurring_event_id = EXCLUDED.recurring_event_id,
      html_link = EXCLUDED.html_link,
      conference_link = EXCLUDED.conference_link,
      raw_data = EXCLUDED.raw_data,
      updated_at = now()
    RETURNING *
  `

  // Only fire KG hook for new events or meaningful changes (time/summary moved)
  const isNew = !existing
  const changed = existing && (
    existing.summary !== upserted.summary ||
    new Date(existing.start_time).getTime() !== new Date(upserted.start_time).getTime()
  )

  if (isNew || changed) {
    kgHooks.onCalendarEventProcessed({
      event: upserted,
      calendarEmail,
    }).catch(() => {})
  }

  return upserted
}

// ─── Create Event ───────────────────────────────────────────────────────

async function createEvent(calendarEmail, { summary, description, location, startTime, endTime, attendees, conferenceLink }) {
  const calendar = getCalendarClient(calendarEmail)

  // Detect date-only strings (e.g. "2026-04-05") vs dateTime (e.g. "2026-04-05T09:00:00")
  const isDateOnly = (v) => /^\d{4}-\d{2}-\d{2}$/.test(v)
  const startIsDate = isDateOnly(startTime)
  const endIsDate = isDateOnly(endTime)

  // Both must be the same type — if mismatched, coerce both to dateTime
  let startField, endField
  if (startIsDate && endIsDate) {
    startField = { date: startTime }
    endField = { date: endTime }
  } else {
    // Coerce date-only to dateTime at midnight Brisbane time if needed
    const toDateTime = (v) => isDateOnly(v) ? `${v}T00:00:00` : v
    startField = { dateTime: toDateTime(startTime), timeZone: 'Australia/Brisbane' }
    endField = { dateTime: toDateTime(endTime), timeZone: 'Australia/Brisbane' }
  }

  const eventBody = {
    summary,
    description: description || undefined,
    location: location || undefined,
    start: startField,
    end: endField,
    attendees: (attendees || []).map(email => ({ email })),
  }

  // Request Google Meet if no conference link provided
  if (!conferenceLink) {
    eventBody.conferenceData = {
      createRequest: { requestId: `ecodia-${Date.now()}` },
    }
  }

  const res = await calendar.events.insert({
    calendarId: 'primary',
    resource: eventBody,
    conferenceDataVersion: 1,
    sendUpdates: 'all',
  })

  // Store locally
  await upsertEvent(res.data, calendarEmail)
  return res.data
}

// ─── Update Event ───────────────────────────────────────────────────────

async function updateEvent(calendarEmail, googleEventId, updates) {
  const calendar = getCalendarClient(calendarEmail)

  const patch = {}
  if (updates.summary) patch.summary = updates.summary
  if (updates.description !== undefined) patch.description = updates.description
  if (updates.location !== undefined) patch.location = updates.location
  if (updates.startTime) {
    patch.start = /^\d{4}-\d{2}-\d{2}$/.test(updates.startTime)
      ? { date: updates.startTime }
      : { dateTime: updates.startTime, timeZone: 'Australia/Brisbane' }
  }
  if (updates.endTime) {
    patch.end = /^\d{4}-\d{2}-\d{2}$/.test(updates.endTime)
      ? { date: updates.endTime }
      : { dateTime: updates.endTime, timeZone: 'Australia/Brisbane' }
  }

  const res = await calendar.events.patch({
    calendarId: 'primary',
    eventId: googleEventId,
    resource: patch,
    sendUpdates: 'all',
  })

  await upsertEvent(res.data, calendarEmail)
  return res.data
}

// ─── Delete Event ───────────────────────────────────────────────────────

async function deleteEvent(calendarEmail, googleEventId) {
  const calendar = getCalendarClient(calendarEmail)

  await calendar.events.delete({
    calendarId: 'primary',
    eventId: googleEventId,
    sendUpdates: 'all',
  })

  await db`
    UPDATE calendar_events SET status = 'cancelled', updated_at = now()
    WHERE google_event_id = ${googleEventId}
  `
}

// ─── Quick Actions for Cortex ───────────────────────────────────────────

async function getUpcoming({ hours = 24, limit = 10 } = {}) {
  const events = await db`
    SELECT * FROM calendar_events
    WHERE start_time >= now()
      AND start_time <= now() + interval '${db.unsafe(hours)} hours'
      AND status = 'confirmed'
    ORDER BY start_time ASC
    LIMIT ${limit}
  `
  return events
}

async function getToday() {
  const events = await db`
    SELECT * FROM calendar_events
    WHERE start_time >= date_trunc('day', now() AT TIME ZONE 'Australia/Brisbane') AT TIME ZONE 'Australia/Brisbane'
      AND start_time < date_trunc('day', now() AT TIME ZONE 'Australia/Brisbane') AT TIME ZONE 'Australia/Brisbane' + interval '1 day'
      AND status = 'confirmed'
    ORDER BY start_time ASC
  `
  return events
}

async function getStats() {
  const [stats] = await db`
    SELECT
      count(*) FILTER (WHERE start_time >= now() AND start_time <= now() + interval '24 hours' AND status = 'confirmed')::int AS next_24h,
      count(*) FILTER (WHERE start_time >= now() AND start_time <= now() + interval '7 days' AND status = 'confirmed')::int AS next_7d,
      count(*) FILTER (WHERE start_time >= date_trunc('day', now() AT TIME ZONE 'Australia/Brisbane') AT TIME ZONE 'Australia/Brisbane'
                       AND start_time < date_trunc('day', now() AT TIME ZONE 'Australia/Brisbane') AT TIME ZONE 'Australia/Brisbane' + interval '1 day'
                       AND status = 'confirmed')::int AS today
    FROM calendar_events
  `
  return stats
}

// ─── Proactive Meeting Prep ────────────────────────────────────────────
// Surfaces upcoming meetings that might need prep work to the action queue.
// Runs after each poll cycle — AI decides what needs attention.

async function surfaceUpcomingMeetingPrep() {
  const deepseekService = require('./deepseekService')
  const actionQueue = require('./actionQueueService')

  // Get meetings in the next 4 hours that haven't been surfaced yet
  const upcoming = await db`
    SELECT ce.*,
      NOT EXISTS (
        SELECT 1 FROM action_queue aq
        WHERE aq.source = 'calendar' AND aq.source_ref_id = ce.id::text
        AND aq.created_at > now() - interval '24 hours'
      ) AS not_surfaced
    FROM calendar_events ce
    WHERE ce.start_time >= now()
      AND ce.start_time <= now() + interval '4 hours'
      AND ce.status = 'confirmed'
      AND NOT ce.all_day
    ORDER BY ce.start_time ASC
  `

  const needsSurfacing = upcoming.filter(e => e.not_surfaced)
  if (needsSurfacing.length === 0) return

  for (const event of needsSurfacing) {
    try {
      const attendees = typeof event.attendees === 'string' ? JSON.parse(event.attendees) : (event.attendees || [])
      const people = attendees.filter(a => !a.self).map(a => a.name || a.email).join(', ')

      const prompt = `Upcoming event for Tate — is there anything worth flagging or prepping for?

Event: ${event.summary}
Time: ${new Date(event.start_time).toLocaleString('en-AU', { timeZone: 'Australia/Brisbane' })}
${event.location ? `Location: ${event.location}` : ''}
${people ? `Attendees: ${people}` : ''}
${event.description ? `Description: ${(event.description || '').slice(0, 500)}` : ''}
${event.conference_link ? 'Has video call link' : ''}

Respond as JSON:
{
  "shouldSurface": true/false,
  "title": "prep reminder title",
  "summary": "what Tate should know or do beforehand",
  "priority": "low|medium|high"
}`

      const raw = await deepseekService.callDeepSeek(
        [{ role: 'user', content: prompt }],
        { module: 'calendar', skipRetrieval: false, contextQuery: `${event.summary} ${people}` }
      )

      const result = JSON.parse(raw.replace(/```json?\s*/g, '').replace(/```/g, '').trim())
      if (result.shouldSurface) {
        await actionQueue.enqueue({
          source: 'calendar',
          sourceRefId: String(event.id),
          actionType: 'follow_up',
          title: result.title || `Prep: ${event.summary}`,
          summary: result.summary,
          preparedData: { eventSummary: event.summary, startTime: event.start_time, attendees: people },
          context: { googleEventId: event.google_event_id, conferenceLink: event.conference_link },
          priority: result.priority || 'medium',
          expiresInHours: 4,
        })
      }
    } catch (err) {
      logger.debug(`Calendar prep surfacing failed for ${event.id}`, { error: err.message })
    }
  }
}

module.exports = {
  pollCalendars,
  createEvent,
  updateEvent,
  deleteEvent,
  getUpcoming,
  getToday,
  getStats,
  getCalendarClient,
  surfaceUpcomingMeetingPrep,
}
