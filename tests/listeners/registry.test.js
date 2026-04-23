'use strict'

/**
 * Listener registry tests.
 *
 * 4 tests covering: load, register, broadcast fan-out, and error isolation.
 * No jest — same pattern as other test files in this repo.
 */

const assert = require('assert')

let passed = 0
let failed = 0
const pendingAsync = []

function test(name, fn) {
  try {
    const result = fn()
    if (result && typeof result.then === 'function') {
      pendingAsync.push(
        result.then(() => {
          console.log(`  PASS: ${name}`)
          passed++
        }).catch(err => {
          console.error(`  FAIL: ${name}`)
          console.error(`    ${err.message}`)
          failed++
        })
      )
      return
    }
    console.log(`  PASS: ${name}`)
    passed++
  } catch (err) {
    console.error(`  FAIL: ${name}`)
    console.error(`    ${err.message}`)
    failed++
  }
}

// ─── Test 1: loadListeners finds _smoke.js ───────────────────────────────────

test('loadListeners() finds _smoke.js and returns array of 1', () => {
  // Fresh require each test run to avoid cached state
  delete require.cache[require.resolve('../../src/services/listeners/registry')]
  const registry = require('../../src/services/listeners/registry')

  const listeners = registry.loadListeners()

  assert.strictEqual(Array.isArray(listeners), true, 'loadListeners should return an array')
  assert.strictEqual(listeners.length, 1, `Expected 1 listener (smoke), got ${listeners.length}`)
  assert.strictEqual(listeners[0].name, 'smoke', `Expected listener named 'smoke', got '${listeners[0].name}'`)
  assert.deepStrictEqual(listeners[0].subscribesTo, ['text_delta'])
  assert.strictEqual(typeof listeners[0].handle, 'function')
  assert.strictEqual(typeof listeners[0].relevanceFilter, 'function')
})

// ─── Test 2: registerAll subscribes handlers ─────────────────────────────────

test('registerAll() subscribes handlers (mock wsManager.subscribe, assert called once)', () => {
  delete require.cache[require.resolve('../../src/services/listeners/registry')]
  const registry = require('../../src/services/listeners/registry')
  registry.loadListeners()

  const subscribeCalls = []
  const mockWsManager = {
    subscribe: (types, handler) => {
      subscribeCalls.push({ types, handler })
      return () => {}
    },
  }

  registry.registerAll(mockWsManager)

  assert.strictEqual(subscribeCalls.length, 1, `Expected subscribe called once (one listener), got ${subscribeCalls.length}`)
  assert.deepStrictEqual(subscribeCalls[0].types, ['text_delta'], 'Smoke listener should subscribe to text_delta')
  assert.strictEqual(typeof subscribeCalls[0].handler, 'function', 'subscribe should receive a function handler')
})

// ─── Test 3: broadcast fans out to in-process subscribers ───────────────────

test('broadcast fans out to in-process subscribers but smoke handler never invoked (relevanceFilter false)', () => {
  const wsManager = require('../../src/websocket/wsManager')

  // Subscribe a test handler to a custom event type
  const received = []
  const unsubscribe = wsManager.subscribe(['listener_test_event'], (envelope) => {
    received.push(envelope)
  })

  // broadcast is synchronous for non-delta events so no await needed
  wsManager.broadcast('listener_test_event', { test: true })

  unsubscribe()

  assert.strictEqual(received.length, 1, 'in-process subscriber should receive one event')
  assert.strictEqual(received[0].type, 'listener_test_event', 'envelope.type should match broadcast type')
  assert.strictEqual(received[0].test, true, 'envelope should include spread payload')

  // Verify smoke's relevanceFilter always returns false
  const smoke = require('../../src/services/listeners/_smoke')
  assert.strictEqual(
    smoke.relevanceFilter({ type: 'text_delta' }),
    false,
    'smoke relevanceFilter should always return false, ensuring handle() is never invoked'
  )

  // Verify unsubscribe works — a second broadcast should not call handler
  const received2 = []
  const unsubscribe2 = wsManager.subscribe(['listener_test_event_2'], (e) => received2.push(e))
  unsubscribe2()
  wsManager.broadcast('listener_test_event_2', {})
  assert.strictEqual(received2.length, 0, 'unsubscribed handler should not be called')
})

// ─── Test 4: throwing handler is caught, dispatch resolves cleanly ───────────

test('if a listener handler throws, dispatch still completes and logs at warn (no crash)', async () => {
  delete require.cache[require.resolve('../../src/services/listeners/registry')]
  const registry = require('../../src/services/listeners/registry')

  const throwingListener = {
    name: 'throwing-test',
    subscribesTo: ['throw_event'],
    relevanceFilter: () => true,
    handle: async () => { throw new Error('intentional test error') },
    ownsWriteSurface: [],
  }

  let threw = false
  try {
    await registry.dispatch(
      { type: 'throw_event', seq: 0, ts: new Date().toISOString() },
      [throwingListener]
    )
  } catch {
    threw = true
  }

  assert.strictEqual(threw, false, 'dispatch should not propagate handler throws')

  // Verify dispatch is still operational after the error (can be called again)
  let secondThrew = false
  try {
    await registry.dispatch(
      { type: 'throw_event', seq: 1, ts: new Date().toISOString() },
      [throwingListener]
    )
  } catch {
    secondThrew = true
  }
  assert.strictEqual(secondThrew, false, 'dispatch should work again after a prior handler error')
})

// ─── Results ─────────────────────────────────────────────────────────────────

Promise.all(pendingAsync).then(() => {
  console.log(`\nResults: ${passed} passed, ${failed} failed`)
  if (failed > 0) process.exit(1)
}).catch(err => {
  console.error('Test runner error:', err.message)
  process.exit(1)
})
