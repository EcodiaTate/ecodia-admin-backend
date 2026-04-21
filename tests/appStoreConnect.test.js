'use strict'
/**
 * Unit tests for src/services/appStoreConnect.js
 *
 * Covers:
 *   - getToken() returns a non-empty JWT and caches within 18 minutes
 *   - getToken() regenerates after 20 minutes (iat advances)
 *   - request() attaches Authorization: Bearer header
 *   - waitForBuildProcessing() resolves on VALID, throws on FAILED, respects timeout
 *
 * Run with: node tests/appStoreConnect.test.js
 */

const assert = require('assert')
const crypto = require('crypto')
const Module = require('module')

// ─── Test harness ─────────────────────────────────────────────────────────────

const _tests = []

function test(name, fn) {
  _tests.push({ name, fn })
}

async function runAll() {
  let passed = 0
  let failed = 0
  for (const { name, fn } of _tests) {
    try {
      await fn()
      console.log(`  \u2713 ${name}`)
      passed++
    } catch (err) {
      console.error(`  \u2717 ${name}`)
      console.error(`    ${err.message}`)
      failed++
    }
  }
  console.log(`\n${passed} passing, ${failed} failing\n`)
  if (failed > 0) process.exit(1)
}

// ─── Dependency stubs ─────────────────────────────────────────────────────────

// Generate a real P-256 key pair so jwt.sign() does not throw
const { privateKey: _testPrivateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' })
const FAKE_PRIVATE_KEY_PEM = _testPrivateKey.export({ type: 'pkcs8', format: 'pem' })

const FAKE_CREDS = {
  issuer_id: 'test-issuer-00000000-0000-0000-0000-000000000000',
  key_id: 'TESTKEY1234',
  private_key: FAKE_PRIVATE_KEY_PEM,
}

// Mock db: always returns fake creds
const mockDb = function () { return Promise.resolve([{ value: FAKE_CREDS }]) }
const mockLogger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }

const originalLoad = Module._load
Module._load = function (request, parent, isMain) {
  const base = request.split('/').pop()
  if (base === 'db' && request.includes('config')) return mockDb
  if (base === 'logger' && request.includes('config')) return mockLogger
  return originalLoad.apply(this, arguments)
}

// Load the module under test with stubs active so the startup creds-check hits mock
const asc = require('../src/services/appStoreConnect')

// Restore original loader
Module._load = originalLoad

// ─── Axios patch helpers ──────────────────────────────────────────────────────

function patchAxios(stub) {
  const key = require.resolve('axios')
  // Ensure axios is in the require cache before we try to patch it.
  // (appStoreConnect lazy-requires axios inside each call, so the cache
  // entry may not exist yet at test setup time.)
  const original = require(key)
  require.cache[key].exports = stub
  return () => { require.cache[key].exports = original }
}

// ─── Tests ────────────────────────────────────────────────────────────────────

console.log('\nappStoreConnect\n')

// ── getToken() ──

test('getToken() returns a non-empty string', async () => {
  const token = await asc.getToken()
  assert.ok(typeof token === 'string' && token.length > 0, 'token must be a non-empty string')
})

test('getToken() returns a three-part JWT', async () => {
  const token = await asc.getToken()
  assert.strictEqual(token.split('.').length, 3, 'JWT must have three dot-separated parts')
})

test('getToken() caches: same token returned within 15 minutes of generation', async () => {
  const realNow = Date.now
  let fakeNow = realNow()
  Date.now = () => fakeNow

  const t1 = await asc.getToken()

  // Advance 15 minutes - well inside the 20-min TTL minus 2-min refresh buffer
  fakeNow += 15 * 60 * 1000
  const t2 = await asc.getToken()

  Date.now = realNow

  assert.strictEqual(t1, t2, 'cached token must be returned within 15 minutes')
})

test('getToken() regenerates after >18 minutes: new token has larger iat', async () => {
  const realNow = Date.now
  let fakeNow = realNow()

  // Force a fresh generation baseline by advancing past any previous cached token
  fakeNow += 30 * 60 * 1000
  Date.now = () => fakeNow

  const t1 = await asc.getToken()

  // Advance 20 more minutes - must cross the 2-min threshold
  fakeNow += 20 * 60 * 1000
  const t2 = await asc.getToken()

  Date.now = realNow

  const decodePayload = (token) => {
    const raw = token.split('.')[1]
    // base64url -> base64 by replacing chars and adding padding
    const b64 = raw.replace(/-/g, '+').replace(/_/g, '/').padEnd(
      raw.length + (4 - (raw.length % 4)) % 4, '='
    )
    return JSON.parse(Buffer.from(b64, 'base64').toString('utf-8'))
  }

  const p1 = decodePayload(t1)
  const p2 = decodePayload(t2)
  assert.ok(
    p2.iat > p1.iat,
    `regenerated token iat (${p2.iat}) must exceed original (${p1.iat})`
  )
})

// ── request() ──

test('request() attaches Authorization: Bearer header', async () => {
  let capturedHeaders = null
  const restore = patchAxios(async (config) => {
    capturedHeaders = config.headers
    return { data: { data: [] } }
  })
  try {
    await asc.request('GET', '/apps?filter[bundleId]=test.bundle')
  } finally {
    restore()
  }
  assert.ok(capturedHeaders, 'axios must have been called')
  assert.ok(
    capturedHeaders.Authorization && capturedHeaders.Authorization.startsWith('Bearer '),
    `Authorization must start with "Bearer ", got: ${capturedHeaders.Authorization}`
  )
})

test('request() propagates non-2xx response as error with .status property', async () => {
  const restore = patchAxios(async () => {
    const err = new Error('Request failed with status code 401')
    err.response = { status: 401, data: { errors: [{ title: 'Unauthorized' }] } }
    throw err
  })
  try {
    await assert.rejects(
      () => asc.request('GET', '/apps'),
      (err) => {
        assert.strictEqual(err.status, 401)
        return true
      }
    )
  } finally {
    restore()
  }
})

// ── waitForBuildProcessing() ──

test('waitForBuildProcessing() resolves when state is VALID', async () => {
  const restore = patchAxios(async () => ({
    data: { data: { id: 'b-valid', attributes: { processingState: 'VALID' } } },
  }))
  try {
    const result = await asc.waitForBuildProcessing('b-valid', { timeoutMs: 5000, pollMs: 50 })
    assert.strictEqual(result.attributes.processingState, 'VALID')
  } finally {
    restore()
  }
})

test('waitForBuildProcessing() throws when state is FAILED', async () => {
  const restore = patchAxios(async () => ({
    data: { data: { id: 'b-failed', attributes: { processingState: 'FAILED' } } },
  }))
  try {
    await assert.rejects(
      () => asc.waitForBuildProcessing('b-failed', { timeoutMs: 5000, pollMs: 50 }),
      (err) => {
        assert.ok(err.message.includes('FAILED'), `error must mention FAILED: ${err.message}`)
        return true
      }
    )
  } finally {
    restore()
  }
})

test('waitForBuildProcessing() throws on timeout while state stays PROCESSING', async () => {
  const restore = patchAxios(async () => ({
    data: { data: { id: 'b-stuck', attributes: { processingState: 'PROCESSING' } } },
  }))
  try {
    await assert.rejects(
      () => asc.waitForBuildProcessing('b-stuck', { timeoutMs: 200, pollMs: 50 }),
      (err) => {
        assert.ok(err.message.includes('Timed out'), `error must mention timeout: ${err.message}`)
        return true
      }
    )
  } finally {
    restore()
  }
})

// ─── Run ──────────────────────────────────────────────────────────────────────

runAll().catch((err) => {
  console.error('Test runner error:', err.message)
  process.exit(1)
})
