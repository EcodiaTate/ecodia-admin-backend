'use strict'

/**
 * factorySessionComplete listener - Jest tests.
 *
 * Mocks axios to intercept HTTP wake calls. Verifies relevanceFilter logic
 * and that handle() POSTs the right message without throwing.
 */

jest.mock('axios')
const axios = require('axios')
const listener = require('../../src/services/listeners/factorySessionComplete')

const makeEvent = (overrides = {}) => ({
  type: 'db:event',
  seq: 1,
  ts: new Date().toISOString(),
  data: {
    type: 'db:event',
    table: 'cc_sessions',
    action: 'UPDATE',
    row: {
      id: 'session-uuid-1',
      status: 'complete',
      pipeline_stage: 'awaiting_review',
    },
    ts: Date.now() / 1000,
    ...overrides,
  },
})

describe('factorySessionComplete', () => {
  afterAll(async () => {
    await new Promise(r => setImmediate(r))
    await new Promise(r => setImmediate(r))
  })

  beforeEach(() => {
    jest.clearAllMocks()
    axios.post.mockResolvedValue({ status: 200 })
  })

  // ---- relevanceFilter ----

  test('relevanceFilter: returns true for cc_sessions UPDATE to status=complete', () => {
    const event = makeEvent()
    expect(listener.relevanceFilter(event)).toBe(true)
  })

  test('relevanceFilter: returns true for status=rejected (non-failure stage)', () => {
    const event = makeEvent({ row: { id: 'x', status: 'rejected', pipeline_stage: 'awaiting_review' } })
    expect(listener.relevanceFilter(event)).toBe(true)
  })

  test('relevanceFilter: returns false when pipeline_stage=failed (deferred to ccSessionsFailure)', () => {
    const event = makeEvent({ row: { id: 'x', status: 'complete', pipeline_stage: 'failed' } })
    expect(listener.relevanceFilter(event)).toBe(false)
  })

  test('relevanceFilter: returns false when pipeline_stage=error', () => {
    const event = makeEvent({ row: { id: 'x', status: 'complete', pipeline_stage: 'error' } })
    expect(listener.relevanceFilter(event)).toBe(false)
  })

  test('relevanceFilter: returns false for status=error (belongs to ccSessionsFailure)', () => {
    const event = makeEvent({ row: { id: 'x', status: 'error', pipeline_stage: 'running' } })
    expect(listener.relevanceFilter(event)).toBe(false)
  })

  test('relevanceFilter: returns false for status=running (not a terminal state)', () => {
    const event = makeEvent({ row: { id: 'x', status: 'running', pipeline_stage: 'running' } })
    expect(listener.relevanceFilter(event)).toBe(false)
  })

  test('relevanceFilter: returns false for table=email_events', () => {
    const event = makeEvent({ table: 'email_events', row: { id: 'x', status: 'complete', pipeline_stage: 'deployed' } })
    expect(listener.relevanceFilter(event)).toBe(false)
  })

  test('relevanceFilter: returns false for action=INSERT', () => {
    const event = makeEvent({ action: 'INSERT', row: { id: 'x', status: 'complete', pipeline_stage: 'deployed' } })
    expect(listener.relevanceFilter(event)).toBe(false)
  })

  test('relevanceFilter: returns false for non-db:event inner type', () => {
    const event = { type: 'text_delta', seq: 1, ts: new Date().toISOString(), data: { type: 'text_delta', content: 'hello' } }
    expect(listener.relevanceFilter(event)).toBe(false)
  })

  // ---- handle ----

  test('handle: POSTs to /api/os-session/message with session details', async () => {
    const event = makeEvent()
    const ctx = { sourceEventId: 'evt-001' }
    await listener.handle(event, ctx)
    expect(axios.post).toHaveBeenCalledTimes(1)
    const [url, body] = axios.post.mock.calls[0]
    expect(url).toContain('/api/os-session/message')
    expect(body.message).toContain('session-uuid-1')
    expect(body.message).toContain('status=complete')
    expect(body.message).toContain('factorySessionComplete listener')
    expect(body.message).toContain('evt-001')
  })

  test('handle: does NOT throw if axios.post rejects', async () => {
    axios.post.mockRejectedValue(new Error('connection refused'))
    const event = makeEvent()
    const ctx = { sourceEventId: 'evt-002' }
    let threw = false
    try {
      await listener.handle(event, ctx)
    } catch {
      threw = true
    }
    expect(threw).toBe(false)
  })

  // ---- stage allowlist ----

  test('relevanceFilter: returns false for pipeline_stage=testing (post-approval churn)', () => {
    const event = makeEvent({ row: { id: 'stage-testing', status: 'complete', pipeline_stage: 'testing' } })
    expect(listener.relevanceFilter(event)).toBe(false)
  })

  test('relevanceFilter: returns false for pipeline_stage=deploying (post-approval churn)', () => {
    const event = makeEvent({ row: { id: 'stage-deploying', status: 'complete', pipeline_stage: 'deploying' } })
    expect(listener.relevanceFilter(event)).toBe(false)
  })

  test('relevanceFilter: returns false for pipeline_stage=executing (post-approval churn)', () => {
    const event = makeEvent({ row: { id: 'stage-executing', status: 'complete', pipeline_stage: 'executing' } })
    expect(listener.relevanceFilter(event)).toBe(false)
  })

  test('relevanceFilter: returns true for pipeline_stage=awaiting_review', () => {
    const event = makeEvent({ row: { id: 'stage-awaiting-review', status: 'complete', pipeline_stage: 'awaiting_review' } })
    expect(listener.relevanceFilter(event)).toBe(true)
  })

  test('relevanceFilter: returns true for pipeline_stage=complete', () => {
    const event = makeEvent({ row: { id: 'stage-complete', status: 'complete', pipeline_stage: 'complete' } })
    expect(listener.relevanceFilter(event)).toBe(true)
  })

  // ---- dedupe ----

  test('dedupe: same sessionId within 60s is skipped on second call', () => {
    const event = makeEvent({ row: { id: 'dedup-within-60s', status: 'complete', pipeline_stage: 'awaiting_review' } })
    expect(listener.relevanceFilter(event)).toBe(true)
    expect(listener.relevanceFilter(event)).toBe(false)
  })

  test('dedupe: same sessionId past 60s fires again', () => {
    jest.useFakeTimers()
    try {
      const event = makeEvent({ row: { id: 'dedup-past-60s', status: 'complete', pipeline_stage: 'awaiting_review' } })
      expect(listener.relevanceFilter(event)).toBe(true)
      jest.advanceTimersByTime(61 * 1000)
      expect(listener.relevanceFilter(event)).toBe(true)
    } finally {
      jest.useRealTimers()
    }
  })

  // ---- module shape ----

  test('exports required listener fields', () => {
    expect(listener.name).toBe('factorySessionComplete')
    expect(Array.isArray(listener.subscribesTo)).toBe(true)
    expect(listener.subscribesTo).toContain('db:event')
    expect(typeof listener.relevanceFilter).toBe('function')
    expect(typeof listener.handle).toBe('function')
    expect(Array.isArray(listener.ownsWriteSurface)).toBe(true)
  })
})
