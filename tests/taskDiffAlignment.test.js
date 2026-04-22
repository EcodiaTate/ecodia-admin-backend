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
test('aligned: bookkeeping routes fix should pass', () => {
  const result = computeTaskDiffAlignment(
    'fix bookkeeping report routes param mismatch in pnl endpoint',
    ['src/routes/bookkeeping/pnl.js']
  )
  assert.strictEqual(result.flagged, false, `Expected flagged=false, got flagged=${result.flagged}`)
  assert(result.overlapScore >= 0.3, `Expected overlapScore >= 0.3, got ${result.overlapScore}`)
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

console.log(`\nResults: ${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
