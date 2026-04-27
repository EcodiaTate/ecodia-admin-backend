'use strict'

/**
 * sessionHandoff consume-vs-peek smoke test.
 *
 * Verifies:
 *   1. saveHandoffState writes state.
 *   2. peekHandoffState returns the formatted block (non-destructive).
 *   3. consumeHandoffState returns the formatted block AND marks row consumed.
 *   4. peekHandoffState returns null after consume.
 *   5. consumeHandoffState returns null after consume.
 *   6. saveHandoffState with NEW data resets — subsequent peek returns the new block.
 *
 * The db mock simulates kv_store JSONB operations in-memory so this runs
 * without a real Postgres connection.
 */

// ── in-memory kv_store mock ───────────────────────────────────────────

jest.mock('../../src/config/db', () => {
  const store = {}

  const mockDb = jest.fn(async (strings, ...values) => {
    const sql = Array.from(strings).join('').trim().toLowerCase()

    // INSERT INTO kv_store (key, value) VALUES ($1, $2) ON CONFLICT ...
    if (sql.includes('insert into kv_store')) {
      const key = values[0]
      const val = values[1]
      store[key] = typeof val === 'string' ? JSON.parse(val) : val
      return []
    }

    // SELECT value FROM kv_store WHERE key = $1
    if (sql.includes('select value from kv_store')) {
      const key = values[0]
      return store[key] ? [{ value: store[key] }] : []
    }

    // UPDATE kv_store SET value = jsonb_set(...) WHERE key = $2 ... RETURNING value
    if (sql.includes('update kv_store') && sql.includes('returning')) {
      // values[0] = consumedAt string, values[1] = KV_KEY
      const consumedAt = values[0]
      const key = values[1]
      if (!store[key]) return []
      const s = store[key]
      // Already consumed?
      if (s.consumed_at && new Date(s.consumed_at) >= new Date(s.saved_at)) return []
      store[key] = { ...s, consumed_at: consumedAt }
      return [{ value: store[key] }]
    }

    return []
  })

  // Expose for clearing between test suites if needed
  mockDb._store = store
  return mockDb
})

jest.mock('../../src/config/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  debug: jest.fn(),
  error: jest.fn(),
}))

// ── tests ─────────────────────────────────────────────────────────────

const { peekHandoffState, consumeHandoffState, saveHandoffState } = require('../../src/services/sessionHandoff')

describe('sessionHandoff consume-vs-peek separation', () => {
  beforeEach(() => {
    // Clear the in-memory store before each test by resetting all keys
    const db = require('../../src/config/db')
    Object.keys(db._store).forEach(k => delete db._store[k])
    jest.clearAllMocks()
  })

  test('1. saveHandoffState writes; peek returns formatted block', async () => {
    await saveHandoffState({ current_work: 'building the thing', active_plan: 'phase 1' })

    const result = await peekHandoffState()
    expect(result).not.toBeNull()
    expect(result).toContain('building the thing')
    expect(result).toContain('phase 1')
  })

  test('2. consumeHandoffState returns formatted block', async () => {
    await saveHandoffState({ current_work: 'critical work', deliverables_status: 'in progress' })

    const result = await consumeHandoffState()
    expect(result).not.toBeNull()
    expect(result).toContain('critical work')
    expect(result).toContain('in progress')
  })

  test('3. peek returns null after consume', async () => {
    await saveHandoffState({ current_work: 'something important' })

    const consumed = await consumeHandoffState()
    expect(consumed).not.toBeNull()

    const peeked = await peekHandoffState()
    expect(peeked).toBeNull()
  })

  test('4. consume returns null after consume (idempotent)', async () => {
    await saveHandoffState({ current_work: 'once only' })

    const first = await consumeHandoffState()
    expect(first).not.toBeNull()

    const second = await consumeHandoffState()
    expect(second).toBeNull()
  })

  test('5. saveHandoffState with new data resets — peek returns new block', async () => {
    await saveHandoffState({ current_work: 'old work' })
    await consumeHandoffState() // consume the old one

    // Verify old is consumed
    expect(await peekHandoffState()).toBeNull()

    // Write new state (consumed_at must NOT carry over)
    await saveHandoffState({ current_work: 'new work', active_plan: 'phase 2' })

    const result = await peekHandoffState()
    expect(result).not.toBeNull()
    expect(result).toContain('new work')
    expect(result).toContain('phase 2')
    expect(result).not.toContain('old work')
  })

  test('6. peek is non-destructive — multiple peeks return same block', async () => {
    await saveHandoffState({ current_work: 'peek-safe work' })

    const first = await peekHandoffState()
    const second = await peekHandoffState()
    const third = await peekHandoffState()

    expect(first).not.toBeNull()
    expect(second).toEqual(first)
    expect(third).toEqual(first)
  })
})
