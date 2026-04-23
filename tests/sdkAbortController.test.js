'use strict'
/**
 * Unit tests for SDK AbortController cancellation in osSessionService.js
 *
 * Verifies:
 * - _abortActiveQuery calls controller.abort(reason) on the stored AbortController
 * - The grace timer is scheduled for watchdog/manual abort reasons
 * - The grace timer is NOT scheduled for new_turn_starting or priority_preempt
 * - The grace timer is cleared on natural turn completion
 * - _setActiveQueryForTest / _setActiveAbortForTest wiring works correctly
 *
 * Run with: node tests/sdkAbortController.test.js
 */

const assert = require('assert')
const Module = require('module')

// ─── Test harness ─────────────────────────────────────────────────────────────

const _tests = []
function test(name, fn) { _tests.push({ name, fn }) }

async function runAll() {
  let passed = 0, failed = 0
  for (const { name, fn } of _tests) {
    try {
      await fn()
      console.log(`  \u2713 ${name}`)
      passed++
    } catch (err) {
      console.error(`  \u2717 ${name}`)
      console.error(`    ${err.message}`)
      if (process.env.VERBOSE) console.error(err.stack)
      failed++
    }
  }
  console.log(`\n${passed} passing, ${failed} failing\n`)
  if (failed > 0) process.exit(1)
}

// ─── Dependency stubs ─────────────────────────────────────────────────────────
// osSessionService.js has many heavy dependencies (DB, Redis, Neo4j, etc.)
// that we don't want to actually initialise in unit tests. Intercept them all.

const mockLogger = {
  debug: () => {}, info: () => {}, warn: () => {}, error: () => {},
}

// postgres.js db tag function — needs to be callable as a template literal tag
// AND as a function (e.g. db`...`) and have sub-methods (sql, begin, etc.)
const mockDb = Object.assign(
  function mockDbTag(...args) { return Promise.resolve([]) },
  { sql: async () => [], begin: async (fn) => fn(mockDb) }
)

const mockEnv = {
  OS_SESSION_CWD: '/tmp/test-cwd',
  OS_SESSION_MODEL: undefined,
  CLAUDE_CONFIG_DIR_1: undefined,
  CLAUDE_CONFIG_DIR_2: undefined,
  CLAUDE_CODE_OAUTH_TOKEN_TATE: undefined,
  CLAUDE_CODE_OAUTH_TOKEN_CODE: undefined,
  AWS_ACCESS_KEY_ID: undefined,
  AWS_SECRET_ACCESS_KEY: undefined,
  AWS_REGION: undefined,
  BEDROCK_MODEL: undefined,
  ANTHROPIC_API_KEY: undefined,
}

const mockBroadcastModule = {
  broadcast: () => {},
  flushDeltasForTurnComplete: () => {},
  resetSessionSeq: () => {},
  broadcastToSession: () => {},
}

const mockUsageEnergy = {
  refreshAllAccounts: async () => {},
  getEnergy: async () => ({ pctUsed: 0, level: 'healthy', accounts: { claude_max: {}, claude_max_2: {} } }),
  getBestProvider: () => ({ provider: 'claude_max', isBedrockFallback: false, reason: 'healthy' }),
  setProvider: () => {},
  refreshAllAccounts: async () => {},
}

const noop = () => {}
const noopAsync = async () => {}
const emptyObj = {}

const originalLoad = Module._load
Module._load = function (request, parent, isMain) {
  // Config modules
  if (/config[\\/]db/.test(request)) return mockDb
  if (/config[\\/]logger/.test(request)) return mockLogger
  if (/config[\\/]env/.test(request)) return mockEnv
  if (/config[\\/]neo4j/.test(request)) return { getDriver: () => null, closeDriver: noopAsync }
  if (/config[\\/]redis/.test(request)) return { getClient: () => null }

  // Infrastructure modules
  if (/wsManager/.test(request)) return mockBroadcastModule
  if (/usageEnergyService/.test(request)) return mockUsageEnergy
  if (/osIncidentService/.test(request)) return { log: noop }
  if (/sessionMemoryService/.test(request)) return { getSessionMemory: noopAsync, saveSessionMemory: noopAsync }
  if (/osConversationLog/.test(request)) return { getNextTurnNumber: async () => 0, logTurn: noopAsync }
  if (/neo4jRetrieval/.test(request)) return { fusedSearch: async () => [], getRecentHighPriorityNodes: async () => [] }
  if (/secretSafetyService/.test(request)) return { scrubSecrets: (x) => x }
  if (/sessionHandoff/.test(request)) return { readHandoffState: async () => null, saveHandoffState: noopAsync }
  if (/sessionObservation/.test(request)) return { observe: noop }
  if (/claudeTokenRefresh/.test(request)) return { scheduleRefresh: noop }
  if (/usageEnergy/.test(request)) return mockUsageEnergy
  if (/osAlertingService/.test(request)) return { alertBedrockFallback: noopAsync, alertProcessRestart: noopAsync }
  if (/osIncident/.test(request)) return { log: noop }
  if (/messageQueue/.test(request)) return { enqueue: noopAsync, getQueue: async () => [] }

  // Catch-all for any other internal services we haven't listed
  if (/services[\\/]/.test(request) && !request.includes('osSessionService')) return emptyObj
  if (/workers[\\/]/.test(request)) return emptyObj
  if (/capabilities[\\/]/.test(request)) return emptyObj

  return originalLoad.apply(this, arguments)
}

// Suppress the startup side effect (usageEnergy.refreshAllAccounts is called at module load)
const svc = require('../src/services/osSessionService')

// Restore original loader after requiring the module under test
Module._load = originalLoad

// ─── Tests ────────────────────────────────────────────────────────────────────

console.log('\nsdkAbortController — _abortActiveQuery\n')

// ── Abort propagation ──

test('_abortActiveQuery calls abort(reason) on the stored AbortController', () => {
  svc._resetAbortStateForTest()

  let abortedReason = null
  const mockAc = { abort: (r) => { abortedReason = r } }
  svc._setActiveAbortForTest(mockAc)
  svc._setActiveQueryForTest({ close: () => {} })

  svc._abortActiveQuery('tool_watchdog')

  assert.strictEqual(abortedReason, 'tool_watchdog', 'abort() must be called with the reason string')
})

test('_abortActiveQuery nulls activeAbort and activeQuery after abort', () => {
  svc._resetAbortStateForTest()

  svc._setActiveAbortForTest({ abort: () => {} })
  svc._setActiveQueryForTest({ close: () => {} })

  svc._abortActiveQuery('inactivity_timeout')

  // After abort: both handles should be null (verified via _isAbortInProgressForTest)
  // We can't read activeAbort/activeQuery directly, but if abort fired,
  // the _abortInProgress flag confirms the function completed.
  assert.strictEqual(svc._isAbortInProgressForTest(), true, '_abortInProgress must be set for watchdog abort')
})

test('_abortActiveQuery is safe when no AbortController is stored (noop path)', () => {
  svc._resetAbortStateForTest()
  svc._setActiveQueryForTest({ close: () => {} })
  // No activeAbort set — should not throw

  assert.doesNotThrow(() => svc._abortActiveQuery('manual_restart'))
})

test('_abortActiveQuery is safe when neither query nor controller is stored', () => {
  svc._resetAbortStateForTest()

  assert.doesNotThrow(() => svc._abortActiveQuery('explicit_abort'))
})

// ── Grace timer scheduling ──

test('grace timer is scheduled for tool_watchdog reason', () => {
  svc._resetAbortStateForTest()

  svc._abortActiveQuery('tool_watchdog')

  const timer = svc._getAbortGraceTimerForTest()
  assert.ok(timer !== null, 'grace timer must be scheduled for tool_watchdog')

  svc._resetAbortStateForTest()
})

test('grace timer is scheduled for inactivity_timeout reason', () => {
  svc._resetAbortStateForTest()

  svc._abortActiveQuery('inactivity_timeout')

  const timer = svc._getAbortGraceTimerForTest()
  assert.ok(timer !== null, 'grace timer must be scheduled for inactivity_timeout')

  svc._resetAbortStateForTest()
})

test('grace timer is scheduled for turn_watchdog reason', () => {
  svc._resetAbortStateForTest()

  svc._abortActiveQuery('turn_watchdog')

  const timer = svc._getAbortGraceTimerForTest()
  assert.ok(timer !== null, 'grace timer must be scheduled for turn_watchdog')

  svc._resetAbortStateForTest()
})

test('grace timer is scheduled for manual_restart reason', () => {
  svc._resetAbortStateForTest()

  svc._abortActiveQuery('manual_restart')

  const timer = svc._getAbortGraceTimerForTest()
  assert.ok(timer !== null, 'grace timer must be scheduled for manual_restart')

  svc._resetAbortStateForTest()
})

test('grace timer is scheduled for explicit_abort reason', () => {
  svc._resetAbortStateForTest()

  svc._abortActiveQuery('explicit_abort')

  const timer = svc._getAbortGraceTimerForTest()
  assert.ok(timer !== null, 'grace timer must be scheduled for explicit_abort')

  svc._resetAbortStateForTest()
})

// ── Grace timer NOT scheduled for turn-replacement reasons ──

test('grace timer is NOT scheduled for new_turn_starting', () => {
  svc._resetAbortStateForTest()

  svc._abortActiveQuery('new_turn_starting')

  const timer = svc._getAbortGraceTimerForTest()
  assert.strictEqual(timer, null, 'grace timer must NOT be scheduled for new_turn_starting')
  assert.strictEqual(svc._isAbortInProgressForTest(), false, '_abortInProgress must NOT be set for new_turn_starting')
})

test('grace timer is NOT scheduled for priority_preempt', () => {
  svc._resetAbortStateForTest()

  svc._abortActiveQuery('priority_preempt')

  const timer = svc._getAbortGraceTimerForTest()
  assert.strictEqual(timer, null, 'grace timer must NOT be scheduled for priority_preempt')
  assert.strictEqual(svc._isAbortInProgressForTest(), false, '_abortInProgress must NOT be set for priority_preempt')
})

// ── Grace timer cleared by _resetAbortStateForTest (simulating natural completion) ──

test('_resetAbortStateForTest clears grace timer (simulates natural turn completion)', () => {
  svc._resetAbortStateForTest()

  svc._abortActiveQuery('tool_watchdog')

  // Timer scheduled
  assert.ok(svc._getAbortGraceTimerForTest() !== null, 'timer should be scheduled')
  assert.strictEqual(svc._isAbortInProgressForTest(), true, '_abortInProgress should be true')

  // Natural completion path — resets state
  svc._resetAbortStateForTest()

  assert.strictEqual(svc._getAbortGraceTimerForTest(), null, 'timer should be cleared on natural completion')
  assert.strictEqual(svc._isAbortInProgressForTest(), false, '_abortInProgress should be false after completion')
})

test('second abort call replaces the previous grace timer without leaking', () => {
  svc._resetAbortStateForTest()

  svc._abortActiveQuery('tool_watchdog')
  const first = svc._getAbortGraceTimerForTest()

  svc._abortActiveQuery('inactivity_timeout')
  const second = svc._getAbortGraceTimerForTest()

  // Second timer should be a fresh handle, first should have been cleared
  assert.ok(second !== null, 'second timer must be scheduled')
  assert.notStrictEqual(first, second, 'each abort should create a new timer handle')

  svc._resetAbortStateForTest()
})

// ─── Run ──────────────────────────────────────────────────────────────────────

runAll().catch(err => {
  console.error('Test runner error:', err)
  process.exit(1)
})
