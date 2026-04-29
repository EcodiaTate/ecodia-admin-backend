'use strict'

/**
 * doctrineSurface unit tests - Jest edition.
 *
 * Covers the keyword-grep helper that surfaces durable doctrine files for a
 * given prompt or message. Tests use a fixture corpus written to a temp dir
 * by the test setup, and patch the module's filesystem reads to redirect the
 * production doctrine paths to the tmp paths so the real corpus is not read.
 *
 * The helper is implemented at src/services/doctrineSurface.js.
 */

const fs = require('fs')
const path = require('path')
const os = require('os')

let tmpRoot
let patternsDir
let clientsDir
let secretsDir

function writeMd(p, triggers, body = 'A short body for the rule.') {
  const content = `triggers: ${triggers}\n\n# Test pattern\n\n${body}\n`
  fs.writeFileSync(p, content, 'utf8')
}

beforeAll(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'doctrine-surface-test-'))
  patternsDir = path.join(tmpRoot, 'patterns')
  clientsDir = path.join(tmpRoot, 'clients')
  secretsDir = path.join(tmpRoot, 'docs', 'secrets')
  fs.mkdirSync(patternsDir, { recursive: true })
  fs.mkdirSync(clientsDir, { recursive: true })
  fs.mkdirSync(secretsDir, { recursive: true })

  writeMd(path.join(patternsDir, 'cowork-conductor-dispatch-protocol.md'),
    'cowork-dispatch, claude-cowork, side-panel, dispatch-protocol',
    'Cowork dispatch verification checklist.')
  writeMd(path.join(patternsDir, 'fork-by-default.md'),
    'fork-default, spawn-fork, conductor-thin, mcp-fork',
    'Fork by default doctrine.')
  writeMd(path.join(patternsDir, 'no-symbolic-logging.md'),
    'symbolic-logging, act-or-schedule, log-without-act',
    'No symbolic logging.')
  writeMd(path.join(patternsDir, 'INDEX.md'),
    'index-keyword',
    'Should be ignored.')
  fs.writeFileSync(
    path.join(patternsDir, 'no-frontmatter.md'),
    '# A pattern without triggers\n\nbody\n',
    'utf8',
  )

  writeMd(path.join(clientsDir, 'ordit.md'),
    'ordit, fireauditors, fire-safety',
    'Ordit client conventions.')

  writeMd(path.join(secretsDir, 'bitbucket.md'),
    'bitbucket, atlassian-api, x-bitbucket-api-token-auth',
    'Bitbucket auth conventions.')
  writeMd(path.join(secretsDir, 'laptop-agent.md'),
    'laptop-agent, corazon, eos-laptop-agent',
    'Corazon agent token.')
})

afterAll(() => {
  try { fs.rmSync(tmpRoot, { recursive: true, force: true }) } catch {}
})

function withCorpus(fn) {
  return () => {
    jest.isolateModules(() => {
      const origReaddir = fs.readdirSync
      const origStat = fs.statSync
      const origOpen = fs.openSync

      const REDIRECT = {
        '/home/tate/ecodiaos/patterns': patternsDir,
        '/home/tate/ecodiaos/clients': clientsDir,
        '/home/tate/ecodiaos/docs/secrets': secretsDir,
      }
      function redirectPath(p) {
        if (typeof p !== 'string') return p
        for (const [from, to] of Object.entries(REDIRECT)) {
          if (p === from || p.startsWith(from + path.sep)) {
            return to + p.slice(from.length)
          }
        }
        return p
      }

      jest.spyOn(fs, 'readdirSync').mockImplementation((p, ...rest) => origReaddir(redirectPath(p), ...rest))
      jest.spyOn(fs, 'statSync').mockImplementation((p, ...rest) => origStat(redirectPath(p), ...rest))
      jest.spyOn(fs, 'openSync').mockImplementation((p, ...rest) => origOpen(redirectPath(p), ...rest))

      const helper = require('../../src/services/doctrineSurface')
      helper._clearCacheForTest()
      try { fn(helper) }
      finally {
        jest.restoreAllMocks()
      }
    })
  }
}

describe('doctrineSurface.surfaceDoctrineForPrompt', () => {
  test('returns null when no triggers match', withCorpus((helper) => {
    const out = helper.surfaceDoctrineForPrompt('A prompt about something completely unrelated to any keyword.')
    expect(out).toBeNull()
  }))

  test('returns null on empty / whitespace / null input', withCorpus((helper) => {
    expect(helper.surfaceDoctrineForPrompt('')).toBeNull()
    expect(helper.surfaceDoctrineForPrompt('   \n  \t  ')).toBeNull()
    expect(helper.surfaceDoctrineForPrompt(null)).toBeNull()
    expect(helper.surfaceDoctrineForPrompt(undefined)).toBeNull()
  }))

  test('surfaces a single hit when one keyword matches', withCorpus((helper) => {
    const out = helper.surfaceDoctrineForPrompt('We need to coordinate via cowork-dispatch on this UI task.')
    expect(out).not.toBeNull()
    expect(out).toContain('cowork-conductor-dispatch-protocol.md')
    expect(out).toContain('matched: cowork-dispatch')
  }))

  test('surfaces credential file when prompt mentions Bitbucket', withCorpus((helper) => {
    const out = helper.surfaceDoctrineForPrompt('Need to push to Bitbucket; verify atlassian-api auth.')
    expect(out).not.toBeNull()
    expect(out).toContain('bitbucket.md')
    expect(out).toMatch(/atlassian-api|bitbucket/)
  }))

  test('caps surfaces and reports suppressed count', withCorpus((helper) => {
    const text = 'cowork-dispatch fork-default symbolic-logging ordit bitbucket corazon'
    const out = helper.surfaceDoctrineForPrompt(text, { maxSurfaces: 2 })
    expect(out).not.toBeNull()
    expect(out).toContain('(4 additional matches suppressed by maxSurfaces=2 cap.)')
    const lineCount = (out.match(/^- /gm) || []).length
    expect(lineCount).toBe(2)
  }))

  test('strips [APPLIED] / [NOT-APPLIED] / [BRIEF-CHECK WARN] tag lines BEFORE scanning', withCorpus((helper) => {
    const text = `[APPLIED] /home/tate/ecodiaos/patterns/foo.md because cowork-dispatch
[NOT-APPLIED] /home/tate/ecodiaos/docs/secrets/bar.md because bitbucket
[BRIEF-CHECK WARN] anti-pattern: ordit
[CONTEXT-SURFACE WARN] keyword fork-default

This is a real prompt about vacation planning.`
    const out = helper.surfaceDoctrineForPrompt(text)
    expect(out).toBeNull()
  }))

  test('frequency-weighted ordering: more keyword matches sort above fewer', withCorpus((helper) => {
    const text = 'bitbucket atlassian-api x-bitbucket-api-token-auth ordit'
    const out = helper.surfaceDoctrineForPrompt(text)
    expect(out).not.toBeNull()
    const idxBitbucket = out.indexOf('bitbucket.md')
    const idxOrdit = out.indexOf('ordit.md')
    expect(idxBitbucket).toBeGreaterThan(-1)
    expect(idxOrdit).toBeGreaterThan(-1)
    expect(idxBitbucket).toBeLessThan(idxOrdit)
  }))

  test('suppresses files whose basename is already referenced in the prompt', withCorpus((helper) => {
    const text = 'See cowork-conductor-dispatch-protocol.md and apply cowork-dispatch.'
    const out = helper.surfaceDoctrineForPrompt(text)
    if (out) {
      expect(out).not.toContain('cowork-conductor-dispatch-protocol.md (matched:')
    } else {
      expect(out).toBeNull()
    }
  }))

  test('OS_DOCTRINE_SURFACE_ENABLED=false short-circuits to null', withCorpus((helper) => {
    const orig = process.env.OS_DOCTRINE_SURFACE_ENABLED
    process.env.OS_DOCTRINE_SURFACE_ENABLED = 'false'
    try {
      const out = helper.surfaceDoctrineForPrompt('cowork-dispatch ordit bitbucket')
      expect(out).toBeNull()
    } finally {
      if (orig === undefined) delete process.env.OS_DOCTRINE_SURFACE_ENABLED
      else process.env.OS_DOCTRINE_SURFACE_ENABLED = orig
    }
  }))

  test('INDEX.md is ignored even when triggers match', withCorpus((helper) => {
    const out = helper.surfaceDoctrineForPrompt('Something about index-keyword.')
    expect(out).toBeNull()
  }))

  test('files without triggers: frontmatter are ignored', withCorpus((helper) => {
    const out = helper.surfaceDoctrineForPrompt('Anything about a pattern without triggers.')
    expect(out).toBeNull()
  }))

  test('trivially-short keywords (<4 chars) do not produce hits', withCorpus((helper) => {
    const shortFile = path.join(patternsDir, 'short-keyword.md')
    writeMd(shortFile, 'a, ab, abc, longerKeyword', 'Test short keyword filter.')
    helper._clearCacheForTest()

    const out = helper.surfaceDoctrineForPrompt('I have a abc to consider.')
    if (out) {
      expect(out).not.toContain('short-keyword.md')
    } else {
      expect(out).toBeNull()
    }

    fs.unlinkSync(shortFile)
  }))
})

describe('doctrineSurface.surfaceDoctrineBlock', () => {
  test('wraps the body in a <doctrine_surface>...</doctrine_surface> block', withCorpus((helper) => {
    const out = helper.surfaceDoctrineBlock('cowork-dispatch in this prompt')
    expect(out).not.toBeNull()
    expect(out.startsWith('<doctrine_surface>\n')).toBe(true)
    expect(out.endsWith('\n</doctrine_surface>')).toBe(true)
  }))

  test('returns null when no surfaces', withCorpus((helper) => {
    const out = helper.surfaceDoctrineBlock('Totally unrelated prompt about kayaking.')
    expect(out).toBeNull()
  }))
})

describe('doctrineSurface.matchedFiles', () => {
  test('returns structured array with file/base/dir/matchedKeywords', withCorpus((helper) => {
    const matches = helper.matchedFiles('cowork-dispatch and ordit work today')
    expect(matches.length).toBeGreaterThanOrEqual(2)
    for (const m of matches) {
      expect(m).toHaveProperty('file')
      expect(m).toHaveProperty('base')
      expect(m).toHaveProperty('dir')
      expect(m).toHaveProperty('matchedKeywords')
      expect(Array.isArray(m.matchedKeywords)).toBe(true)
      expect(m.matchedKeywords.length).toBeGreaterThan(0)
    }
  }))

  test('returns empty array when no matches', withCorpus((helper) => {
    const matches = helper.matchedFiles('unrelated prompt with no keywords')
    expect(matches).toEqual([])
  }))
})

describe('doctrineSurface.stripTagLines', () => {
  test('strips standard tag-line prefixes', withCorpus((helper) => {
    const text = `[APPLIED] foo because bar
real content line
[NOT-APPLIED] baz because qux
another real line
[BRIEF-CHECK WARN] hey
[CONTEXT-SURFACE WARN] hey
[CONTEXT-SURFACE PRIMARY] hey
[CONTEXT-SURFACE ALSO] hey
[CRED-SURFACE WARN] hey
[FORCING WARN] hey
[FORK-NUDGE] hey
final line`
    const cleaned = helper.stripTagLines(text)
    expect(cleaned).not.toContain('[APPLIED]')
    expect(cleaned).not.toContain('[NOT-APPLIED]')
    expect(cleaned).not.toContain('[BRIEF-CHECK')
    expect(cleaned).not.toContain('[CONTEXT-SURFACE')
    expect(cleaned).not.toContain('[CRED-SURFACE')
    expect(cleaned).not.toContain('[FORCING')
    expect(cleaned).not.toContain('[FORK-NUDGE')
    expect(cleaned).toContain('real content line')
    expect(cleaned).toContain('another real line')
    expect(cleaned).toContain('final line')
  }))

  test('preserves leading whitespace on non-tag lines', withCorpus((helper) => {
    const text = '  indented content\n\t\ttabbed content\n[APPLIED] should drop'
    const cleaned = helper.stripTagLines(text)
    expect(cleaned).toContain('  indented content')
    expect(cleaned).toContain('\t\ttabbed content')
  }))

  test('handles empty / non-string input', withCorpus((helper) => {
    expect(helper.stripTagLines('')).toBe('')
    expect(helper.stripTagLines(null)).toBe('')
    expect(helper.stripTagLines(undefined)).toBe('')
  }))
})
