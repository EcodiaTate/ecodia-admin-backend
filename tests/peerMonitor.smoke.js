'use strict'

/**
 * peerMonitor.smoke.js
 *
 * Smoke test: verify the peerMonitor module loads cleanly and exports
 * runPeerMonitor as a callable function.
 *
 * Does NOT run an actual scan (would burn API budget and require live DB).
 * Safe to run in CI with no environment variables set.
 */

const assert = require('assert')
const path = require('path')

// Load the module - all heavy deps are lazy-required inside runPeerMonitor()
// so this import succeeds without a live DB or ANTHROPIC_API_KEY.
const peerMonitor = require(path.join(__dirname, '../src/services/peerMonitor'))

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

test('module exports runPeerMonitor', () => {
  assert.ok(peerMonitor, 'module should export an object')
  assert.ok('runPeerMonitor' in peerMonitor, 'should export runPeerMonitor')
})

test('runPeerMonitor is a function', () => {
  assert.strictEqual(typeof peerMonitor.runPeerMonitor, 'function')
})

test('runPeerMonitor accepts an options object', () => {
  // Just check the function signature is callable with an options arg.
  // Calling it would require a live DB - this just validates the reference.
  const fn = peerMonitor.runPeerMonitor
  assert.strictEqual(fn.length, 0, 'should use default parameter syntax ({ dryRun = false } = {})')
})

console.log('\nPeer Monitor Smoke Test')
console.log(`  ${passed} passed, ${failed} failed\n`)

if (failed > 0) process.exit(1)
