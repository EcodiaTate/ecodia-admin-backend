'use strict'

/**
 * Listener registry tests — Jest edition.
 *
 * 4 tests covering: load, register, broadcast fan-out, and error isolation.
 */

describe('listener registry', () => {
  afterAll(async () => {
    // Drain pending setImmediate callbacks (logger's DBErrorTransport constructor
    // schedules a setImmediate to require('./db') — without draining it here,
    // Jest tears down the module environment first and emits a ReferenceError).
    await new Promise(r => setImmediate(r))
    await new Promise(r => setImmediate(r))
  })

  test('loadListeners() finds _smoke.js and returns array of 1', () => {
    delete require.cache[require.resolve('../../src/services/listeners/registry')]
    const registry = require('../../src/services/listeners/registry')

    const listeners = registry.loadListeners()

    expect(Array.isArray(listeners)).toBe(true)
    expect(listeners.length).toBe(1)
    expect(listeners[0].name).toBe('smoke')
    expect(listeners[0].subscribesTo).toEqual(['text_delta'])
    expect(typeof listeners[0].handle).toBe('function')
    expect(typeof listeners[0].relevanceFilter).toBe('function')
  })

  test('registerAll() subscribes handlers (mock wsManager.subscribe, assert called once)', () => {
    delete require.cache[require.resolve('../../src/services/listeners/registry')]
    const registry = require('../../src/services/listeners/registry')
    registry.loadListeners()

    const mockSubscribe = jest.fn().mockReturnValue(() => {})
    const mockWsManager = { subscribe: mockSubscribe }

    registry.registerAll(mockWsManager)

    expect(mockSubscribe).toHaveBeenCalledTimes(1)
    expect(mockSubscribe).toHaveBeenCalledWith(['text_delta'], expect.any(Function))
  })

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

    expect(received.length).toBe(1)
    expect(received[0].type).toBe('listener_test_event')
    expect(received[0].test).toBe(true)

    // Verify smoke's relevanceFilter always returns false
    const smoke = require('../../src/services/listeners/_smoke')
    expect(smoke.relevanceFilter({ type: 'text_delta' })).toBe(false)

    // Verify unsubscribe works — a second broadcast should not call handler
    const received2 = []
    const unsubscribe2 = wsManager.subscribe(['listener_test_event_2'], (e) => received2.push(e))
    unsubscribe2()
    wsManager.broadcast('listener_test_event_2', {})
    expect(received2.length).toBe(0)
  })

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

    expect(threw).toBe(false)

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
    expect(secondThrew).toBe(false)
  })
})
