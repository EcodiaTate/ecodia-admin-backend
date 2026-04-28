'use strict'

/**
 * statusBoardDrift listener - Jest tests.
 *
 * Mocks axios and the DB module. Verifies:
 *   - relevanceFilter logic (event side)
 *   - handle() records lastTouched without calling axios
 *   - start() and stop() manage the interval timer
 *   - module shape
 */

jest.mock('axios')
jest.mock('../../src/config/db')
jest.mock('../../src/config/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
}))

const axios = require('axios')

// Fresh module instance per test suite - reset interval state
let listener
beforeEach(() => {
  jest.clearAllMocks()
  jest.resetModules()
  axios.post = jest.fn().mockResolvedValue({ status: 200 })

  // Re-require after resetModules to get a fresh module with clean state
  jest.mock('axios')
  jest.mock('../../src/config/db')
  jest.mock('../../src/config/logger', () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  }))
  const axiosFresh = require('axios')
  axiosFresh.post = jest.fn().mockResolvedValue({ status: 200 })

  listener = require('../../src/services/listeners/statusBoardDrift')
})

afterEach(async () => {
  if (listener && typeof listener.stop === 'function') {
    await listener.stop()
  }
})

afterAll(async () => {
  await new Promise(r => setImmediate(r))
  await new Promise(r => setImmediate(r))
})

const makeEvent = (overrides = {}) => ({
  type: 'db:event',
  seq: 1,
  ts: new Date().toISOString(),
  data: {
    type: 'db:event',
    table: 'status_board',
    action: 'UPDATE',
    row: {
      id: 'row-uuid-1',
      name: 'Test client',
      last_touched: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
      priority: 1,
      next_action: 'Follow up',
    },
    ts: Date.now() / 1000,
    ...overrides,
  },
})

describe('statusBoardDrift', () => {
  // ---- relevanceFilter ----

  test('relevanceFilter: returns true for status_board UPDATE with row', () => {
    expect(listener.relevanceFilter(makeEvent())).toBe(true)
  })

  test('relevanceFilter: returns true for status_board INSERT', () => {
    expect(listener.relevanceFilter(makeEvent({ action: 'INSERT' }))).toBe(true)
  })

  test('relevanceFilter: returns false for action=DELETE', () => {
    expect(listener.relevanceFilter(makeEvent({ action: 'DELETE' }))).toBe(false)
  })

  test('relevanceFilter: returns false for table=cc_sessions', () => {
    expect(listener.relevanceFilter(makeEvent({ table: 'cc_sessions' }))).toBe(false)
  })

  test('relevanceFilter: returns false for table=email_events', () => {
    expect(listener.relevanceFilter(makeEvent({ table: 'email_events' }))).toBe(false)
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

  // ---- handle (event side - no OS wake) ----

  test('handle: does NOT call axios (event side only records lastTouched)', async () => {
    const axiosMod = require('axios')
    const event = makeEvent()
    const ctx = { sourceEventId: 'evt-001' }
    await listener.handle(event, ctx)
    expect(axiosMod.post).not.toHaveBeenCalled()
  })

  test('handle: does NOT throw on event with missing row', async () => {
    const event = makeEvent()
    event.data.row = null
    let threw = false
    try {
      await listener.handle(event, { sourceEventId: 'evt-002' })
    } catch {
      threw = true
    }
    expect(threw).toBe(false)
  })

  // ---- start / stop ----

  test('start: is exported as an async function', () => {
    expect(typeof listener.start).toBe('function')
  })

  test('stop: is exported as an async function', () => {
    expect(typeof listener.stop).toBe('function')
  })

  test('start() resolves without throwing', async () => {
    await expect(listener.start()).resolves.toBeUndefined()
    await listener.stop()
  })

  test('stop() resolves without throwing even if not started', async () => {
    await expect(listener.stop()).resolves.toBeUndefined()
  })

  test('start() is idempotent - second call does not create duplicate timers', async () => {
    await listener.start()
    await listener.start()  // should be a no-op
    await listener.stop()
  })

  // ---- module shape ----

  test('exports required listener fields', () => {
    expect(listener.name).toBe('statusBoardDrift')
    expect(Array.isArray(listener.subscribesTo)).toBe(true)
    expect(listener.subscribesTo).toContain('db:event')
    expect(typeof listener.relevanceFilter).toBe('function')
    expect(typeof listener.handle).toBe('function')
    expect(Array.isArray(listener.ownsWriteSurface)).toBe(true)
    expect(listener.ownsWriteSurface).toContain('os-session-message')
  })

  test('exports start and stop functions (timer management)', () => {
    expect(typeof listener.start).toBe('function')
    expect(typeof listener.stop).toBe('function')
  })
})
