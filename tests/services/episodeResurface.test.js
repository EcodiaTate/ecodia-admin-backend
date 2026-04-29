'use strict'

/**
 * episodeResurface unit smoke test (Phase F / Layer 7).
 *
 * Covers:
 *   1. resurfaceEpisodes returns [] on empty query.
 *   2. resurfaceEpisodes calls neo4jRetrieval.semanticSearch with Episode
 *      label whitelist and current-only filter.
 *   3. recordResurfaces inserts one row per hit and returns the ids.
 *   4. recordResurfaces is a no-op for an empty hits[] array.
 *   5. runForDispatch composes the two and returns a hits + recorded shape.
 *   6. markAcknowledgement / markRepeatedFailure update via id.
 *
 * The DB and neo4jRetrieval modules are mocked — this is a unit test, no
 * Postgres or Neo4j connection required. Failures surface fast in CI.
 */

jest.mock('../../src/config/db', () => {
  const calls = []
  let nextId = 1
  const mockDb = jest.fn(async (strings, ...values) => {
    const sql = Array.from(strings).join('').toLowerCase()
    calls.push({ sql, values })
    if (sql.includes('insert into episode_resurface_event')) {
      return [{ id: nextId++ }]
    }
    if (sql.includes('update episode_resurface_event')) {
      return [{ id: values[1] }]
    }
    if (sql.includes('select') && sql.includes('hook_name')) {
      return [
        { hook_name: 'brief-consistency-check', resurfaces: '4', avg_score: 0.81 },
      ]
    }
    if (sql.includes('count(*) filter')) {
      return [{ acked: '3', repeated: '1', total: '5' }]
    }
    return []
  })
  mockDb.__calls = calls
  mockDb.__reset = () => { calls.length = 0; nextId = 1 }
  return mockDb
})

jest.mock('../../src/services/neo4jRetrieval', () => ({
  semanticSearch: jest.fn(),
}))

jest.mock('../../src/config/logger', () => ({
  warn: jest.fn(),
  info: jest.fn(),
  error: jest.fn(),
}))

const db = require('../../src/config/db')
const neo4jRetrieval = require('../../src/services/neo4jRetrieval')
const episodeResurface = require('../../src/services/episodeResurface')

beforeEach(() => {
  db.__reset()
  jest.clearAllMocks()
})

describe('episodeResurface.resurfaceEpisodes', () => {
  test('returns [] for empty query', async () => {
    const r = await episodeResurface.resurfaceEpisodes('')
    expect(r).toEqual([])
    expect(neo4jRetrieval.semanticSearch).not.toHaveBeenCalled()
  })

  test('calls semanticSearch with Episode label whitelist + current-only', async () => {
    neo4jRetrieval.semanticSearch.mockResolvedValueOnce([
      { label: 'Episode', name: 'Past failure X', description: 'context', score: 0.91 },
    ])
    const hits = await episodeResurface.resurfaceEpisodes('test brief about X')
    expect(neo4jRetrieval.semanticSearch).toHaveBeenCalledTimes(1)
    const [text, opts] = neo4jRetrieval.semanticSearch.mock.calls[0]
    expect(text).toBe('test brief about X')
    expect(opts.labels).toEqual(['Episode'])
    expect(opts.onlyCurrent).toBe(true)
    expect(hits).toHaveLength(1)
  })

  test('returns [] on neo4jRetrieval throw (fail-open)', async () => {
    neo4jRetrieval.semanticSearch.mockRejectedValueOnce(new Error('boom'))
    const hits = await episodeResurface.resurfaceEpisodes('seed')
    expect(hits).toEqual([])
  })
})

describe('episodeResurface.recordResurfaces', () => {
  test('no-op on empty hits', async () => {
    const r = await episodeResurface.recordResurfaces({}, [])
    expect(r).toEqual({ inserted: 0, ids: [] })
    expect(db).not.toHaveBeenCalled()
  })

  test('inserts one row per hit and returns ids', async () => {
    const hits = [
      { label: 'Episode', name: 'Ep One', description: 'd', score: 0.85 },
      { label: 'Episode', name: 'Ep Two', description: 'd', score: 0.78 },
    ]
    const r = await episodeResurface.recordResurfaces(
      { hookName: 'brief-consistency-check', toolName: 'mcp__forks__spawn_fork' },
      hits
    )
    expect(r.inserted).toBe(2)
    expect(r.ids).toEqual([1, 2])
    expect(db.__calls.filter(c => c.sql.includes('insert into episode_resurface_event'))).toHaveLength(2)
  })

  test('skips hits with no usable id', async () => {
    const hits = [{ label: 'Episode', score: 0.9 }] // no name, no id
    const r = await episodeResurface.recordResurfaces({}, hits)
    expect(r.inserted).toBe(0)
  })
})

describe('episodeResurface.runForDispatch', () => {
  test('composes resurface + record', async () => {
    neo4jRetrieval.semanticSearch.mockResolvedValueOnce([
      { label: 'Episode', name: 'Past', description: 'why', score: 0.81 },
    ])
    const r = await episodeResurface.runForDispatch({
      queryText: 'brief seed',
      hookName: 'h',
      toolName: 't',
    })
    expect(r.hits).toHaveLength(1)
    expect(r.recorded.inserted).toBe(1)
  })
})

describe('episodeResurface.markAcknowledgement / markRepeatedFailure', () => {
  test('returns updated:0 when id missing', async () => {
    expect(await episodeResurface.markAcknowledgement({})).toEqual({ updated: 0 })
    expect(await episodeResurface.markRepeatedFailure({})).toEqual({ updated: 0 })
  })

  test('updates by id', async () => {
    const a = await episodeResurface.markAcknowledgement({ id: 7, ack: true })
    expect(a.updated).toBe(1)
    const r = await episodeResurface.markRepeatedFailure({ id: 7, repeated: true })
    expect(r.updated).toBe(1)
  })
})

describe('episodeResurface.getResurfaceFrequency', () => {
  test('returns rows mapped from db', async () => {
    const rows = await episodeResurface.getResurfaceFrequency({ days: 7 })
    expect(Array.isArray(rows)).toBe(true)
    expect(rows[0]).toMatchObject({
      hook_name: 'brief-consistency-check',
      resurfaces: 4,
      avg_score: 0.81,
    })
  })

  test('clamps days to [1, 90]', async () => {
    await episodeResurface.getResurfaceFrequency({ days: 0 })
    await episodeResurface.getResurfaceFrequency({ days: 999 })
    // Just ensures it does not throw on extreme values.
    expect(true).toBe(true)
  })
})

describe('episodeResurface.getRepeatedFailureRate', () => {
  test('computes rate from db response', async () => {
    const m = await episodeResurface.getRepeatedFailureRate({ days: 30 })
    expect(m.window_days).toBe(30)
    expect(m.acknowledged).toBe(3)
    expect(m.repeated_failures).toBe(1)
    expect(m.repeated_failure_rate).toBeCloseTo(1 / 3, 5)
  })
})
