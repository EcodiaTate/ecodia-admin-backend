'use strict'
/**
 * Unit tests for src/services/appStoreConnect.js
 *
 * Covers:
 *   - getToken() returns a non-empty JWT and caches within 18 minutes
 *   - getToken() regenerates after 20 minutes (iat advances)
 *   - request() attaches Authorization: Bearer header
 *   - waitForBuildProcessing() resolves on VALID, throws on FAILED, respects timeout
 */

// ─── Dependency mocks ─────────────────────────────────────────────────────────

jest.mock('../src/config/db', () => {
  const crypto = require('crypto')
  const { privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' })
  const private_key = privateKey.export({ type: 'pkcs8', format: 'pem' })
  const creds = {
    issuer_id: 'test-issuer-00000000-0000-0000-0000-000000000000',
    key_id: 'TESTKEY1234',
    private_key,
  }
  return jest.fn().mockImplementation(() => Promise.resolve([{ value: creds }]))
})

jest.mock('../src/config/logger', () => ({
  debug: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}))

// ─── Module under test ────────────────────────────────────────────────────────

const asc = require('../src/services/appStoreConnect')

// ─── Axios patch helper ──────────────────────────────────────────────────────

function patchAxios(stub) {
  const key = require.resolve('axios')
  // appStoreConnect lazy-requires axios inside each call, so the cache
  // entry may not exist yet at test setup time — require it first.
  const original = require(key)
  require.cache[key].exports = stub
  return () => { require.cache[key].exports = original }
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('appStoreConnect', () => {
  test('getToken() returns a non-empty string', async () => {
    const token = await asc.getToken()
    expect(typeof token === 'string' && token.length > 0).toBeTruthy()
  })

  test('getToken() returns a three-part JWT', async () => {
    const token = await asc.getToken()
    expect(token.split('.').length).toBe(3)
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

    expect(t1).toBe(t2)
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
    expect(p2.iat).toBeGreaterThan(p1.iat)
  })

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
    expect(capturedHeaders).toBeTruthy()
    expect(capturedHeaders.Authorization && capturedHeaders.Authorization.startsWith('Bearer ')).toBeTruthy()
  })

  test('request() propagates non-2xx response as error with .status property', async () => {
    const restore = patchAxios(async () => {
      const err = new Error('Request failed with status code 401')
      err.response = { status: 401, data: { errors: [{ title: 'Unauthorized' }] } }
      throw err
    })
    try {
      await expect(asc.request('GET', '/apps')).rejects.toMatchObject({ status: 401 })
    } finally {
      restore()
    }
  })

  test('waitForBuildProcessing() resolves when state is VALID', async () => {
    const restore = patchAxios(async () => ({
      data: { data: { id: 'b-valid', attributes: { processingState: 'VALID' } } },
    }))
    try {
      const result = await asc.waitForBuildProcessing('b-valid', { timeoutMs: 5000, pollMs: 50 })
      expect(result.attributes.processingState).toBe('VALID')
    } finally {
      restore()
    }
  })

  test('waitForBuildProcessing() throws when state is FAILED', async () => {
    const restore = patchAxios(async () => ({
      data: { data: { id: 'b-failed', attributes: { processingState: 'FAILED' } } },
    }))
    try {
      await expect(
        asc.waitForBuildProcessing('b-failed', { timeoutMs: 5000, pollMs: 50 })
      ).rejects.toThrow('FAILED')
    } finally {
      restore()
    }
  })

  test('waitForBuildProcessing() throws on timeout while state stays PROCESSING', async () => {
    const restore = patchAxios(async () => ({
      data: { data: { id: 'b-stuck', attributes: { processingState: 'PROCESSING' } } },
    }))
    try {
      await expect(
        asc.waitForBuildProcessing('b-stuck', { timeoutMs: 200, pollMs: 50 })
      ).rejects.toThrow('Timed out')
    } finally {
      restore()
    }
  })
})
