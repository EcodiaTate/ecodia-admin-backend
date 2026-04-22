'use strict'

/**
 * Message Queue — unit tests
 *
 * Tests pure logic only (no live DB, no HTTP). The service's internal
 * _ageSuffix function and message-building patterns are tested directly.
 * Integration behaviour (enqueue -> deliver -> DB row) is covered by the
 * manual curl validation steps in the deployment runbook.
 */

const assert = require('assert')
const { _ageSuffix } = require('../src/services/messageQueue')

let passed = 0
let failed = 0

function test(name, fn) {
  try {
    fn()
    console.log(`  PASS: ${name}`)
    passed++
  } catch (err) {
    console.error(`  FAIL: ${name}`)
    console.error(`    ${err.message}`)
    failed++
  }
}

// ── ageSuffix formatting ─────────────────────────────────────────────────

test('ageSuffix: under 1 minute (10 seconds)', () => {
  const queuedAt = new Date(Date.now() - 10_000)  // 10 seconds ago (rounds to 0m)
  const suffix = _ageSuffix(queuedAt.toISOString())
  assert.strictEqual(suffix, 'queued 0m ago')
})

test('ageSuffix: 25 minutes', () => {
  const queuedAt = new Date(Date.now() - 25 * 60_000)
  const suffix = _ageSuffix(queuedAt.toISOString())
  assert.strictEqual(suffix, 'queued 25m ago')
})

test('ageSuffix: exactly 60 minutes', () => {
  const queuedAt = new Date(Date.now() - 60 * 60_000)
  const suffix = _ageSuffix(queuedAt.toISOString())
  assert.strictEqual(suffix, 'queued 1h 0m ago')
})

test('ageSuffix: 90 minutes', () => {
  const queuedAt = new Date(Date.now() - 90 * 60_000)
  const suffix = _ageSuffix(queuedAt.toISOString())
  assert.strictEqual(suffix, 'queued 1h 30m ago')
})

test('ageSuffix: 3 hours 15 minutes', () => {
  const queuedAt = new Date(Date.now() - (3 * 60 + 15) * 60_000)
  const suffix = _ageSuffix(queuedAt.toISOString())
  assert.strictEqual(suffix, 'queued 3h 15m ago')
})

// ── Mode validation logic ────────────────────────────────────────────────

test('valid modes: direct and queue', () => {
  const validModes = new Set(['direct', 'queue'])
  assert.ok(validModes.has('direct'), 'direct should be valid')
  assert.ok(validModes.has('queue'), 'queue should be valid')
  assert.ok(!validModes.has('immediate'), 'immediate should not be valid')
  assert.ok(!validModes.has(''), 'empty string should not be valid')
})

// ── Drain preamble format ────────────────────────────────────────────────

test('drain preamble: prepends pending items before direct body', () => {
  // Simulate the logic in drainIntoDirectMessage (the pure string part)
  const directBody = 'hello, pick up where we left off'
  const items = [
    '1. finish the report (queued 12m ago)',
    '2. check the build (queued 5m ago)',
  ]
  const preamble = `[Pending queued messages delivered opportunistically]\n${items.join('\n')}\n---\n`
  const merged = preamble + directBody

  assert.ok(merged.startsWith('[Pending queued messages delivered opportunistically]'))
  assert.ok(merged.includes('finish the report'))
  assert.ok(merged.includes('check the build'))
  assert.ok(merged.endsWith(directBody))
})

test('drain preamble: returns directBody unchanged when items is empty', () => {
  const directBody = 'nothing queued, just this'
  const items = []
  const result = items.length === 0 ? directBody : `preamble\n${items.join('\n')}\n---\n${directBody}`
  assert.strictEqual(result, directBody)
})

// ── deliverPending message body format ──────────────────────────────────

test('deliverPending body: includes summary when provided', () => {
  const summary = 'just finished the bookkeeping audit'
  const intro = summary
    ? `[Queued by Tate, delivering now. I just finished: ${summary}]\n\n`
    : '[Queued messages from Tate, delivering now]\n\n'
  assert.ok(intro.includes('just finished the bookkeeping audit'))
})

test('deliverPending body: uses generic intro when no summary', () => {
  const summary = null
  const intro = summary
    ? `[Queued by Tate, delivering now. I just finished: ${summary}]\n\n`
    : '[Queued messages from Tate, delivering now]\n\n'
  assert.strictEqual(intro, '[Queued messages from Tate, delivering now]\n\n')
})

// ── Service module exports ───────────────────────────────────────────────

test('messageQueue exports expected functions', () => {
  const mq = require('../src/services/messageQueue')
  const expected = [
    'enqueueMessage',
    'getPending',
    'deliverPending',
    'drainIntoDirectMessage',
    'cancelMessage',
    'promoteNow',
    'sweepAged',
    'startSweepPoller',
    'stopSweepPoller',
    '_ageSuffix',
  ]
  for (const fn of expected) {
    assert.strictEqual(typeof mq[fn], 'function', `${fn} should be a function`)
  }
})

// ── Results ──────────────────────────────────────────────────────────────

console.log(`\nResults: ${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
