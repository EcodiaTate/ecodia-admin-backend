/**
 * Calendar MCP tools — read, create, update, delete events.
 */
import { getCalendarClient, primaryAccount } from './auth.js'

export function registerCalendarTools(server) {

  server.tool('calendar_list_events', {
    description: 'List calendar events within a time range.',
    inputSchema: {
      type: 'object',
      properties: {
        timeMin: { type: 'string', description: 'Start of range (ISO 8601, e.g. "2026-04-06T00:00:00Z"). Default: now' },
        timeMax: { type: 'string', description: 'End of range (ISO 8601). Default: 7 days from now' },
        maxResults: { type: 'number', description: 'Max events (default 25)' },
        calendarId: { type: 'string', description: 'Calendar ID (default: "primary")' },
        account: { type: 'string', description: 'Google account email (default: primary)' },
      },
    },
  }, async ({ timeMin, timeMax, maxResults = 25, calendarId = 'primary', account }) => {
    const cal = getCalendarClient(account || primaryAccount)
    const now = new Date()
    const res = await cal.events.list({
      calendarId,
      timeMin: timeMin || now.toISOString(),
      timeMax: timeMax || new Date(now.getTime() + 7 * 86400000).toISOString(),
      maxResults,
      singleEvents: true,
      orderBy: 'startTime',
    })
    const events = (res.data.items || []).map(e => ({
      id: e.id,
      summary: e.summary,
      start: e.start?.dateTime || e.start?.date,
      end: e.end?.dateTime || e.end?.date,
      location: e.location,
      description: e.description?.slice(0, 500),
      attendees: e.attendees?.map(a => `${a.email} (${a.responseStatus})`),
      status: e.status,
      htmlLink: e.htmlLink,
    }))
    return { content: [{ type: 'text', text: JSON.stringify(events, null, 2) }] }
  })

  server.tool('calendar_get_event', {
    description: 'Get full details of a calendar event.',
    inputSchema: {
      type: 'object',
      properties: {
        eventId: { type: 'string', description: 'Event ID' },
        calendarId: { type: 'string', description: 'Calendar ID (default: "primary")' },
        account: { type: 'string', description: 'Google account email (default: primary)' },
      },
      required: ['eventId'],
    },
  }, async ({ eventId, calendarId = 'primary', account }) => {
    const cal = getCalendarClient(account || primaryAccount)
    const res = await cal.events.get({ calendarId, eventId })
    return { content: [{ type: 'text', text: JSON.stringify(res.data, null, 2) }] }
  })

  server.tool('calendar_create_event', {
    description: 'Create a new calendar event.',
    inputSchema: {
      type: 'object',
      properties: {
        summary: { type: 'string', description: 'Event title' },
        start: { type: 'string', description: 'Start time (ISO 8601 dateTime or date)' },
        end: { type: 'string', description: 'End time (ISO 8601 dateTime or date)' },
        description: { type: 'string', description: 'Event description' },
        location: { type: 'string', description: 'Event location' },
        attendees: { type: 'array', items: { type: 'string' }, description: 'Attendee emails' },
        calendarId: { type: 'string', description: 'Calendar ID (default: "primary")' },
        account: { type: 'string', description: 'Google account email (default: primary)' },
      },
      required: ['summary', 'start', 'end'],
    },
  }, async ({ summary, start, end, description, location, attendees, calendarId = 'primary', account }) => {
    const cal = getCalendarClient(account || primaryAccount)
    const isAllDay = !start.includes('T')
    const event = {
      summary,
      start: isAllDay ? { date: start } : { dateTime: start },
      end: isAllDay ? { date: end } : { dateTime: end },
      description,
      location,
      attendees: attendees?.map(email => ({ email })),
    }
    const res = await cal.events.insert({ calendarId, requestBody: event, sendUpdates: 'all' })
    return { content: [{ type: 'text', text: `Event created: ${res.data.htmlLink}` }] }
  })

  server.tool('calendar_update_event', {
    description: 'Update an existing calendar event.',
    inputSchema: {
      type: 'object',
      properties: {
        eventId: { type: 'string', description: 'Event ID to update' },
        summary: { type: 'string', description: 'New title' },
        start: { type: 'string', description: 'New start time' },
        end: { type: 'string', description: 'New end time' },
        description: { type: 'string', description: 'New description' },
        location: { type: 'string', description: 'New location' },
        calendarId: { type: 'string', description: 'Calendar ID (default: "primary")' },
        account: { type: 'string', description: 'Google account email (default: primary)' },
      },
      required: ['eventId'],
    },
  }, async ({ eventId, summary, start, end, description, location, calendarId = 'primary', account }) => {
    const cal = getCalendarClient(account || primaryAccount)
    const existing = await cal.events.get({ calendarId, eventId })
    const updated = { ...existing.data }
    if (summary) updated.summary = summary
    if (description !== undefined) updated.description = description
    if (location !== undefined) updated.location = location
    if (start) {
      const isAllDay = !start.includes('T')
      updated.start = isAllDay ? { date: start } : { dateTime: start }
    }
    if (end) {
      const isAllDay = !end.includes('T')
      updated.end = isAllDay ? { date: end } : { dateTime: end }
    }
    const res = await cal.events.update({ calendarId, eventId, requestBody: updated, sendUpdates: 'all' })
    return { content: [{ type: 'text', text: `Event updated: ${res.data.htmlLink}` }] }
  })

  server.tool('calendar_delete_event', {
    description: 'Delete a calendar event.',
    inputSchema: {
      type: 'object',
      properties: {
        eventId: { type: 'string', description: 'Event ID to delete' },
        calendarId: { type: 'string', description: 'Calendar ID (default: "primary")' },
        account: { type: 'string', description: 'Google account email (default: primary)' },
      },
      required: ['eventId'],
    },
  }, async ({ eventId, calendarId = 'primary', account }) => {
    const cal = getCalendarClient(account || primaryAccount)
    await cal.events.delete({ calendarId, eventId, sendUpdates: 'all' })
    return { content: [{ type: 'text', text: `Event ${eventId} deleted.` }] }
  })
}
