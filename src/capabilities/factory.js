const registry = require('../services/capabilityRegistry')

registry.registerMany([
  {
    name: 'start_cc_session',
    description: 'Start a Claude Code Factory session to implement, fix, or improve code in a codebase',
    tier: 'write',
    domain: 'factory',
    priority: 'critical',  // always allowed even under pressure
    params: {
      prompt: { type: 'string', required: true, description: 'What to build, fix, or improve' },
      codebaseId: { type: 'string', required: false, description: 'Target codebase ID (resolved by AI if omitted)' },
      codebaseName: { type: 'string', required: false, description: 'Codebase name hint for resolution' },
      workingDir: { type: 'string', required: false, description: 'Explicit working directory path for the CC session' },
    },
    handler: async (params) => {
      const triggers = require('../services/factoryTriggerService')

      // Guard: if prompt is an object (Cortex sent nested params), stringify it
      // This happens when AI wraps the task in { prompt: { task: "..." } } or similar
      let prompt = params.prompt
      if (prompt && typeof prompt === 'object') {
        prompt = prompt.task || prompt.description || prompt.content || JSON.stringify(prompt)
      }
      if (!prompt || typeof prompt !== 'string') {
        throw new Error('start_cc_session requires a prompt string — received: ' + JSON.stringify(params.prompt))
      }

      const session = await triggers.dispatchFromCortex(prompt, {
        codebaseId: params.codebaseId,
        codebaseName: params.codebaseName,
        workingDir: params.workingDir || null,
      })
      return { message: `Factory session started`, sessionId: session?.id }
    },
  },
  {
    name: 'get_factory_status',
    description: 'Get the current status of Factory sessions — running, queued, recent completions',
    tier: 'read',
    domain: 'factory',
    params: {},
    handler: async () => {
      const db = require('../config/db')
      const [active] = await db`SELECT count(*)::int AS count FROM cc_sessions WHERE status IN ('running', 'initializing')`
      const recent = await db`
        SELECT id, status, initial_prompt, confidence_score, started_at, completed_at
        FROM cc_sessions ORDER BY started_at DESC LIMIT 5
      `
      return { activeSessions: active.count, recent }
    },
  },
  {
    name: 'trigger_vercel_build',
    description: 'Trigger a Vercel deployment for a project',
    tier: 'write',
    domain: 'factory',
    params: {
      projectId: { type: 'string', required: false, description: 'Vercel project ID (triggers all if omitted)' },
    },
    handler: async (params) => {
      const vercel = require('../services/vercelService')
      const result = await vercel.triggerDeploy ? vercel.triggerDeploy(params.projectId) : { error: 'triggerDeploy not available' }
      return { message: 'Vercel build triggered', result }
    },
  },
  {
    name: 'resume_cc_session',
    description: 'Resume a completed or paused CC session with a follow-up message — continues the conversation with full context preserved',
    tier: 'write',
    domain: 'factory',
    priority: 'critical',
    params: {
      sessionId: { type: 'string', required: true, description: 'CC session UUID to resume' },
      message: { type: 'string', required: true, description: 'Follow-up message or instruction' },
    },
    handler: async (params) => {
      const bridge = require('../services/factoryBridge')
      bridge.publishResumeSession(params.sessionId, params.message)
      return { message: 'Session resume requested', sessionId: params.sessionId }
    },
  },
  {
    name: 'send_cc_message',
    description: 'Send a message to a running CC session — for real-time intervention or guidance',
    tier: 'write',
    domain: 'factory',
    priority: 'critical',
    params: {
      sessionId: { type: 'string', required: true, description: 'CC session UUID' },
      message: { type: 'string', required: true, description: 'Message to send' },
    },
    handler: async (params) => {
      const bridge = require('../services/factoryBridge')
      bridge.publishSendMessage(params.sessionId, params.message)
      return { message: 'Message sent to session', sessionId: params.sessionId }
    },
  },
  {
    name: 'get_cc_session_details',
    description: 'Get detailed information about a specific CC session including logs, pipeline stage, and files changed',
    tier: 'read',
    domain: 'factory',
    params: {
      sessionId: { type: 'string', required: true, description: 'CC session UUID' },
    },
    handler: async (params) => {
      const db = require('../config/db')
      const [session] = await db`
        SELECT cs.*, cb.name AS codebase_name, c.name AS client_name, p.name AS project_name
        FROM cc_sessions cs
        LEFT JOIN codebases cb ON cs.codebase_id = cb.id
        LEFT JOIN clients c ON cs.client_id = c.id
        LEFT JOIN projects p ON cs.project_id = p.id
        WHERE cs.id = ${params.sessionId}
      `
      if (!session) throw new Error(`Session not found: ${params.sessionId}`)

      const logs = await db`
        SELECT chunk, created_at FROM cc_session_logs
        WHERE session_id = ${params.sessionId}
        ORDER BY created_at DESC LIMIT 50
      `
      return { session, recentLogs: logs.reverse() }
    },
  },
])
