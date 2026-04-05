const registry = require('../services/capabilityRegistry')

registry.registerMany([
  {
    name: 'get_code_requests',
    description: 'Get pending and recent code requests from email, CRM, and manual sources',
    tier: 'read',
    domain: 'factory',
    params: {
      status: { type: 'string', required: false, description: 'Filter: pending|confirmed|dispatched|completed|rejected' },
    },
    handler: async (params) => {
      const codeRequestService = require('../services/codeRequestService')
      const requests = await codeRequestService.getActive(params.status || null)
      return { requests, count: requests.length }
    },
  },
  {
    name: 'confirm_code_request',
    description: 'Approve a pending code request and dispatch it as a CC Factory session',
    tier: 'write',
    domain: 'factory',
    params: {
      codeRequestId: { type: 'string', required: true, description: 'Code request UUID' },
      promptOverride: { type: 'string', required: false, description: 'Override the auto-generated prompt if needed' },
    },
    handler: async (params) => {
      const codeRequestService = require('../services/codeRequestService')
      const session = await codeRequestService.confirmAndDispatch(params.codeRequestId, params.promptOverride)
      return { message: 'Code request confirmed and dispatched', sessionId: session?.id }
    },
  },
  {
    name: 'reject_code_request',
    description: 'Reject a pending code request — marks it as rejected and stops further processing',
    tier: 'write',
    domain: 'factory',
    params: {
      codeRequestId: { type: 'string', required: true, description: 'Code request UUID' },
      reason: { type: 'string', required: false, description: 'Rejection reason' },
    },
    handler: async (params) => {
      const db = require('../config/db')
      await db`
        UPDATE code_requests
        SET status = 'rejected', resolved_at = now(),
            metadata = metadata || ${JSON.stringify({ rejectionReason: params.reason || null })}::jsonb
        WHERE id = ${params.codeRequestId}
      `
      return { message: 'Code request rejected' }
    },
  },
  {
    name: 'get_coding_dashboard',
    description: 'Get a snapshot of the coding workspace: active sessions, pending requests, recent completions, registered codebases',
    tier: 'read',
    domain: 'factory',
    params: {},
    handler: async () => {
      const db = require('../config/db')
      const [active] = await db`SELECT count(*)::int AS count FROM cc_sessions WHERE status IN ('running', 'initializing')`
      const [pending] = await db`SELECT count(*)::int AS count FROM code_requests WHERE status = 'pending'`
      const [today] = await db`SELECT count(*)::int AS count FROM cc_sessions WHERE status = 'complete' AND completed_at > now() - interval '24 hours'`
      const codebases = await db`SELECT id, name, language, repo_path FROM codebases ORDER BY name`
      const recentSessions = await db`
        SELECT id, initial_prompt, status, pipeline_stage, confidence_score, triggered_by, started_at, completed_at
        FROM cc_sessions ORDER BY started_at DESC LIMIT 10
      `
      return {
        activeSessions: active.count,
        pendingRequests: pending.count,
        todayCompletions: today.count,
        codebases,
        recentSessions,
      }
    },
  },
])
