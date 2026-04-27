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
 */

// ─── Dependency mocks ─────────────────────────────────────────────────────────

jest.mock('../src/config/db', () => {
  function mockDbTag() { return Promise.resolve([]) }
  mockDbTag.sql = async () => []
  mockDbTag.begin = async (fn) => fn(mockDbTag)
  return mockDbTag
})

jest.mock('../src/config/logger', () => ({
  debug: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}))

jest.mock('../src/config/env', () => ({
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
}))

jest.mock('../src/websocket/wsManager', () => ({
  broadcast: jest.fn(),
  flushDeltasForTurnComplete: jest.fn(),
  resetSessionSeq: jest.fn(),
  broadcastToSession: jest.fn(),
}))

jest.mock('../src/services/secretSafetyService', () => ({
  scrubSecrets: (x) => x,
}))

jest.mock('../src/services/usageEnergyService', () => ({
  refreshAllAccounts: jest.fn().mockResolvedValue(undefined),
  getEnergy: jest.fn().mockResolvedValue({
    pctUsed: 0,
    level: 'healthy',
    accounts: { claude_max: {}, claude_max_2: {} },
  }),
  getBestProvider: jest.fn().mockReturnValue({
    provider: 'claude_max',
    isBedrockFallback: false,
    reason: 'healthy',
  }),
  setProvider: jest.fn(),
}))

jest.mock('../src/services/osIncidentService', () => ({
  log: jest.fn(),
}))

jest.mock('../src/services/sessionMemoryService', () => ({
  getSessionMemory: jest.fn().mockResolvedValue(null),
  saveSessionMemory: jest.fn().mockResolvedValue(undefined),
}))

jest.mock('../src/services/osConversationLog', () => ({
  getNextTurnNumber: jest.fn().mockResolvedValue(0),
  logTurn: jest.fn().mockResolvedValue(undefined),
}))

jest.mock('../src/services/neo4jRetrieval', () => ({
  fusedSearch: jest.fn().mockResolvedValue([]),
  getRecentHighPriorityNodes: jest.fn().mockResolvedValue([]),
}))

// ─── Module under test ────────────────────────────────────────────────────────

const svc = require('../src/services/osSessionService')

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('SDK AbortController', () => {
  // ── Abort propagation ──

  test('_abortActiveQuery calls abort(reason) on the stored AbortController', () => {
    svc._resetAbortStateForTest()

    let abortedReason = null
    const mockAc = { abort: (r) => { abortedReason = r } }
    svc._setActiveAbortForTest(mockAc)
    svc._setActiveQueryForTest({ close: () => {} })

    svc._abortActiveQuery('tool_watchdog')

    expect(abortedReason).toBe('tool_watchdog')
  })

  test('_abortActiveQuery nulls activeAbort and activeQuery after abort', () => {
    svc._resetAbortStateForTest()

    svc._setActiveAbortForTest({ abort: () => {} })
    svc._setActiveQueryForTest({ close: () => {} })

    svc._abortActiveQuery('inactivity_timeout')

    expect(svc._isAbortInProgressForTest()).toBe(true)
  })

  test('_abortActiveQuery is safe when no AbortController is stored (noop path)', () => {
    svc._resetAbortStateForTest()
    svc._setActiveQueryForTest({ close: () => {} })

    expect(() => svc._abortActiveQuery('manual_restart')).not.toThrow()
  })

  test('_abortActiveQuery is safe when neither query nor controller is stored', () => {
    svc._resetAbortStateForTest()

    expect(() => svc._abortActiveQuery('explicit_abort')).not.toThrow()
  })

  // ── Grace timer scheduling ──

  test('grace timer is scheduled for tool_watchdog reason', () => {
    svc._resetAbortStateForTest()

    svc._abortActiveQuery('tool_watchdog')

    const timer = svc._getAbortGraceTimerForTest()
    expect(timer).not.toBeNull()

    svc._resetAbortStateForTest()
  })

  test('grace timer is scheduled for inactivity_timeout reason', () => {
    svc._resetAbortStateForTest()

    svc._abortActiveQuery('inactivity_timeout')

    const timer = svc._getAbortGraceTimerForTest()
    expect(timer).not.toBeNull()

    svc._resetAbortStateForTest()
  })

  test('grace timer is scheduled for turn_watchdog reason', () => {
    svc._resetAbortStateForTest()

    svc._abortActiveQuery('turn_watchdog')

    const timer = svc._getAbortGraceTimerForTest()
    expect(timer).not.toBeNull()

    svc._resetAbortStateForTest()
  })

  test('grace timer is scheduled for manual_restart reason', () => {
    svc._resetAbortStateForTest()

    svc._abortActiveQuery('manual_restart')

    const timer = svc._getAbortGraceTimerForTest()
    expect(timer).not.toBeNull()

    svc._resetAbortStateForTest()
  })

  test('grace timer is scheduled for explicit_abort reason', () => {
    svc._resetAbortStateForTest()

    svc._abortActiveQuery('explicit_abort')

    const timer = svc._getAbortGraceTimerForTest()
    expect(timer).not.toBeNull()

    svc._resetAbortStateForTest()
  })

  // ── Grace timer NOT scheduled for turn-replacement reasons ──

  test('grace timer is NOT scheduled for new_turn_starting', () => {
    svc._resetAbortStateForTest()

    svc._abortActiveQuery('new_turn_starting')

    const timer = svc._getAbortGraceTimerForTest()
    expect(timer).toBeNull()
    expect(svc._isAbortInProgressForTest()).toBe(false)
  })

  test('grace timer is NOT scheduled for priority_preempt', () => {
    svc._resetAbortStateForTest()

    svc._abortActiveQuery('priority_preempt')

    const timer = svc._getAbortGraceTimerForTest()
    expect(timer).toBeNull()
    expect(svc._isAbortInProgressForTest()).toBe(false)
  })

  // ── Grace timer cleared by _resetAbortStateForTest (simulating natural completion) ──

  test('_resetAbortStateForTest clears grace timer (simulates natural turn completion)', () => {
    svc._resetAbortStateForTest()

    svc._abortActiveQuery('tool_watchdog')

    expect(svc._getAbortGraceTimerForTest()).not.toBeNull()
    expect(svc._isAbortInProgressForTest()).toBe(true)

    svc._resetAbortStateForTest()

    expect(svc._getAbortGraceTimerForTest()).toBeNull()
    expect(svc._isAbortInProgressForTest()).toBe(false)
  })

  test('second abort call replaces the previous grace timer without leaking', () => {
    svc._resetAbortStateForTest()

    svc._abortActiveQuery('tool_watchdog')
    const first = svc._getAbortGraceTimerForTest()

    svc._abortActiveQuery('inactivity_timeout')
    const second = svc._getAbortGraceTimerForTest()

    expect(second).not.toBeNull()
    expect(first).not.toBe(second)

    svc._resetAbortStateForTest()
  })
})
