const registry = require('../services/capabilityRegistry')

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const VALID_STATUSES = new Set(['pending', 'confirmed', 'dispatched', 'completed', 'rejected'])

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
      const status = params.status && VALID_STATUSES.has(params.status) ? params.status : null
      const codeRequestService = require('../services/codeRequestService')
      const requests = await codeRequestService.getActive(status)
      return { requests, count: requests.length }
    },
  },
  {
    name: 'confirm_code_request',
    description: 'Approve a pending code request and dispatch it as a CC Factory session',
    tier: 'write',
    domain: 'factory',
    priority: 'critical',
    params: {
      codeRequestId: { type: 'string', required: true, description: 'Code request UUID' },
      promptOverride: { type: 'string', required: false, description: 'Override the auto-generated prompt if needed' },
    },
    handler: async (params) => {
      if (!UUID_RE.test(params.codeRequestId)) {
        return { error: 'Invalid codeRequestId — must be a valid UUID' }
      }
      try {
        const codeRequestService = require('../services/codeRequestService')
        const session = await codeRequestService.confirmAndDispatch(params.codeRequestId, params.promptOverride)
        return { message: 'Code request confirmed and dispatched', sessionId: session?.id }
      } catch (err) {
        return { error: err.message }
      }
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
      if (!UUID_RE.test(params.codeRequestId)) {
        return { error: 'Invalid codeRequestId — must be a valid UUID' }
      }
      const db = require('../config/db')
      // Verify it exists and isn't already dispatched/completed
      const [existing] = await db`SELECT id, status FROM code_requests WHERE id = ${params.codeRequestId}`
      if (!existing) return { error: 'Code request not found' }
      if (existing.status === 'completed') return { error: 'Cannot reject a completed request' }
      if (existing.status === 'dispatched') return { error: 'Cannot reject — already dispatched. Stop the session instead.' }

      await db`
        UPDATE code_requests
        SET status = 'rejected', resolved_at = now(),
            metadata = metadata || ${JSON.stringify({ rejectionReason: params.reason || null })}::jsonb
        WHERE id = ${params.codeRequestId}
      `
      return { message: 'Code request rejected', id: params.codeRequestId }
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
      const [active] = await db`SELECT count(*)::int AS count FROM cc_sessions WHERE status IN ('running', 'initializing', 'completing', 'queued')`
      const [pending] = await db`SELECT count(*)::int AS count FROM code_requests WHERE status = 'pending'`
      const [today] = await db`SELECT count(*)::int AS count FROM cc_sessions WHERE status = 'complete' AND completed_at > now() - interval '24 hours'`
      const codebases = await db`SELECT id, name, language, repo_path FROM codebases ORDER BY name`
      const recentSessions = await db`
        SELECT id, initial_prompt, status, pipeline_stage, confidence_score, triggered_by, started_at, completed_at
        FROM cc_sessions ORDER BY started_at DESC LIMIT 10
      `
      // Include stuck code requests count
      const [stuck] = await db`
        SELECT count(*)::int AS count FROM code_requests
        WHERE status = 'confirmed' AND session_id IS NULL AND created_at < now() - interval '5 minutes'
      `
      return {
        activeSessions: active.count,
        pendingRequests: pending.count,
        todayCompletions: today.count,
        stuckRequests: stuck.count,
        codebases,
        recentSessions,
      }
    },
  },
  {
    name: 'recover_stuck_code_requests',
    description: 'Find and retry code requests stuck in confirmed state without a session',
    tier: 'write',
    domain: 'factory',
    params: {},
    handler: async () => {
      const codeRequestService = require('../services/codeRequestService')
      return codeRequestService.recoverStuckRequests()
    },
  },
])
