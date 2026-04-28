'use strict'

/**
 * ccSessionsFailure listener - Jest tests.
 *
 * Mirrors the shape of factorySessionComplete.test.js.
 * Verifies the exclusion clause (status=complete must NOT fire) and that
 * the correct failure conditions DO fire.
 */

jest.mock('axios')
const axios = require('axios')
const listener = require('../../src/services/listeners/ccSessionsFailure')

const makeEvent = (overrides = {}) => ({
  type: 'db:event',
  seq: 1,
  ts: new Date().toISOString(),
  data: {
    type: 'db:event',
    table: 'cc_sessions',
    action: 'UPDATE',
    row: {
      id: 'session-uuid-2',
      status: 'error',
      pipeline_stage: 'running',
    },
    ts: Date.now() / 1000,
    ...overrides,
  },
})

describe('ccSessionsFailure', () => {
  afterAll(async () => {
    await new Promise(r => setImmediate(r))
    await new Promise(r => setImmediate(r))
  })

  beforeEach(() => {
    jest.clearAllMocks()
    axios.post.mockResolvedValue({ status: 200 })
  })

  // ---- relevanceFilter ----

  test('relevanceFilter: returns true for status=error', () => {
    const event = makeEvent()
    expect(listener.relevanceFilter(event)).toBe(true)
  })

  test('relevanceFilter: returns true for pipeline_stage=failed with non-complete status', () => {
    const event = makeEvent({ row: { id: 'x', status: 'running', pipeline_stage: 'failed' } })
    expect(listener.relevanceFilter(event)).toBe(true)
  })

  test('relevanceFilter: returns false when status=complete + pipeline_stage=failed (neither listener fires - edge case)', () => {
    // factorySessionComplete skips it (stage=failed); ccSessionsFailure skips it (status=complete).
    // Spec says ccSessionsFailure only fires if status is NOT complete.
    const event = makeEvent({ row: { id: 'x', status: 'complete', pipeline_stage: 'failed' } })
    expect(listener.relevanceFilter(event)).toBe(false)
  })

  test('relevanceFilter: returns true for pipeline_stage=error', () => {
    const event = makeEvent({ row: { id: 'x', status: 'running', pipeline_stage: 'error' } })
    expect(listener.relevanceFilter(event)).toBe(true)
  })

  test('relevanceFilter: returns false when status=complete and stage is NOT failed/error', () => {
    const event = makeEvent({ row: { id: 'x', status: 'complete', pipeline_stage: 'deployed' } })
    expect(listener.relevanceFilter(event)).toBe(false)
  })

  test('relevanceFilter: returns false when status=complete and stage=awaiting_review', () => {
    const event = makeEvent({ row: { id: 'x', status: 'complete', pipeline_stage: 'awaiting_review' } })
    expect(listener.relevanceFilter(event)).toBe(false)
  })

  test('relevanceFilter: returns false for status=running (not a failure)', () => {
    const event = makeEvent({ row: { id: 'x', status: 'running', pipeline_stage: 'running' } })
    expect(listener.relevanceFilter(event)).toBe(false)
  })

  test('relevanceFilter: returns false for table=email_events', () => {
    const event = makeEvent({ table: 'email_events', row: { id: 'x', status: 'error', pipeline_stage: 'running' } })
    expect(listener.relevanceFilter(event)).toBe(false)
  })

  test('relevanceFilter: returns false for action=INSERT', () => {
    const event = makeEvent({ action: 'INSERT', row: { id: 'x', status: 'error', pipeline_stage: 'running' } })
    expect(listener.relevanceFilter(event)).toBe(false)
  })

  test('relevanceFilter: returns false for non-db:event inner type', () => {
    const event = { type: 'text_delta', seq: 1, ts: new Date().toISOString(), data: { type: 'text_delta', content: 'hello' } }
    expect(listener.relevanceFilter(event)).toBe(false)
  })

  // ---- handle ----

  test('handle: POSTs to /api/os-session/message with failure details', async () => {
    const event = makeEvent()
    const ctx = { sourceEventId: 'evt-fail-001' }
    await listener.handle(event, ctx)
    expect(axios.post).toHaveBeenCalledTimes(1)
    const [url, body] = axios.post.mock.calls[0]
    expect(url).toContain('/api/os-session/message')
    expect(body.message).toContain('session-uuid-2')
    expect(body.message).toContain('status=error')
    expect(body.message).toContain('ccSessionsFailure listener')
    expect(body.message).toContain('evt-fail-001')
  })

  test('handle: does NOT throw if axios.post rejects', async () => {
    axios.post.mockRejectedValue(new Error('connection refused'))
    const event = makeEvent()
    const ctx = { sourceEventId: 'evt-fail-002' }
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
    expect(listener.name).toBe('ccSessionsFailure')
    expect(Array.isArray(listener.subscribesTo)).toBe(true)
    expect(listener.subscribesTo).toContain('db:event')
    expect(typeof listener.relevanceFilter).toBe('function')
    expect(typeof listener.handle).toBe('function')
    expect(Array.isArray(listener.ownsWriteSurface)).toBe(true)
  })
})
