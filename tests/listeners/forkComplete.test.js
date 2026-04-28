'use strict'

/**
 * forkComplete listener - Jest tests.
 *
 * Mocks axios to intercept HTTP wake calls. Verifies relevanceFilter logic
 * and that handle() POSTs the right message without throwing.
 */

jest.mock('axios')
const axios = require('axios')
const listener = require('../../src/services/listeners/forkComplete')

const TEN_MIN_MS = 10 * 60 * 1000

const makeEvent = (overrides = {}) => ({
  type: 'db:event',
  seq: 1,
  ts: new Date().toISOString(),
  data: {
    type: 'db:event',
    table: 'os_forks',
    action: 'UPDATE',
    row: {
      fork_id: 'fork-abc-123',
      parent_id: null,
      status: 'done',
      last_heartbeat: new Date(Date.now() - 2000).toISOString(),
      result: 'Success',
      next_step: null,
    },
    ts: Date.now() / 1000,
    ...overrides,
  },
})

describe('forkComplete', () => {
  afterAll(async () => {
    await new Promise(r => setImmediate(r))
    await new Promise(r => setImmediate(r))
  })

  beforeEach(() => {
    jest.clearAllMocks()
    axios.post.mockResolvedValue({ status: 200 })
  })

  // ---- relevanceFilter ----

  test('relevanceFilter: returns true for os_forks UPDATE to status=done', () => {
    expect(listener.relevanceFilter(makeEvent())).toBe(true)
  })

  test('relevanceFilter: returns true for status=aborted', () => {
    expect(listener.relevanceFilter(makeEvent({ row: { fork_id: 'f1', status: 'aborted', last_heartbeat: new Date().toISOString() } }))).toBe(true)
  })

  test('relevanceFilter: returns true for status=error', () => {
    expect(listener.relevanceFilter(makeEvent({ row: { fork_id: 'f1', status: 'error', last_heartbeat: new Date().toISOString() } }))).toBe(true)
  })

  test('relevanceFilter: returns true for running fork with stale heartbeat (>10 min)', () => {
    const staleTs = new Date(Date.now() - TEN_MIN_MS - 5000).toISOString()
    const event = makeEvent({ row: { fork_id: 'f2', status: 'running', last_heartbeat: staleTs } })
    expect(listener.relevanceFilter(event)).toBe(true)
  })

  test('relevanceFilter: returns false for running fork with fresh heartbeat (<10 min)', () => {
    const freshTs = new Date(Date.now() - 60_000).toISOString()
    const event = makeEvent({ row: { fork_id: 'f3', status: 'running', last_heartbeat: freshTs } })
    expect(listener.relevanceFilter(event)).toBe(false)
  })

  test('relevanceFilter: returns false for status=initialising (non-terminal, non-running)', () => {
    const event = makeEvent({ row: { fork_id: 'f4', status: 'initialising', last_heartbeat: new Date().toISOString() } })
    expect(listener.relevanceFilter(event)).toBe(false)
  })

  test('relevanceFilter: returns false for action=INSERT', () => {
    expect(listener.relevanceFilter(makeEvent({ action: 'INSERT' }))).toBe(false)
  })

  test('relevanceFilter: returns false for table=cc_sessions', () => {
    expect(listener.relevanceFilter(makeEvent({ table: 'cc_sessions' }))).toBe(false)
  })

  test('relevanceFilter: returns false when row is missing', () => {
    const event = makeEvent()
    delete event.data.row
    expect(listener.relevanceFilter(event)).toBe(false)
  })

  test('relevanceFilter: returns false for non-db:event inner type', () => {
    const event = { type: 'text_delta', seq: 1, data: { type: 'text_delta', content: 'x' } }
    expect(listener.relevanceFilter(event)).toBe(false)
  })

  // ---- handle ----

  test('handle: POSTs to /api/os-session/message for terminal fork', async () => {
    const event = makeEvent()
    const ctx = { sourceEventId: 'evt-001' }
    await listener.handle(event, ctx)
    expect(axios.post).toHaveBeenCalledTimes(1)
    const [url, body] = axios.post.mock.calls[0]
    expect(url).toContain('/api/os-session/message')
    expect(body.message).toContain('fork-abc-123')
    expect(body.message).toContain('status=done')
    expect(body.message).toContain('forkComplete listener')
    expect(body.message).toContain('evt-001')
  })

  test('handle: message includes result snippet for terminal fork', async () => {
    const event = makeEvent()
    const ctx = { sourceEventId: 'evt-002' }
    await listener.handle(event, ctx)
    const [, body] = axios.post.mock.calls[0]
    expect(body.message).toContain('Success')
  })

  test('handle: POSTs stale-heartbeat message for hanging fork', async () => {
    const staleTs = new Date(Date.now() - TEN_MIN_MS - 5000).toISOString()
    const event = makeEvent({ row: { fork_id: 'fork-stale-1', status: 'running', last_heartbeat: staleTs, result: null, next_step: null } })
    const ctx = { sourceEventId: 'evt-003' }
    await listener.handle(event, ctx)
    expect(axios.post).toHaveBeenCalledTimes(1)
    const [, body] = axios.post.mock.calls[0]
    expect(body.message).toContain('fork-stale-1')
    expect(body.message).toContain('stale')
  })

  test('handle: does NOT re-alert same stale fork_id a second time', async () => {
    const staleTs = new Date(Date.now() - TEN_MIN_MS - 5000).toISOString()
    const makeStaleForkEvent = (forkId) => makeEvent({
      row: { fork_id: forkId, status: 'running', last_heartbeat: staleTs, result: null, next_step: null },
    })

    // Use a unique fork_id for this test to avoid cross-test state bleed
    const event1 = makeStaleForkEvent('fork-stale-dedup-1')
    const event2 = makeStaleForkEvent('fork-stale-dedup-1')

    await listener.handle(event1, { sourceEventId: 'x1' })
    await listener.handle(event2, { sourceEventId: 'x2' })

    expect(axios.post).toHaveBeenCalledTimes(1)
  })

  test('handle: does NOT throw if axios.post rejects', async () => {
    axios.post.mockRejectedValue(new Error('connection refused'))
    const event = makeEvent()
    let threw = false
    try {
      await listener.handle(event, { sourceEventId: 'x3' })
    } catch {
      threw = true
    }
    expect(threw).toBe(false)
  })

  // ---- module shape ----

  test('exports required listener fields', () => {
    expect(listener.name).toBe('forkComplete')
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
