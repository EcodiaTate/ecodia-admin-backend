'use strict'

/**
 * invoicePaymentState listener - Jest tests.
 *
 * Mocks axios, db, and logger. Verifies:
 *   - relevanceFilter rejects irrelevant events (wrong table, non-INSERT, negative amount)
 *   - High confidence match (name + amount) inserts a match row and calls wakeOs
 *   - Medium confidence (amount only) inserts a match row and calls wakeOs
 *   - Low confidence (name only) does NOT insert a match row and does NOT call wakeOs
 *   - Empty invoices result returns silently
 *   - DB query failure on the SELECT does not crash the listener
 *   - Module shape is correct
 */

jest.mock('axios')
jest.mock('../../src/config/db', () => jest.fn())
jest.mock('../../src/config/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
}))

const axios = require('axios')
const db = require('../../src/config/db')
const listener = require('../../src/services/listeners/invoicePaymentState')

// Open invoices come from the SELECT against public.invoices and have shape
// { invoice_number, client_name, total_cents }.
const OPEN_INVOICES = [
  {
    invoice_number: 'INV-2026-001',
    client_name: 'Acme Corp',
    total_cents: 110000,
  },
  {
    invoice_number: 'INV-2026-002',
    client_name: 'Blue Horizon',
    total_cents: 55000,
  },
]

const makeEvent = (rowOverrides = {}) => ({
  type: 'db:event',
  seq: 1,
  ts: new Date().toISOString(),
  data: {
    type: 'db:event',
    table: 'staged_transactions',
    action: 'INSERT',
    row: {
      id: 'txn-uuid-1',
      amount_cents: 110000,
      description: 'Payment from Acme Corp ref 12345',
      occurred_at: '2026-04-28',
      ...rowOverrides,
    },
    ts: Date.now() / 1000,
  },
})

afterAll(async () => {
  await new Promise(r => setImmediate(r))
  await new Promise(r => setImmediate(r))
})

beforeEach(() => {
  jest.clearAllMocks()
  axios.post.mockResolvedValue({ status: 200 })
})

// ---- relevanceFilter ----

describe('relevanceFilter', () => {
  test('returns true for staged_transactions INSERT with positive amount', () => {
    expect(listener.relevanceFilter(makeEvent())).toBe(true)
  })

  test('returns false for negative amount (refund/expense)', () => {
    expect(listener.relevanceFilter(makeEvent({ amount_cents: -110000 }))).toBe(false)
  })

  test('returns false for zero amount', () => {
    expect(listener.relevanceFilter(makeEvent({ amount_cents: 0 }))).toBe(false)
  })

  test('returns false for action=UPDATE', () => {
    const event = makeEvent()
    event.data.action = 'UPDATE'
    expect(listener.relevanceFilter(event)).toBe(false)
  })

  test('returns false for table=cc_sessions', () => {
    const event = makeEvent()
    event.data.table = 'cc_sessions'
    expect(listener.relevanceFilter(event)).toBe(false)
  })

  test('returns false when row is missing', () => {
    const event = makeEvent()
    delete event.data.row
    expect(listener.relevanceFilter(event)).toBe(false)
  })

  test('returns false for non-db:event inner type', () => {
    const event = { type: 'text_delta', seq: 1, ts: new Date().toISOString(), data: { type: 'text_delta', content: 'hello' } }
    expect(listener.relevanceFilter(event)).toBe(false)
  })
})

// ---- handle ----

describe('handle — high confidence (name + amount match)', () => {
  test('inserts a match row and calls wakeOs', async () => {
    // Acme Corp: name token "acme" in description + amount 110000 matches
    db.mockResolvedValueOnce(OPEN_INVOICES)  // SELECT open invoices
    db.mockResolvedValueOnce([])  // INSERT into invoice_payment_matches

    const event = makeEvent({ amount_cents: 110000, description: 'Payment from Acme Corp ref 12345' })
    const ctx = { sourceEventId: 'evt-high-001' }

    await listener.handle(event, ctx)

    expect(db).toHaveBeenCalledTimes(2)
    expect(axios.post).toHaveBeenCalledTimes(1)

    const [url, body] = axios.post.mock.calls[0]
    expect(url).toContain('/api/os-session/message')
    expect(body.message).toContain('INV-2026-001')
    expect(body.message).toContain('confidence=high')
    expect(body.message).toContain('evt-high-001')
  })
})

describe('handle — medium confidence (amount only)', () => {
  test('inserts a match row and calls wakeOs even without name token', async () => {
    // Description has no recognisable client name token, but amount matches exactly
    db.mockResolvedValueOnce(OPEN_INVOICES)
    db.mockResolvedValueOnce([])

    const event = makeEvent({ amount_cents: 110000, description: 'Bank transfer 9876543' })
    const ctx = { sourceEventId: 'evt-med-001' }

    await listener.handle(event, ctx)

    expect(db).toHaveBeenCalledTimes(2)
    expect(axios.post).toHaveBeenCalledTimes(1)

    const [, body] = axios.post.mock.calls[0]
    expect(body.message).toContain('INV-2026-001')
    expect(body.message).toContain('confidence=medium')
  })
})

describe('handle — low confidence (name only)', () => {
  test('does NOT insert a match row and does NOT call wakeOs', async () => {
    // Description contains "acme" but amount does not match any invoice
    db.mockResolvedValueOnce(OPEN_INVOICES)

    const event = makeEvent({ amount_cents: 9999, description: 'Acme refund something' })
    const ctx = { sourceEventId: 'evt-low-001' }

    await listener.handle(event, ctx)

    // Only 1 db call (SELECT) — no INSERT
    expect(db).toHaveBeenCalledTimes(1)
    expect(axios.post).not.toHaveBeenCalled()
  })
})

describe('handle — empty open invoices', () => {
  test('returns silently when no open invoices exist', async () => {
    db.mockResolvedValueOnce([])  // empty result set

    const event = makeEvent()
    await listener.handle(event, { sourceEventId: 'evt-empty-001' })

    expect(db).toHaveBeenCalledTimes(1)
    expect(axios.post).not.toHaveBeenCalled()
  })
})

describe('handle — DB query failure', () => {
  test('does not crash when the SELECT throws', async () => {
    db.mockRejectedValueOnce(new Error('connection lost'))

    const event = makeEvent()
    let threw = false
    try {
      await listener.handle(event, { sourceEventId: 'evt-dbfail-001' })
    } catch {
      threw = true
    }

    expect(threw).toBe(false)
    expect(axios.post).not.toHaveBeenCalled()
  })
})

describe('handle — wakeOs failure', () => {
  test('does not throw if axios.post rejects', async () => {
    db.mockResolvedValueOnce(OPEN_INVOICES)
    db.mockResolvedValueOnce([])
    axios.post.mockRejectedValue(new Error('connection refused'))

    const event = makeEvent()
    let threw = false
    try {
      await listener.handle(event, { sourceEventId: 'evt-axiosfail-001' })
    } catch {
      threw = true
    }

    expect(threw).toBe(false)
  })
})

// ---- module shape ----

describe('module shape', () => {
  test('exports required listener fields', () => {
    expect(listener.name).toBe('invoicePaymentState')
    expect(Array.isArray(listener.subscribesTo)).toBe(true)
    expect(listener.subscribesTo).toContain('db:event')
    expect(typeof listener.relevanceFilter).toBe('function')
    expect(typeof listener.handle).toBe('function')
    expect(Array.isArray(listener.ownsWriteSurface)).toBe(true)
    expect(listener.ownsWriteSurface).toContain('invoice_payment_matches')
    expect(listener.ownsWriteSurface).toContain('os-session-message')
  })
})
