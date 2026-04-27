'use strict'

/**
 * Message Queue — unit tests
 *
 * Tests pure logic only (no live DB, no HTTP). The service's internal
 * _ageSuffix function and message-building patterns are tested directly.
 * Integration behaviour (enqueue -> deliver -> DB row) is covered by the
 * manual curl validation steps in the deployment runbook.
 */

const { _ageSuffix } = require('../src/services/messageQueue')

describe('messageQueue _ageSuffix', () => {
  afterAll(async () => {
    await new Promise(r => setImmediate(r))
    await new Promise(r => setImmediate(r))
  })

  // ── ageSuffix formatting ─────────────────────────────────────────────────

  test('ageSuffix: under 1 minute (10 seconds)', () => {
    const queuedAt = new Date(Date.now() - 10_000)  // 10 seconds ago (rounds to 0m)
    const suffix = _ageSuffix(queuedAt.toISOString())
    expect(suffix).toBe('queued 0m ago')
  })

  test('ageSuffix: 25 minutes', () => {
    const queuedAt = new Date(Date.now() - 25 * 60_000)
    const suffix = _ageSuffix(queuedAt.toISOString())
    expect(suffix).toBe('queued 25m ago')
  })

  test('ageSuffix: exactly 60 minutes', () => {
    const queuedAt = new Date(Date.now() - 60 * 60_000)
    const suffix = _ageSuffix(queuedAt.toISOString())
    expect(suffix).toBe('queued 1h 0m ago')
  })

  test('ageSuffix: 90 minutes', () => {
    const queuedAt = new Date(Date.now() - 90 * 60_000)
    const suffix = _ageSuffix(queuedAt.toISOString())
    expect(suffix).toBe('queued 1h 30m ago')
  })

  test('ageSuffix: 3 hours 15 minutes', () => {
    const queuedAt = new Date(Date.now() - (3 * 60 + 15) * 60_000)
    const suffix = _ageSuffix(queuedAt.toISOString())
    expect(suffix).toBe('queued 3h 15m ago')
  })
})
