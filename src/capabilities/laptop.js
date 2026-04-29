const registry = require('../services/capabilityRegistry')
const handsBridge = require('../services/handsBridge')
const logger = require('../config/logger')

// ═══════════════════════════════════════════════════════════════════════
// LAPTOP CAPABILITIES — let the cortex agent dispatch agentic work to the
// user's laptop via the hands service.
//
// Mental model: same shape as `start_cc_session`, but the work runs on the
// laptop with full local tool access (shell, files, apps, browser, computer-use)
// instead of inside an ecodia-factory CC subprocess.
// ═══════════════════════════════════════════════════════════════════════

registry.registerMany([
  {
    name: 'start_laptop_session',
    description:
      'Run an agent session on the user\'s laptop. Use when the work needs ' +
      'native local access — installed apps, the user\'s real Chrome profile, ' +
      'files outside the registered codebases, GUI control, or anything that ' +
      'has to happen ON the user\'s machine. For pure repo coding work prefer ' +
      'start_cc_session (factory) — it\'s cheaper.',
    tier: 'write',
    domain: 'factory',
    priority: 'critical',
    params: {
      prompt: { type: 'string', required: true, description: 'What the agent should do' },
      workingDir: { type: 'string', required: false, description: 'Initial cwd for the agent (optional)' },
      maxTurns: { type: 'number', required: false, description: 'Cap on agent turns (default 40)' },
      tools: {
        type: 'array',
        required: false,
        description:
          'Whitelist of tool names. Omit for all. Available: ' +
          'shell.exec, files.read, files.write, files.edit, files.list, report_to_os.',
      },
    },
    handler: async (params) => {
      let prompt = params.prompt
      if (prompt && typeof prompt === 'object') {
        prompt = prompt.task || prompt.description || prompt.content || JSON.stringify(prompt)
      }
      if (!prompt || typeof prompt !== 'string') {
        throw new Error('start_laptop_session requires a prompt string')
      }

      const sessionId = `laptop_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`

      try {
        const ack = await handsBridge.dispatchRun({
          sessionId,
          prompt,
          workingDir: params.workingDir,
          maxTurns: params.maxTurns,
          tools: Array.isArray(params.tools) ? params.tools : undefined,
        })
        logger.info('laptop session dispatched', { sessionId, ack })
        return {
          message: 'Laptop session dispatched. Events will stream into the chat.',
          sessionId,
          streamUrl: ack?.streamUrl,
        }
      } catch (err) {
        logger.error('laptop session dispatch failed', { error: err.message })
        return { error: `dispatch failed: ${err.message}` }
      }
    },
  },
  {
    name: 'check_laptop_health',
    description: 'Ping the laptop hands service and report whether it\'s reachable.',
    tier: 'read',
    domain: 'factory',
    params: {},
    handler: async () => handsBridge.ping(),
  },
])
