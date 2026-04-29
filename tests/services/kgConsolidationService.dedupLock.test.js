'use strict'

/**
 * Regression test for `deduplicateNodes` lock leak.
 *
 * Background:
 *   `deduplicateNodes` acquires a Neo4j-backed advisory lock
 *   (`__ConsolidationLock__{phase:'dedup'}`) before merging nodes, and releases
 *   it at the end. Before the 2026-04-30 fix, the release ran only on the
 *   success path — any exception escaping the body left the lock node behind
 *   for its 5-minute TTL, blocking subsequent dedup cycles.
 *
 * Invariant under test:
 *   When ANY exception escapes the critical section, the release lock query
 *   MUST still execute (try/finally semantics).
 *
 * How we exercise the leak path:
 *   - The first `runQuery` call (the DedupRun breadcrumb) is wrapped in
 *     try/catch in production code — that's safe.
 *   - The second `runQuery` call (`labelCounts`) is followed by
 *     `.catch(() => [])`. A SYNC throw from `runQuery(...)` bypasses `.catch`
 *     because the catch handler is attached AFTER the function call resolves
 *     to a thenable. Throwing sync therefore propagates out of the
 *     critical section, exercising the leak path that try/finally guards.
 */

// Mock neo4j config BEFORE requiring the service
const writeCalls = []
const queryCalls = []

jest.mock('../../src/config/neo4j', () => {
  return {
    runWrite: jest.fn(async (cypher, params) => {
      writeCalls.push({ cypher, params })
      // First call is the lock-acquire MERGE; return acquired=true.
      if (writeCalls.length === 1 && cypher.includes('MERGE (lock:__ConsolidationLock__')) {
        return [{ get: (k) => (k === 'acquired' ? true : null) }]
      }
      // Subsequent writes (release DELETE, merge writes) return empty result.
      return []
    }),
    runQuery: jest.fn((cypher) => {
      queryCalls.push(cypher)
      // First runQuery is the DedupRun breadcrumb — production wraps it in
      // try/catch, so this throw is swallowed.
      if (queryCalls.length === 1) {
        throw new Error('breadcrumb fail (expected to be swallowed)')
      }
      // Second runQuery is the labelCounts query; throwing sync here
      // bypasses the production `.catch(() => [])` and escapes the body.
      throw new Error('labelCounts fail — propagates to function caller')
    }),
  }
})

// Stub logger to keep the suite output clean.
jest.mock('../../src/config/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
}))

// Stub env to avoid pulling real config.
jest.mock('../../src/config/env', () => ({
  KG_DEDUP_SIMILARITY_THRESHOLD: '0.90',
  NEO4J_URI: 'bolt://localhost:7687',
}))

const { runWrite } = require('../../src/config/neo4j')
const { deduplicateNodes } = require('../../src/services/kgConsolidationService')

describe('deduplicateNodes — dedup lock try/finally invariant', () => {
  beforeEach(() => {
    writeCalls.length = 0
    queryCalls.length = 0
    runWrite.mockClear()
  })

  test('release lock MUST run even when the critical section throws', async () => {
    let caughtError = null
    try {
      await deduplicateNodes({ dryRun: false })
    } catch (err) {
      caughtError = err
    }

    // The labelCounts sync-throw escapes the function body.
    expect(caughtError).toBeInstanceOf(Error)
    expect(caughtError.message).toMatch(/labelCounts fail/)

    // Lock acquire happened first.
    expect(writeCalls.length).toBeGreaterThanOrEqual(2)
    expect(writeCalls[0].cypher).toMatch(/MERGE \(lock:__ConsolidationLock__/)

    // The critical regression check: a release-lock query MUST appear in
    // runWrite calls AFTER the acquire — the finally block fires on throw.
    const releaseCalls = writeCalls.filter(c =>
      c.cypher.includes('MATCH (lock:__ConsolidationLock__') &&
      c.cypher.includes('DELETE lock')
    )
    expect(releaseCalls.length).toBe(1)
    expect(releaseCalls[0].params).toEqual({ phase: 'dedup' })
  })

  test('dryRun path does NOT acquire or release the lock', async () => {
    // Re-mock runQuery to a no-throw success path so the dryRun call returns clean.
    const neo4j = require('../../src/config/neo4j')
    neo4j.runQuery.mockImplementation(async () => [])

    await deduplicateNodes({ dryRun: true })

    // No runWrite calls at all on the dryRun branch — neither acquire nor release.
    expect(writeCalls.length).toBe(0)
  })
})
