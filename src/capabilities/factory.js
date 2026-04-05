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
  {
    name: 'get_session_progress',
    description: 'Get a concise progress summary for one or more sessions — pipeline stage, duration, confidence, last activity, and output excerpt',
    tier: 'read',
    domain: 'factory',
    params: {
      sessionId: { type: 'string', required: false, description: 'Specific session UUID (omit to get all active)' },
      clientId: { type: 'string', required: false, description: 'Filter sessions by client' },
      codebaseId: { type: 'string', required: false, description: 'Filter sessions by codebase' },
    },
    handler: async (params) => {
      const db = require('../config/db')
      let sessions
      if (params.sessionId) {
        sessions = await db`
          SELECT cs.id, cs.initial_prompt, cs.status, cs.pipeline_stage,
                 cs.confidence_score, cs.triggered_by, cs.trigger_source,
                 cs.started_at, cs.completed_at, cs.error_message,
                 cs.files_changed, cs.client_id,
                 cb.name AS codebase_name, c.name AS client_name
          FROM cc_sessions cs
          LEFT JOIN codebases cb ON cs.codebase_id = cb.id
          LEFT JOIN clients c ON cs.client_id = c.id
          WHERE cs.id = ${params.sessionId}
        `
      } else {
        const statusFilter = ['running', 'initializing', 'completing', 'queued']
        sessions = await db`
          SELECT cs.id, cs.initial_prompt, cs.status, cs.pipeline_stage,
                 cs.confidence_score, cs.triggered_by, cs.trigger_source,
                 cs.started_at, cs.completed_at, cs.error_message,
                 cs.files_changed, cs.client_id,
                 cb.name AS codebase_name, c.name AS client_name
          FROM cc_sessions cs
          LEFT JOIN codebases cb ON cs.codebase_id = cb.id
          LEFT JOIN clients c ON cs.client_id = c.id
          WHERE cs.status = ANY(${statusFilter})
            ${params.clientId ? db`AND cs.client_id = ${params.clientId}` : db``}
            ${params.codebaseId ? db`AND cs.codebase_id = ${params.codebaseId}` : db``}
          ORDER BY cs.started_at DESC LIMIT 20
        `
      }

      // For each session, get last log excerpt
      const summaries = []
      for (const s of sessions) {
        const [lastLog] = await db`
          SELECT chunk FROM cc_session_logs
          WHERE session_id = ${s.id}
          ORDER BY created_at DESC LIMIT 1
        `.catch(() => [])
        const durationMin = s.started_at
          ? Math.round((Date.now() - new Date(s.started_at).getTime()) / 60000)
          : null
        summaries.push({
          id: s.id,
          prompt: (s.initial_prompt || '').slice(0, 120),
          status: s.status,
          pipelineStage: s.pipeline_stage,
          confidence: s.confidence_score,
          triggeredBy: s.triggered_by,
          codebase: s.codebase_name,
          client: s.client_name,
          durationMinutes: durationMin,
          filesChanged: Array.isArray(s.files_changed) ? s.files_changed.length : 0,
          error: s.error_message ? s.error_message.slice(0, 200) : null,
          lastOutput: lastLog?.chunk ? lastLog.chunk.slice(-300) : null,
        })
      }
      return { sessions: summaries, count: summaries.length }
    },
  },
  {
    name: 'list_codebases',
    description: 'List all registered codebases with their language, path, and recent session activity',
    tier: 'read',
    domain: 'factory',
    params: {},
    handler: async () => {
      const db = require('../config/db')
      const codebases = await db`
        SELECT cb.id, cb.name, cb.language, cb.repo_path,
               (SELECT count(*)::int FROM cc_sessions WHERE codebase_id = cb.id
                AND started_at > now() - interval '14 days') AS recent_sessions,
               (SELECT count(*)::int FROM code_requests WHERE codebase_id = cb.id
                AND status = 'pending') AS pending_requests
        FROM codebases cb ORDER BY cb.name
      `
      return { codebases }
    },
  },
])
