'use strict'

/**
 * sessionHandoff TEXT-column integration test.
 *
 * Mirrors the 6 cases in sessionHandoff.test.js but uses a TEXT-column-aware
 * mock that stores kv_store.value as a JSON STRING (not a parsed object), and
 * throws "operator does not exist: text ->> unknown" when the SQL contains
 * value->>' without a ::jsonb cast - exactly what Postgres does on a TEXT column.
 *
 * These tests MUST pass with the fixed consumeHandoffState() (::jsonb casts
 * present in WHERE clause) and WOULD fail with the original code (bare value->>'
 * in WHERE clause triggers the thrown error, consumeHandoffState returns null).
 */

// ── TEXT-column-aware kv_store mock ──────────────────────────────────

jest.mock('../../src/config/db', () => {
  const store = {}

  const mockDb = jest.fn(async (strings, ...values) => {
    // Join the static template parts (interpolated values are separate).
    // Using the same join strategy as the existing sessionHandoff.test.js mock.
    const sql = Array.from(strings).join('')

    // INSERT INTO kv_store (key, value) ...
    if (/insert into kv_store/i.test(sql)) {
      const key = values[0]
      const val = values[1]
      // Store as a raw JSON string - TEXT column, not JSONB.
      store[key] = typeof val === 'string' ? val : JSON.stringify(val)
      return []
    }

    // SELECT value FROM kv_store WHERE key = ?
    if (/select value from kv_store/i.test(sql)) {
      const key = values[0]
      // Return the raw JSON string so callers must handle the string-or-object case.
      return store[key] ? [{ value: store[key] }] : []
    }

    // UPDATE kv_store SET value = jsonb_set(...) WHERE ... RETURNING value
    if (/update kv_store/i.test(sql) && /returning/i.test(sql)) {
      // Simulate Postgres TEXT column behaviour:
      //   value->>'X'          - invalid on TEXT; throws
      //   value::jsonb->>'X'   - valid; parses correctly
      //
      // Detection: if the SQL contains value->>' but NOT value::jsonb->>'
      // (these two substrings are mutually exclusive - ::jsonb is not a substr
      // of the bare ->>' form), the WHERE clause is missing the cast.
      if (/value->>'/.test(sql) && !/value::jsonb->>'/.test(sql)) {
        throw Object.assign(
          new Error("operator does not exist: text ->> unknown"),
          { code: '42883' }
        )
      }

      // Fixed path: correctly-cast SQL. Simulate the atomic consume.
      // values[0] = markedConsumedAt (ISO string), values[1] = KV_KEY
      const consumedAt = values[0]
      const key = values[1]
      if (!store[key]) return []

      const s = JSON.parse(store[key])

      // WHERE: consumed_at must be absent or older than saved_at
      if (s.consumed_at && new Date(s.consumed_at) >= new Date(s.saved_at)) return []

      const updated = { ...s, consumed_at: consumedAt }
      store[key] = JSON.stringify(updated)
      return [{ value: store[key] }]
    }

    return []
  })

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

describe('sessionHandoff TEXT-column behaviour', () => {
  beforeEach(() => {
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

  test('2. peek is non-destructive - multiple peeks return same block', async () => {
    await saveHandoffState({ current_work: 'peek-safe work' })

    const first = await peekHandoffState()
    const second = await peekHandoffState()
    const third = await peekHandoffState()

    expect(first).not.toBeNull()
    expect(second).toEqual(first)
    expect(third).toEqual(first)
  })

  test('3. consumeHandoffState returns formatted block', async () => {
    await saveHandoffState({ current_work: 'critical work', deliverables_status: 'in progress' })

    const result = await consumeHandoffState()
    expect(result).not.toBeNull()
    expect(result).toContain('critical work')
    expect(result).toContain('in progress')
  })

  test('4. peek returns null after consume', async () => {
    await saveHandoffState({ current_work: 'something important' })

    const consumed = await consumeHandoffState()
    expect(consumed).not.toBeNull()

    const peeked = await peekHandoffState()
    expect(peeked).toBeNull()
  })

  test('5. consume returns null after consume (idempotent)', async () => {
    await saveHandoffState({ current_work: 'once only' })

    const first = await consumeHandoffState()
    expect(first).not.toBeNull()

    const second = await consumeHandoffState()
    expect(second).toBeNull()
  })

  test('6. saveHandoffState with new data resets - subsequent peek returns new block', async () => {
    await saveHandoffState({ current_work: 'old work' })
    await consumeHandoffState()

    expect(await peekHandoffState()).toBeNull()

    await saveHandoffState({ current_work: 'new work', active_plan: 'phase 2' })

    const result = await peekHandoffState()
    expect(result).not.toBeNull()
    expect(result).toContain('new work')
    expect(result).toContain('phase 2')
    expect(result).not.toContain('old work')
  })
})
