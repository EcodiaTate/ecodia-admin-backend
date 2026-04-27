'use strict'

const { computeTaskDiffAlignment } = require('../src/services/taskDiffAlignment')

describe('taskDiffAlignment', () => {
  // Test 1: 9dbf39ce regression - bookkeeping task but patterns-only diff
  test('regression: bookkeeping task with patterns-only diff should flag mismatch', () => {
    const result = computeTaskDiffAlignment(
      'Fix param-name mismatch in bookkeeping report routes. The endpoints throw UNDEFINED_VALUE because Express routes read different query param names than the MCP client sends.',
      ['patterns/foo.md', 'patterns/bar.md']
    )
    expect(result.flagged).toBe(true)
    expect(result.overlapScore).toBeLessThan(0.15)
  })

  // Test 2: Aligned case - bookkeeping fix with bookkeeping route diff
  // NOTE: threshold lowered from >= 0.3 to >= 0.2 after Bug 2 (one-directional match) +
  // Bug 1 (3-char min) fixes. Under stricter matching the score is lower but still well
  // above the 0.15 flag threshold, so flagged=false still holds correctly.
  test('aligned: bookkeeping routes fix should pass', () => {
    const result = computeTaskDiffAlignment(
      'fix bookkeeping report routes param mismatch in pnl endpoint',
      ['src/routes/bookkeeping/pnl.js']
    )
    expect(result.flagged).toBe(false)
    expect(result.overlapScore).toBeGreaterThanOrEqual(0.2)
  })

  // Test 3: Empty diff should flag
  test('empty diff: should flag with empty files_changed', () => {
    const result = computeTaskDiffAlignment(
      'add migration for widgets table with created_at and updated_at columns',
      []
    )
    expect(result.flagged).toBe(true)
    expect(result.reason.toLowerCase()).toContain('empty')
  })

  // Test 4: Generic task with too few keywords should not flag (unfair to score)
  test('generic task: "fix bug" with few keywords should not flag', () => {
    const result = computeTaskDiffAlignment(
      'fix bug',
      ['src/foo.js']
    )
    expect(result.flagged).toBe(false)
    expect(result.overlapScore).toBeNull()
  })

  // Test 5: Bug 1 regression - 3-char acronym preservation
  // Before the fix, 'iap' was stripped from keywords (regex required min 4 chars)
  // but kept in path tokens (length >= 3). Post-fix both sides capture it, giving a real overlap.
  test('acronym: iap in task should match iap.js in diff (flagged=false)', () => {
    const result = computeTaskDiffAlignment(
      'fix iap blocker for roam app subscription',
      ['src/services/iap.js']
    )
    expect(result.flagged).toBe(false)
    expect(result.statedKeywords).toContain('iap')
  })

  // Test 6: Bug 2 regression - bidirectional substring match
  // Before the fix, kw.includes(t) let short path tokens match any keyword containing them.
  // e.g. path token 'set' (from 'dataset') would match keyword 'settings' via settings.includes('set').
  // Post-fix: one-directional only. 'settings' task vs 'dataset.js' diff should flag mismatch.
  test('bidirectional-includes regression: settings task should not match dataset.js diff', () => {
    const result = computeTaskDiffAlignment(
      'fix the settings panel rendering bug for client onboarding',
      ['src/services/dataset.js']
    )
    expect(result.flagged).toBe(true)
  })

  // Test 7: Bug 3 regression - domain words removed from stopwords
  // 'service' and 'pattern' were in STOPWORDS, silently dropping them from keywords.
  // Post-fix: 'service' matches 'services' in path tokens; 'bookkeeper' matches 'bookkeeperservice'.
  // Expected overlap: bookkeeper (hits bookkeeperservice) + service (hits services) = 2/5 = 0.4
  test('stopword domain words: service and pattern kept as keywords, bookkeeper service matches', () => {
    const result = computeTaskDiffAlignment(
      'refactor bookkeeper service to use new pattern for posting',
      ['src/services/bookkeeperService.js']
    )
    expect(result.flagged).toBe(false)
    expect(result.statedKeywords).toContain('service')
    expect(result.overlapScore).toBeGreaterThanOrEqual(0.3)
  })
})
