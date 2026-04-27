'use strict'

/**
 * schedulerPollerService.fireTask tests - Jest edition.
 *
 * Verifies two load-bearing claims after removing the isTateActive pre-gate:
 *   1. fireTask always POSTs to /api/os-session/message, even when isTateActive
 *      would have returned true (the gate is gone - the call must go through).
 *   2. After a successful fire, a cron task's last_run_at and next_run_at are
 *      updated in the DB - NOT last_deferred_at.
 *
 * Mocking strategy: jest.mock() for all require()d dependencies so the module
 * runs in isolation. The postgres tagged-template db is mocked as a plain jest.fn()
 * that returns Promise.resolve([]) - tagged template calls are just function calls
 * with a TemplateStringsArray as first arg, so this works without any special setup.
 */

const API_PORT = process.env.PORT || 3001
const MESSAGE_ENDPOINT = `http://127.0.0.1:${API_PORT}/api/os-session/message`

// ---- dependency mocks (must be declared before any require of the module under test) ----

jest.mock('../../src/config/db', () => {
  // Tagged template calls look like: db(['SQL text ', ' more'], val1, val2)
  // A plain jest.fn() that returns a resolved Promise works for all call sites.
  return jest.fn().mockImplementation(() => Promise.resolve([]))
})

jest.mock('../../src/config/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  debug: jest.fn(),
  error: jest.fn(),
}))

jest.mock('../../src/services/usageEnergyService', () => ({
  getEnergy: jest.fn().mockResolvedValue({ level: 'healthy', scheduleMultiplier: 1.0 }),
}))

// tateActiveGate is imported by schedulerPollerService but should no longer be
// called from fireTask. We still provide a mock in case the import is present,
// but we set it to return true - if the gate were still active, the POST would
// be skipped and Test 1 would fail, proving the gate is gone.
jest.mock('../../src/services/tateActiveGate', () => ({
  isTateActive: jest.fn().mockResolvedValue(true),
}))

// osSessionService is required dynamically inside isSessionBusy(), which is
// called from pollOnce(), not from fireTask(). Mock it defensively anyway.
jest.mock('../../src/services/osSessionService', () => ({
  _isQueueBusy: jest.fn().mockReturnValue(false),
}))

// ---- module under test ----

const { fireTask } = require('../../src/services/schedulerPollerService')
const db = require('../../src/config/db')

// ---- helpers ----

function makeCronTask(overrides = {}) {
  return {
    id: 'test-task-uuid-001',
    type: 'cron',
    name: 'test-cron',
    prompt: 'do something useful',
    cron_expression: 'every 1h',
    ...overrides,
  }
}

function makeDelayedTask(overrides = {}) {
  return {
    id: 'test-task-uuid-002',
    type: 'delayed',
    name: 'test-delayed',
    prompt: 'one shot task',
    cron_expression: null,
    ...overrides,
  }
}

// Collect all SQL strings that flowed through db() calls during a test
function capturedSql() {
  return db.mock.calls.map(args => {
    // args[0] is the TemplateStringsArray, subsequent args are interpolated values
    const strings = Array.from(args[0])
    return strings.join('?')
  })
}

// ---- setup / teardown ----

let fetchSpy

beforeEach(() => {
  jest.clearAllMocks()

  // Provide a successful fetch response for the /api/os-session/message call
  fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue({
    ok: true,
    json: jest.fn().mockResolvedValue({ queued: true }),
  })
})

afterEach(() => {
  fetchSpy.mockRestore()
})

afterAll(async () => {
  // Drain pending setImmediate callbacks (logger's DBErrorTransport constructor
  // schedules a setImmediate to require('./db'). Without draining, Jest tears down
  // the module environment first and emits a ReferenceError). Same pattern as
  // tests/listeners/registry.test.js.
  await new Promise(r => setImmediate(r))
  await new Promise(r => setImmediate(r))
})

// ---- tests ----

describe('schedulerPollerService.fireTask', () => {
  test('fires POST to /api/os-session/message regardless of isTateActive state', async () => {
    // isTateActive mock returns true (the old gate would have deferred).
    // After removing the gate, the POST must happen anyway.
    const task = makeCronTask()

    await fireTask(task)

    // Fetch was called exactly once
    expect(fetchSpy).toHaveBeenCalledTimes(1)

    // And it was called with the message endpoint
    const [url, opts] = fetchSpy.mock.calls[0]
    expect(url).toBe(MESSAGE_ENDPOINT)

    // Body contains source:'scheduler' and the prefixed prompt
    const body = JSON.parse(opts.body)
    expect(body.source).toBe('scheduler')
    expect(body.message).toContain('[SCHEDULED: test-cron]')
    expect(body.message).toContain('do something useful')
  })

  test('cron task updates last_run_at and next_run_at - not last_deferred_at', async () => {
    const task = makeCronTask({ name: 'meta-loop', prompt: 'orient and act', cron_expression: 'every 1h' })

    await fireTask(task)

    // At least one db call should have happened (the cron reschedule UPDATE)
    expect(db).toHaveBeenCalled()

    const sqlStatements = capturedSql()

    // At least one statement should mention last_run_at and next_run_at
    const updateSql = sqlStatements.find(s => s.includes('last_run_at') || s.includes('next_run_at'))
    expect(updateSql).toBeDefined()
    expect(updateSql).toMatch(/last_run_at/)
    expect(updateSql).toMatch(/next_run_at/)

    // None of the statements should update last_deferred_at (that was the old defer path)
    const deferringSql = sqlStatements.find(s => s.includes('last_deferred_at'))
    expect(deferringSql).toBeUndefined()
  })

  test('delayed task is marked completed after fire (not rescheduled)', async () => {
    // For non-cron tasks, status should be set to 'completed', not rescheduled.
    // db mock returns [] for the chained-task SELECT so no chaining occurs.
    const task = makeDelayedTask()

    await fireTask(task)

    expect(fetchSpy).toHaveBeenCalledTimes(1)

    const sqlStatements = capturedSql()
    const completionSql = sqlStatements.find(s => s.includes('completed'))
    expect(completionSql).toBeDefined()
  })
})
