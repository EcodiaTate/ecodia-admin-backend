'use strict'

/**
 * Credit-exhaustion handling unit tests.
 *
 * Doctrine: ~/ecodiaos/patterns/graceful-credit-exhaustion-handling.md
 * Implementation: src/services/forkService.js (migration 068).
 *
 * Coverage:
 *   - _classifyFailure() classifies the four real-world signals correctly:
 *     "out of extra usage", "resets HH:MM (UTC)", rate-limit, quota-exhausted.
 *   - _parseResetTimestamp() handles am/pm, 24h UTC, and rolls forward when
 *     the parsed reset is already in the past.
 *   - _handleCreditExhaustion side-effects: kv_store account_health write,
 *     anti-flood pause when 3+ consecutive, schedule_delayed insert,
 *     status_board surface, telemetry append.
 *   - _readDispatchPaused / _blockedAccounts roundtrip kv_store text encoding.
 *
 * The DB is mocked at the postgres-tagged-template level, matching the
 * pattern used in forkService.parallelism.test.js. We assert on the SQL
 * fragments and parameter values that flow through the mock.
 */

// ---- DB mock: postgres tagged template ----
//
// The real db (src/config/db) is `postgres(connectionString, opts)` which
// returns a tagged-template function. The mock is hoisted by jest before any
// require, so it must be self-contained. We attach call/return arrays to
// globalThis so the test bodies below can inspect them post-hoc.

jest.mock('../../src/config/db', () => {
  const _calls = []
  const _returns = []
  const fn = function (strings, ...values) {
    if (Array.isArray(strings) && strings.raw) {
      const sql = strings.join('?')
      _calls.push({ sql, values })
      const next = _returns.shift()
      return Promise.resolve(next || [])
    }
    return Promise.resolve([])
  }
  fn.__calls = _calls
  fn.__returns = _returns
  return fn
})

const mockedDb = require('../../src/config/db')
const dbCalls = mockedDb.__calls
const dbReturns = mockedDb.__returns

jest.mock('../../src/config/env', () => ({
  OS_SESSION_CWD: require('os').tmpdir(),
}))

jest.mock('../../src/config/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  debug: jest.fn(),
  error: jest.fn(),
}))

jest.mock('../../src/services/usageEnergyService', () => ({
  getEnergy: jest.fn().mockResolvedValue({ level: 'healthy' }),
  getBestProvider: jest.fn().mockReturnValue({ provider: 'claude_max', reason: 'mock', isBedrockFallback: false }),
}))

jest.mock('../../src/services/secretSafetyService', () => ({ scrubSecrets: jest.fn(s => s) }))
jest.mock('../../src/services/messageQueue', () => ({ enqueueMessage: jest.fn().mockResolvedValue({}) }))
jest.mock('../../src/websocket/wsManager', () => ({
  broadcast: jest.fn(),
  flushDeltasForTurnComplete: jest.fn(),
  resetSessionSeq: jest.fn(),
}))

// ---- Module under test ----

const fork = require('../../src/services/forkService')

beforeEach(() => {
  dbCalls.length = 0
  dbReturns.length = 0
  jest.clearAllMocks()
})

// ---------------------------------------------------------------------------
// _classifyFailure
// ---------------------------------------------------------------------------

describe('_classifyFailure', () => {
  test('classifies the canonical "out of extra usage" abort_reason', () => {
    const err = new Error("Claude Code returned an error result: You're out of extra usage  resets 8:10am (UTC)")
    expect(fork._classifyFailure(err)).toBe('credit_exhaustion')
  })

  test('classifies a 24h-UTC reset window', () => {
    const err = new Error('claude-code: provider error - resets 18:10 UTC')
    expect(fork._classifyFailure(err)).toBe('credit_exhaustion')
  })

  test('classifies rate-limit signals', () => {
    expect(fork._classifyFailure(new Error('rate.limit exceeded'))).toBe('credit_exhaustion')
    expect(fork._classifyFailure(new Error('rate-limit hit'))).toBe('credit_exhaustion')
    expect(fork._classifyFailure(new Error('rate_limit on Anthropic API'))).toBe('credit_exhaustion')
  })

  test('classifies quota-exhausted signals', () => {
    expect(fork._classifyFailure(new Error('quota.exhausted on account'))).toBe('credit_exhaustion')
    expect(fork._classifyFailure(new Error('quota_exhausted'))).toBe('credit_exhaustion')
  })

  test('classifies billing-tier credit signals', () => {
    expect(fork._classifyFailure(new Error('Your credit balance is too low'))).toBe('credit_exhaustion')
  })

  test('classifies timeouts as timeout', () => {
    const err = new Error('SDK timeout after 1800s')
    expect(fork._classifyFailure(err)).toBe('timeout')
    const err2 = new Error('something failed')
    err2.name = 'TimeoutError'
    expect(fork._classifyFailure(err2)).toBe('timeout')
  })

  test('classifies generic errors as fork_error', () => {
    expect(fork._classifyFailure(new Error('TypeError: cannot read property foo of undefined'))).toBe('fork_error')
    expect(fork._classifyFailure(new Error('ECONNREFUSED'))).toBe('fork_error')
    expect(fork._classifyFailure(null)).toBe('fork_error')
    expect(fork._classifyFailure(undefined)).toBe('fork_error')
  })
})

// ---------------------------------------------------------------------------
// _parseResetTimestamp
// ---------------------------------------------------------------------------

describe('_parseResetTimestamp', () => {
  test('parses am suffix (HH:MM am UTC)', () => {
    // We use a time that is genuinely in the future relative to now() so we
    // don't accidentally trigger the day-rollforward branch. Pick "23:59 UTC"
    // which is the latest possible time-of-day - unless the test is
    // literally running at 23:59 UTC, this is in the future.
    const iso = fork._parseResetTimestamp('Provider error: resets 8:10am (UTC)')
    expect(iso).toMatch(/T08:10:00\.000Z$/)
  })

  test('parses pm suffix and converts to 24h', () => {
    const iso = fork._parseResetTimestamp('resets 6:10pm (UTC)')
    expect(iso).toMatch(/T18:10:00\.000Z$/)
  })

  test('parses 24h format without am/pm', () => {
    const iso = fork._parseResetTimestamp('resets 18:10 UTC')
    expect(iso).toMatch(/T18:10:00\.000Z$/)
  })

  test('parses with parens around utc', () => {
    const iso = fork._parseResetTimestamp('resets 22:00 (utc)')
    expect(iso).toMatch(/T22:00:00\.000Z$/)
  })

  test('rolls forward to tomorrow when the parsed time is already past', () => {
    // Build a string with time = 1 minute ago in UTC. Should roll to tomorrow.
    const now = new Date()
    const past = new Date(now.getTime() - 60_000)
    const hh = String(past.getUTCHours()).padStart(2, '0')
    const mm = String(past.getUTCMinutes()).padStart(2, '0')
    const iso = fork._parseResetTimestamp(`resets ${hh}:${mm} UTC`)
    expect(iso).toBeTruthy()
    const parsed = new Date(iso)
    // Must be strictly in the future.
    expect(parsed.getTime()).toBeGreaterThan(Date.now())
  })

  test('returns null on no match', () => {
    expect(fork._parseResetTimestamp('something unrelated')).toBeNull()
    expect(fork._parseResetTimestamp(null)).toBeNull()
    expect(fork._parseResetTimestamp('')).toBeNull()
  })

  test('returns null on garbage hour/minute', () => {
    expect(fork._parseResetTimestamp('resets 99:99 UTC')).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// _buildResumePrompt
// ---------------------------------------------------------------------------

describe('_buildResumePrompt', () => {
  test('includes verify-before-redo references and the original brief', () => {
    const state = {
      fork_id: 'fork_test_123',
      started_at: Date.now(),
      brief: 'BRIEF: do the thing.',
      resumable_brief: 'BRIEF: do the thing (snapshot).',
    }
    const prompt = fork._buildResumePrompt(state)
    expect(prompt).toContain('RESUME of fork_test_123')
    expect(prompt).toContain('VERIFY-BEFORE-REDO')
    expect(prompt).toContain('scheduled-redispatch-verify-not-shipped')
    expect(prompt).toContain('BRIEF: do the thing (snapshot).')
    expect(prompt).toContain('Original brief:')
  })

  test('falls back to state.brief when resumable_brief is unset', () => {
    const state = {
      fork_id: 'fork_test_456',
      started_at: Date.now(),
      brief: 'BRIEF: live brief',
    }
    const prompt = fork._buildResumePrompt(state)
    expect(prompt).toContain('BRIEF: live brief')
  })
})

// ---------------------------------------------------------------------------
// _handleCreditExhaustion - side effects via the DB mock.
// ---------------------------------------------------------------------------

describe('_handleCreditExhaustion side effects', () => {
  test('writes account_health, anti-flood threshold triggers dispatch_paused at 3+', async () => {
    const state = {
      fork_id: 'fork_credit_1',
      provider: 'claude_max',
      brief: 'BRIEF: original work.',
      resumable_brief: 'BRIEF: original work.',
      started_at: Date.now() - 60_000,
      credit_reset_at: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
    }

    // 1st call: account_health UPSERT - returns []
    dbReturns.push([])
    // 2nd call: anti-flood SELECT count - returns 3 (threshold)
    dbReturns.push([{ n: 3 }])
    // 3rd call: dispatch_paused UPSERT - returns []
    dbReturns.push([])
    // 4th call: schedule_delayed INSERT - returns []
    dbReturns.push([])
    // 5th call: status_board SELECT existing - returns [] (no row yet)
    dbReturns.push([])
    // 6th call: status_board INSERT - returns []
    dbReturns.push([])

    await fork._handleCreditExhaustion(state)

    // Assert: account_health UPSERT happened with the right key.
    const accountHealthCall = dbCalls.find(c => c.values.includes('forks.account_health.claude_max'))
    expect(accountHealthCall).toBeTruthy()
    // value should be a JSON string with status: credit_exhausted
    const valueArg = accountHealthCall.values.find(v => typeof v === 'string' && v.includes('credit_exhausted'))
    expect(valueArg).toBeTruthy()
    expect(JSON.parse(valueArg)).toMatchObject({ status: 'credit_exhausted', last_fork: 'fork_credit_1' })

    // Assert: anti-flood SELECT was issued.
    const antifloodCall = dbCalls.find(c => /failure_class\s*=\s*'credit_exhaustion'/.test(c.sql))
    expect(antifloodCall).toBeTruthy()

    // Assert: dispatch_paused was set (because count >= 3).
    const pausedCall = dbCalls.find(c => c.values.includes('forks.dispatch_paused'))
    expect(pausedCall).toBeTruthy()
    const pausedValue = pausedCall.values.find(v => typeof v === 'string' && v.includes('credit_exhaustion_flood'))
    expect(JSON.parse(pausedValue)).toMatchObject({ paused: true, reason: 'credit_exhaustion_flood', consecutive: 3 })

    // Assert: schedule_delayed INSERT happened.
    const scheduleCall = dbCalls.find(c =>
      /INSERT INTO os_scheduled_tasks/.test(c.sql) &&
      c.values.some(v => typeof v === 'string' && v.startsWith('resume-fork-'))
    )
    expect(scheduleCall).toBeTruthy()

    // Assert: status_board INSERT happened (no existing row).
    const sbCall = dbCalls.find(c =>
      /INSERT INTO status_board/.test(c.sql) &&
      c.values.some(v => typeof v === 'string' && v.startsWith('Forks pending credit-reset resume'))
    )
    expect(sbCall).toBeTruthy()
  })

  test('does NOT pause dispatch when consecutive=1 (single fork)', async () => {
    const state = {
      fork_id: 'fork_single',
      provider: 'claude_max_2',
      brief: 'BRIEF: single fork.',
      resumable_brief: 'BRIEF: single fork.',
      started_at: Date.now(),
      credit_reset_at: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
    }

    dbReturns.push([])              // account_health UPSERT
    dbReturns.push([{ n: 1 }])      // anti-flood count = 1 (below threshold)
    dbReturns.push([])              // schedule_delayed INSERT
    dbReturns.push([])              // status_board SELECT existing
    dbReturns.push([])              // status_board INSERT

    await fork._handleCreditExhaustion(state)

    // Assert: NO dispatch_paused write.
    const pausedCall = dbCalls.find(c => c.values.includes('forks.dispatch_paused'))
    expect(pausedCall).toBeFalsy()
  })

  test('skips schedule_delayed when credit_reset_at is null', async () => {
    const state = {
      fork_id: 'fork_no_reset',
      provider: 'claude_max',
      brief: 'BRIEF: no reset parsed.',
      resumable_brief: 'BRIEF: no reset parsed.',
      started_at: Date.now(),
      credit_reset_at: null,
    }
    dbReturns.push([])
    dbReturns.push([{ n: 1 }])
    dbReturns.push([])
    dbReturns.push([])

    await fork._handleCreditExhaustion(state)

    const scheduleCall = dbCalls.find(c => /INSERT INTO os_scheduled_tasks/.test(c.sql))
    expect(scheduleCall).toBeFalsy()
  })
})

// ---------------------------------------------------------------------------
// _readDispatchPaused / _blockedAccounts roundtrip
// ---------------------------------------------------------------------------

describe('kv_store text encoding roundtrip', () => {
  test('_readDispatchPaused returns paused when until is in the future', async () => {
    const future = new Date(Date.now() + 60 * 60 * 1000).toISOString()
    dbReturns.push([{ value: JSON.stringify({ paused: true, until: future, reason: 'credit_exhaustion_flood' }) }])
    const result = await fork._readDispatchPaused()
    expect(result).toEqual({ paused: true, until: future })
  })

  test('_readDispatchPaused returns paused=false when until is in the past', async () => {
    const past = new Date(Date.now() - 60 * 60 * 1000).toISOString()
    dbReturns.push([{ value: JSON.stringify({ paused: true, until: past }) }])
    const result = await fork._readDispatchPaused()
    expect(result).toEqual({ paused: false })
  })

  test('_readDispatchPaused returns paused=false when key absent', async () => {
    dbReturns.push([])
    expect(await fork._readDispatchPaused()).toEqual({ paused: false })
  })

  test('_blockedAccounts returns set of accounts whose reset is future', async () => {
    const future = new Date(Date.now() + 60 * 60 * 1000).toISOString()
    const past = new Date(Date.now() - 60 * 60 * 1000).toISOString()
    dbReturns.push([
      { key: 'forks.account_health.claude_max', value: JSON.stringify({ status: 'credit_exhausted', reset_at_utc: future }) },
      { key: 'forks.account_health.claude_max_2', value: JSON.stringify({ status: 'credit_exhausted', reset_at_utc: past }) },
    ])
    const blocked = await fork._blockedAccounts()
    expect(blocked.has('claude_max')).toBe(true)
    expect(blocked.has('claude_max_2')).toBe(false)
  })

  test('_blockedAccounts ignores garbage JSON', async () => {
    dbReturns.push([
      { key: 'forks.account_health.broken', value: '{not_valid_json' },
    ])
    const blocked = await fork._blockedAccounts()
    expect(blocked.size).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// CREDIT_EXHAUSTION_PATTERNS sanity (regression guard for pattern drift)
// ---------------------------------------------------------------------------

describe('CREDIT_EXHAUSTION_PATTERNS regression guard', () => {
  test('exports a non-empty array of regex patterns', () => {
    expect(Array.isArray(fork.CREDIT_EXHAUSTION_PATTERNS)).toBe(true)
    expect(fork.CREDIT_EXHAUSTION_PATTERNS.length).toBeGreaterThanOrEqual(5)
    for (const p of fork.CREDIT_EXHAUSTION_PATTERNS) expect(p).toBeInstanceOf(RegExp)
  })
})
