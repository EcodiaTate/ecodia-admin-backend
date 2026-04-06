/**
 * Calendar MCP tools — read, create, update, delete events.
 */
import { z } from 'zod'
import { getCalendarClient, primaryAccount } from './auth.js'

export function registerCalendarTools(server) {

  server.tool('calendar_list_events',
    'List calendar events within a time range.',
    { timeMin: z.string().optional().describe('Start (ISO 8601). Default: now'), timeMax: z.string().optional().describe('End (ISO 8601). Default: 7 days'), maxResults: z.number().default(25), calendarId: z.string().default('primary'), account: z.string().optional() },
    async ({ timeMin, timeMax, maxResults, calendarId, account }) => {
      const cal = getCalendarClient(account || primaryAccount)
      const now = new Date()
      const res = await cal.events.list({ calendarId, timeMin: timeMin || now.toISOString(), timeMax: timeMax || new Date(now.getTime() + 7 * 86400000).toISOString(), maxResults, singleEvents: true, orderBy: 'startTime' })
      const events = (res.data.items || []).map(e => ({ id: e.id, summary: e.summary, start: e.start?.dateTime || e.start?.date, end: e.end?.dateTime || e.end?.date, location: e.location, description: e.description?.slice(0, 500), attendees: e.attendees?.map(a => `${a.email} (${a.responseStatus})`), status: e.status, htmlLink: e.htmlLink }))
      return { content: [{ type: 'text', text: JSON.stringify(events, null, 2) }] }
    }
  )

  server.tool('calendar_get_event',
    'Get full details of a calendar event.',
    { eventId: z.string(), calendarId: z.string().default('primary'), account: z.string().optional() },
    async ({ eventId, calendarId, account }) => {
      const cal = getCalendarClient(account || primaryAccount)
      const res = await cal.events.get({ calendarId, eventId })
      return { content: [{ type: 'text', text: JSON.stringify(res.data, null, 2) }] }
    }
  )

  server.tool('calendar_create_event',
    'Create a new calendar event.',
    { summary: z.string(), start: z.string().describe('ISO 8601 dateTime or date'), end: z.string().describe('ISO 8601 dateTime or date'), description: z.string().optional(), location: z.string().optional(), attendees: z.array(z.string()).optional().describe('Attendee emails'), calendarId: z.string().default('primary'), account: z.string().optional() },
    async ({ summary, start, end, description, location, attendees, calendarId, account }) => {
      const cal = getCalendarClient(account || primaryAccount)
      const isAllDay = !start.includes('T')
      const event = { summary, start: isAllDay ? { date: start } : { dateTime: start }, end: isAllDay ? { date: end } : { dateTime: end }, description, location, attendees: attendees?.map(email => ({ email })) }
      const res = await cal.events.insert({ calendarId, requestBody: event, sendUpdates: 'all' })
      return { content: [{ type: 'text', text: `Event created: ${res.data.htmlLink}` }] }
    }
  )

  server.tool('calendar_update_event',
    'Update an existing calendar event.',
    { eventId: z.string(), summary: z.string().optional(), start: z.string().optional(), end: z.string().optional(), description: z.string().optional(), location: z.string().optional(), calendarId: z.string().default('primary'), account: z.string().optional() },
    async ({ eventId, summary, start, end, description, location, calendarId, account }) => {
      const cal = getCalendarClient(account || primaryAccount)
      const existing = await cal.events.get({ calendarId, eventId })
      const updated = { ...existing.data }
      if (summary) updated.summary = summary
      if (description !== undefined) updated.description = description
      if (location !== undefined) updated.location = location
      if (start) { const isAllDay = !start.includes('T'); updated.start = isAllDay ? { date: start } : { dateTime: start } }
      if (end) { const isAllDay = !end.includes('T'); updated.end = isAllDay ? { date: end } : { dateTime: end } }
      const res = await cal.events.update({ calendarId, eventId, requestBody: updated, sendUpdates: 'all' })
      return { content: [{ type: 'text', text: `Event updated: ${res.data.htmlLink}` }] }
    }
  )

  server.tool('calendar_delete_event',
    'Delete a calendar event.',
    { eventId: z.string(), calendarId: z.string().default('primary'), account: z.string().optional() },
    async ({ eventId, calendarId, account }) => {
      const cal = getCalendarClient(account || primaryAccount)
      await cal.events.delete({ calendarId, eventId, sendUpdates: 'all' })
      return { content: [{ type: 'text', text: `Event ${eventId} deleted.` }] }
    }
  )
}
