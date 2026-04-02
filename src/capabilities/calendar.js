const registry = require('../services/capabilityRegistry')
const env = require('../config/env')

registry.registerMany([
  {
    name: 'create_calendar_event',
    description: 'Create a Google Calendar event — meeting, appointment, reminder',
    tier: 'write',
    domain: 'calendar',
    params: {
      summary: { type: 'string', required: true, description: 'Event title' },
      startTime: { type: 'string', required: true, description: 'ISO date or datetime' },
      endTime: { type: 'string', required: true, description: 'ISO date or datetime' },
      description: { type: 'string', required: false, description: 'Event body' },
      location: { type: 'string', required: false, description: 'Physical or virtual location' },
      attendees: { type: 'array', required: false, description: 'Array of email addresses' },
      calendar: { type: 'string', required: false, description: 'Calendar account (default: primary)' },
    },
    handler: async (params) => {
      const cal = require('../services/calendarService')
      const event = await cal.createEvent(params.calendar || env.GOOGLE_PRIMARY_ACCOUNT, params)
      return { message: `Event created: ${params.summary}`, eventId: event?.id }
    },
  },
  {
    name: 'update_calendar_event',
    description: 'Update an existing Google Calendar event',
    tier: 'write',
    domain: 'calendar',
    params: {
      eventId: { type: 'string', required: true, description: 'Calendar event ID' },
      summary: { type: 'string', required: false, description: 'New title' },
      startTime: { type: 'string', required: false, description: 'New start time' },
      endTime: { type: 'string', required: false, description: 'New end time' },
    },
    handler: async (params) => {
      const cal = require('../services/calendarService')
      await cal.updateEvent(
        params.calendar || env.GOOGLE_PRIMARY_ACCOUNT,
        params.eventId,
        { summary: params.summary, startTime: params.startTime, endTime: params.endTime, description: params.description }
      )
      return { message: `Event updated`, eventId: params.eventId }
    },
  },
  {
    name: 'get_calendar_events',
    description: 'Get upcoming calendar events — today, this week, or a custom range',
    tier: 'read',
    domain: 'calendar',
    params: {
      from: { type: 'string', required: false, description: 'Start date (ISO)' },
      to: { type: 'string', required: false, description: 'End date (ISO)' },
      limit: { type: 'number', required: false, description: 'Max events to return' },
    },
    handler: async (params) => {
      const cal = require('../services/calendarService')
      // getUpcoming({ hours, limit }) — returns events within the next N hours
      const hours = params.limit ? undefined : 24  // default 24h window
      return cal.getUpcoming({ hours: params.hours || 24, limit: params.limit || 20 })
    },
  },
])
