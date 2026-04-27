'use strict'

/**
 * forkService.sendMessageToFork tests - Jest edition.
 *
 * Verifies message injection into a running fork's async-iterable prompt stream:
 *   a. spawnFork delivers the initial brief as the first SDK user message.
 *   b. sendMessageToFork injects a second user message into the running fork.
 *   c. sendMessageToFork('nonexistent', ...) returns { accepted: false, reason: 'not_found' }.
 *   d. sendMessageToFork on a done fork returns { accepted: false, reason: 'fork_terminal' }.
 *
 * Mocking strategy: jest.mock() for all require()d dependencies so the module
 * runs in isolation. The fake query() function accepts the async-iterable prompt
 * and iterates it to collect user messages, which lets us verify injection.
 */

// ---- dependency mocks (must be declared before any require of the module under test) ----

jest.mock('../../src/config/db', () => {
  // Tagged template calls: db(['SQL ', ' more'], val1) - a jest.fn() returning
  // a resolved Promise works for all _dbInsert / _dbUpdate call sites.
  return jest.fn().mockImplementation(() => Promise.resolve([]))
})

jest.mock('../../src/config/env', () => ({
  OS_SESSION_CWD: '/tmp',
  OS_SESSION_MODEL: undefined,
  AWS_ACCESS_KEY_ID: undefined,
  AWS_SECRET_ACCESS_KEY: undefined,
  AWS_REGION: undefined,
  BEDROCK_MODEL: undefined,
  CLAUDE_CODE_OAUTH_TOKEN_CODE: undefined,
  CLAUDE_CONFIG_DIR_2: undefined,
  CLAUDE_CODE_OAUTH_TOKEN_TATE: undefined,
  CLAUDE_CONFIG_DIR_1: undefined,
}))

jest.mock('../../src/config/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  debug: jest.fn(),
  error: jest.fn(),
}))

jest.mock('../../src/services/usageEnergyService', () => ({
  getEnergy: jest.fn().mockResolvedValue({ level: 'healthy' }),
  getBestProvider: jest.fn().mockReturnValue({ provider: 'claude_max', isBedrockFallback: false }),
}))

jest.mock('../../src/websocket/wsManager', () => ({
  broadcast: jest.fn(),
}))

jest.mock('../../src/services/secretSafetyService', () => ({
  scrubSecrets: jest.fn(text => text),
}))

// messageQueue is require()d lazily inside the fork loop only when a [FORK_REPORT]
// exists. Our fake transcripts produce no such marker, so this path is not hit -
// but mock it defensively in case a future change triggers the require.
jest.mock('../../src/services/messageQueue', () => ({
  enqueueMessage: jest.fn().mockResolvedValue(undefined),
}))

// ---- module under test ----

const forkService = require('../../src/services/forkService')

// ---- helpers ----

// Build a fake queryFn that:
//  - accepts { prompt: AsyncIterable<SDKUserMessage>, options }
//  - collects every user message yielded by the prompt into receivedMessages
//  - yields fake SDK messages (init, result) so the fork loop progresses
//  - mode 'single': consumes exactly one message then yields result
//  - mode 'double': consumes two messages (blocks on second until injected)
function makeFakeQuery(receivedMessages, mode = 'single') {
  return function fakeQueryFn({ prompt }) {
    const promptIter = prompt[Symbol.asyncIterator]()

    async function* out() {
      // Consume the initial brief
      const m1 = await promptIter.next()
      if (!m1.done) {
        const text = m1.value?.message?.content?.[0]?.text || ''
        receivedMessages.push(text)
      }

      // Emit system init so the fork records a cc_session_id
      yield { type: 'system', subtype: 'init', session_id: 'fake-sess-test' }

      if (mode === 'double') {
        // Block here until sendMessageToFork pushes a second message.
        // The fork's _makeForkPromptStream generator will yield it.
        const m2 = await promptIter.next()
        if (!m2.done) {
          const text = m2.value?.message?.content?.[0]?.text || ''
          receivedMessages.push(text)
        }
      }

      // Terminal: triggers input_closed + 'reporting' status in the fork loop.
      yield { type: 'result' }
    }

    return out()
  }
}

// Poll the fork map until the fork reaches a terminal status or timeout.
async function waitForForkDone(fork_id, timeoutMs = 3000) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const snap = forkService.getFork(fork_id)
    if (!snap) return  // evicted from map = definitely done
    if (['done', 'aborted', 'error'].includes(snap.status)) return
    await new Promise(r => setTimeout(r, 10))
  }
}

// ---- setup / teardown ----

beforeEach(() => {
  jest.clearAllMocks()
  forkService._resetForTest()
  forkService._setQueryForTest(null)
})

afterEach(() => {
  forkService._setQueryForTest(null)
  forkService._resetForTest()
})

afterAll(async () => {
  // Drain pending setImmediate callbacks (logger's DBErrorTransport constructor
  // schedules a setImmediate to require('./db')). Without draining, Jest tears
  // down the module environment first and emits a ReferenceError. Same pattern
  // as tests/listeners/registry.test.js.
  await new Promise(r => setImmediate(r))
  await new Promise(r => setImmediate(r))
})

// ---- tests ----

describe('forkService.sendMessageToFork', () => {
  test('a. spawnFork delivers initial brief as first SDK user message', async () => {
    const received = []
    forkService._setQueryForTest(makeFakeQuery(received, 'single'))

    const snap = await forkService.spawnFork({ brief: 'do work' })
    await waitForForkDone(snap.fork_id)

    expect(received).toHaveLength(1)
    expect(received[0]).toContain('do work')
  })

  test('b. sendMessageToFork injects a second user message into the running fork', async () => {
    const received = []
    forkService._setQueryForTest(makeFakeQuery(received, 'double'))

    const snap = await forkService.spawnFork({ brief: 'do work' })
    const fork_id = snap.fork_id

    // Yield to the event loop so the background IIFE starts and the fake query
    // consumes the first message before we inject the second.
    await new Promise(r => setImmediate(r))

    // Inject the second message - this resolves the generator's pending promise
    // (or queues it if the generator hasn't awaited yet).
    const result = forkService.sendMessageToFork(fork_id, 'hello fork')
    expect(result.accepted).toBe(true)
    expect(result.fork_id).toBe(fork_id)

    await waitForForkDone(fork_id)

    expect(received).toHaveLength(2)
    expect(received[0]).toContain('do work')
    expect(received[1]).toContain('hello fork')
  })

  test('c. sendMessageToFork on unknown fork_id returns not_found', () => {
    const result = forkService.sendMessageToFork('fork_nonexistent', 'msg')
    expect(result).toEqual({ accepted: false, reason: 'not_found' })
  })

  test('d. sendMessageToFork on a done fork returns fork_terminal', async () => {
    const received = []
    forkService._setQueryForTest(makeFakeQuery(received, 'single'))

    const snap = await forkService.spawnFork({ brief: 'quick task' })
    const fork_id = snap.fork_id

    // Wait for the fork to reach 'done' status.
    await waitForForkDone(fork_id)

    // The 5-minute eviction timer won't fire in Jest (no fake timers), so the
    // fork is still in the map with status 'done'.
    const doneFork = forkService.getFork(fork_id)
    expect(doneFork).not.toBeNull()
    expect(['done', 'aborted', 'error']).toContain(doneFork.status)

    // Any send attempt on a terminal fork must be rejected.
    const result = forkService.sendMessageToFork(fork_id, 'too late')
    expect(result).toEqual({ accepted: false, reason: 'fork_terminal' })
  })
})
