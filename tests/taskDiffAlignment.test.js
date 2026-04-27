'use strict'

const assert = require('assert')
const { computeTaskDiffAlignment } = require('../src/services/taskDiffAlignment')

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

// Test 1: 9dbf39ce regression - bookkeeping task but patterns-only diff
test('regression: bookkeeping task with patterns-only diff should flag mismatch', () => {
  const result = computeTaskDiffAlignment(
    'Fix param-name mismatch in bookkeeping report routes. The endpoints throw UNDEFINED_VALUE because Express routes read different query param names than the MCP client sends.',
    ['patterns/foo.md', 'patterns/bar.md']
  )
  assert.strictEqual(result.flagged, true, `Expected flagged=true, got flagged=${result.flagged}`)
  assert(result.overlapScore < 0.15, `Expected overlapScore < 0.15, got ${result.overlapScore}`)
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
  assert.strictEqual(result.flagged, false, `Expected flagged=false, got flagged=${result.flagged}`)
  assert(result.overlapScore >= 0.2, `Expected overlapScore >= 0.2, got ${result.overlapScore}`)
})

// Test 3: Empty diff should flag
test('empty diff: should flag with empty files_changed', () => {
  const result = computeTaskDiffAlignment(
    'add migration for widgets table with created_at and updated_at columns',
    []
  )
  assert.strictEqual(result.flagged, true, `Expected flagged=true, got flagged=${result.flagged}`)
  assert(result.reason.toLowerCase().includes('empty'), `Expected reason to mention 'empty', got: ${result.reason}`)
})

// Test 4: Generic task with too few keywords should not flag (unfair to score)
test('generic task: "fix bug" with few keywords should not flag', () => {
  const result = computeTaskDiffAlignment(
    'fix bug',
    ['src/foo.js']
  )
  assert.strictEqual(result.flagged, false, `Expected flagged=false, got flagged=${result.flagged}`)
  assert.strictEqual(result.overlapScore, null, `Expected overlapScore=null for generic task, got ${result.overlapScore}`)
})

// Test 5: Bug 1 regression - 3-char acronym preservation
// Before the fix, 'iap' was stripped from keywords (regex required min 4 chars)
// but kept in path tokens (length >= 3). Post-fix both sides capture it, giving a real overlap.
test('acronym: iap in task should match iap.js in diff (flagged=false)', () => {
  const result = computeTaskDiffAlignment(
    'fix iap blocker for roam app subscription',
    ['src/services/iap.js']
  )
  assert.strictEqual(result.flagged, false, `Expected flagged=false, got flagged=${result.flagged} (overlapScore=${result.overlapScore}, keywords=${result.statedKeywords}, pathTokens=${result.diffPathTokens})`)
  assert(result.statedKeywords.includes('iap'), `Expected 'iap' in statedKeywords, got: ${result.statedKeywords}`)
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
  assert.strictEqual(result.flagged, true, `Expected flagged=true (no real overlap), got flagged=${result.flagged} (overlapScore=${result.overlapScore}, keywords=${result.statedKeywords}, pathTokens=${result.diffPathTokens})`)
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
  assert.strictEqual(result.flagged, false, `Expected flagged=false, got flagged=${result.flagged} (overlapScore=${result.overlapScore}, keywords=${result.statedKeywords}, pathTokens=${result.diffPathTokens})`)
  assert(result.statedKeywords.includes('service'), `Expected 'service' in statedKeywords (should no longer be a stopword), got: ${result.statedKeywords}`)
  assert(result.overlapScore >= 0.3, `Expected overlapScore >= 0.3, got ${result.overlapScore}`)
})

console.log(`\nResults: ${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
