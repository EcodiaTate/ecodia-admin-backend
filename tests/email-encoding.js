'use strict'
/**
 * Unit tests for RFC 2047 email header encoding.
 *
 * Verifies that encodeHeaderValue() produces ASCII-safe encoded-word output
 * for non-ASCII subjects (em-dashes, smart quotes, accented chars, emoji).
 *
 * Run with: node tests/email-encoding.js
 */

const assert = require('assert')

// ─── Replicate the encoding logic (must stay in sync with both:
//     - src/services/gmailService.js:encodeHeaderValue
//     - mcp-servers/google-workspace/gmail.js:encodeHeaderValue
// ─────────────────────────────────────────────────────────────────────────────

function encodeHeaderValue(str) {
  if (!str || !/[^\x00-\x7F]/.test(str)) return str
  return `=?UTF-8?B?${Buffer.from(str, 'utf-8').toString('base64')}?=`
}

// ─── Test harness ─────────────────────────────────────────────────────────────

let passed = 0
let failed = 0

function test(name, fn) {
  try {
    fn()
    console.log(`  \u2713 ${name}`)
    passed++
  } catch (err) {
    console.error(`  \u2717 ${name}`)
    console.error(`    ${err.message}`)
    failed++
  }
}

// ─── Tests ────────────────────────────────────────────────────────────────────

console.log('\nemail-encoding\n')

test('pure ASCII subject is returned unchanged', () => {
  assert.strictEqual(encodeHeaderValue('Hello World'), 'Hello World')
})

test('empty string returned unchanged', () => {
  assert.strictEqual(encodeHeaderValue(''), '')
})

test('null/undefined returned as-is', () => {
  assert.strictEqual(encodeHeaderValue(null), null)
  assert.strictEqual(encodeHeaderValue(undefined), undefined)
})

test('em-dash subject is RFC 2047 base64 encoded', () => {
  const result = encodeHeaderValue('Agreement \u2014 Ecodia')
  assert.match(result, /^=\?UTF-8\?B\?[A-Za-z0-9+/=]+\?=$/, 'Must be RFC 2047 encoded-word')
})

test('em-dash encoded result is ASCII-only', () => {
  const result = encodeHeaderValue('Agreement \u2014 Ecodia')
  assert.ok(!/[^\x00-\x7F]/.test(result), 'Encoded value must be ASCII-only')
})

test('em-dash subject roundtrips losslessly', () => {
  const original = 'Referral & Development Agreement \u2014 Ecodia + Resonaverde'
  const encoded = encodeHeaderValue(original)
  const match = encoded.match(/=\?UTF-8\?B\?([A-Za-z0-9+/=]+)\?=/)
  assert.ok(match, 'Must match RFC 2047 pattern')
  const decoded = Buffer.from(match[1], 'base64').toString('utf-8')
  assert.strictEqual(decoded, original, 'Roundtrip must be lossless')
})

test('smart quotes are RFC 2047 encoded', () => {
  const result = encodeHeaderValue('He said \u201cHello\u201d')
  assert.match(result, /^=\?UTF-8\?B\?/)
  assert.ok(!/[^\x00-\x7F]/.test(result))
})

test('accented characters are RFC 2047 encoded', () => {
  const result = encodeHeaderValue('Caf\u00e9 au lait')
  assert.match(result, /^=\?UTF-8\?B\?/)
  assert.ok(!/[^\x00-\x7F]/.test(result))
})

test('emoji subject is RFC 2047 encoded', () => {
  const result = encodeHeaderValue('Launch \uD83D\uDE80')
  assert.match(result, /^=\?UTF-8\?B\?/)
  assert.ok(!/[^\x00-\x7F]/.test(result))
})

test('right single quotation mark is RFC 2047 encoded', () => {
  const result = encodeHeaderValue("It\u2019s done")
  assert.match(result, /^=\?UTF-8\?B\?/)
  assert.ok(!/[^\x00-\x7F]/.test(result))
})

// ─── Summary ──────────────────────────────────────────────────────────────────

console.log(`\n${passed} passing, ${failed} failing\n`)
if (failed > 0) process.exit(1)
