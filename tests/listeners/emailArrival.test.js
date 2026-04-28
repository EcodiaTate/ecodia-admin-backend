'use strict'

/**
 * emailArrival listener - Jest tests.
 *
 * Mocks axios to intercept HTTP wake calls. Verifies relevanceFilter logic
 * and that handle() POSTs the right message without throwing.
 */

jest.mock('axios')
const axios = require('axios')
const listener = require('../../src/services/listeners/emailArrival')

const makeEvent = (overrides = {}) => ({
  type: 'db:event',
  seq: 1,
  ts: new Date().toISOString(),
  data: {
    type: 'db:event',
    table: 'email_events',
    action: 'INSERT',
    row: {
      id: 'email-uuid-1',
      inbox: 'code@ecodia.au',
      from_address: 'client@example.com',
      subject: 'Test email',
    },
    ts: Date.now() / 1000,
    ...overrides,
  },
})

describe('emailArrival', () => {
  afterAll(async () => {
    await new Promise(r => setImmediate(r))
    await new Promise(r => setImmediate(r))
  })

  beforeEach(() => {
    jest.clearAllMocks()
    axios.post.mockResolvedValue({ status: 200 })
  })

  // ---- relevanceFilter ----

  test('relevanceFilter: returns true for email_events INSERT with row', () => {
    expect(listener.relevanceFilter(makeEvent())).toBe(true)
  })

  test('relevanceFilter: returns false for action=UPDATE', () => {
    expect(listener.relevanceFilter(makeEvent({ action: 'UPDATE' }))).toBe(false)
  })

  test('relevanceFilter: returns false for action=DELETE', () => {
    expect(listener.relevanceFilter(makeEvent({ action: 'DELETE' }))).toBe(false)
  })

  test('relevanceFilter: returns false for table=cc_sessions', () => {
    expect(listener.relevanceFilter(makeEvent({ table: 'cc_sessions' }))).toBe(false)
  })

  test('relevanceFilter: returns false for table=status_board', () => {
    expect(listener.relevanceFilter(makeEvent({ table: 'status_board' }))).toBe(false)
  })

  test('relevanceFilter: returns false when row is missing', () => {
    const event = makeEvent()
    delete event.data.row
    expect(listener.relevanceFilter(event)).toBe(false)
  })

  test('relevanceFilter: returns false for non-db:event inner type', () => {
    const event = { type: 'text_delta', seq: 1, ts: new Date().toISOString(), data: { type: 'text_delta', content: 'hello' } }
    expect(listener.relevanceFilter(event)).toBe(false)
  })

  test('relevanceFilter: returns false when data is missing', () => {
    expect(listener.relevanceFilter({ type: 'db:event' })).toBe(false)
  })

  // ---- handle ----

  test('handle: POSTs to /api/os-session/message with email id and sourceEventId', async () => {
    const event = makeEvent()
    const ctx = { sourceEventId: 'src-001' }
    await listener.handle(event, ctx)
    expect(axios.post).toHaveBeenCalledTimes(1)
    const [url, body] = axios.post.mock.calls[0]
    expect(url).toContain('/api/os-session/message')
    expect(body.message).toContain('email-uuid-1')
    expect(body.message).toContain('emailArrival listener')
    expect(body.message).toContain('src-001')
  })

  test('handle: message includes kind=unknown when row.kind is absent', async () => {
    const event = makeEvent()
    const ctx = { sourceEventId: 'src-002' }
    await listener.handle(event, ctx)
    const [, body] = axios.post.mock.calls[0]
    expect(body.message).toContain('kind=unknown')
  })

  test('handle: does NOT throw if axios.post rejects', async () => {
    axios.post.mockRejectedValue(new Error('connection refused'))
    const event = makeEvent()
    const ctx = { sourceEventId: 'src-003' }
    let threw = false
    try {
      await listener.handle(event, ctx)
    } catch {
      threw = true
    }
    expect(threw).toBe(false)
  })

  // ---- module shape ----

  test('exports required listener fields', () => {
    expect(listener.name).toBe('emailArrival')
    expect(Array.isArray(listener.subscribesTo)).toBe(true)
    expect(listener.subscribesTo).toContain('db:event')
    expect(typeof listener.relevanceFilter).toBe('function')
    expect(typeof listener.handle).toBe('function')
    expect(Array.isArray(listener.ownsWriteSurface)).toBe(true)
    expect(listener.ownsWriteSurface).toContain('os-session-message')
  })

  test('does NOT export start or stop (no timer needed)', () => {
    expect(listener.start).toBeUndefined()
    expect(listener.stop).toBeUndefined()
  })
})
