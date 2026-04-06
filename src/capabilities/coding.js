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

  // ─── Auto-Developer: Social Code Request Intake ─────────────────────
  {
    name: 'create_social_code_request',
    description: 'Create a code request from a social channel message (LinkedIn, Meta, Twitter, etc). Used when the AI detects a code work request in a social DM.',
    tier: 'write',
    domain: 'factory',
    params: {
      source: { type: 'string', required: true, description: 'Source platform: linkedin, meta, twitter, gmail' },
      sourceRefId: { type: 'string', required: false, description: 'Platform-specific reference ID (DM id, conversation id, etc.)' },
      summary: { type: 'string', required: true, description: 'Short summary of the request' },
      factoryPrompt: { type: 'string', required: true, description: 'Detailed description of the code work to perform' },
      codeWorkType: { type: 'string', required: false, description: 'Type: feature, bugfix, update, investigation, refactor' },
      suggestedCodebase: { type: 'string', required: false, description: 'Target codebase name if known' },
      clientId: { type: 'number', required: false, description: 'CRM client ID if linked' },
    },
    handler: async (params) => {
      const codeRequestService = require('../services/codeRequestService')
      const result = await codeRequestService.createFromSocial({
        source: params.source,
        sourceRefId: params.sourceRefId || null,
        clientId: params.clientId || null,
        summary: params.summary,
        factoryPrompt: params.factoryPrompt,
        codeWorkType: params.codeWorkType || null,
        suggestedCodebase: params.suggestedCodebase || null,
        confidence: 0.6,
        surfaceToHuman: true,
        replyContext: { platform: params.source, sourceRefId: params.sourceRefId },
      })
      if (!result) return { error: 'Code request creation failed — prompt too short or validation failed' }
      return { created: true, codeRequestId: result.id, status: result.status }
    },
  },

  {
    name: 'get_auto_developer_status',
    description: 'Get status of the auto-developer pipeline: social code requests by source, pending/active/completed counts, recent completions with outcomes.',
    tier: 'read',
    domain: 'factory',
    params: {},
    handler: async () => {
      const db = require('../config/db')
      const bySource = await db`
        SELECT source, status, count(*)::int AS count
        FROM code_requests
        WHERE created_at > now() - interval '30 days'
        GROUP BY source, status
        ORDER BY source, status
      `
      const recent = await db`
        SELECT cr.id, cr.source, cr.summary, cr.status, cr.code_work_type,
               cr.confidence, cr.created_at, cr.resolved_at,
               cs.status AS session_status, cs.pipeline_stage, cs.confidence_score AS session_confidence
        FROM code_requests cr
        LEFT JOIN cc_sessions cs ON cr.session_id = cs.id
        WHERE cr.created_at > now() - interval '7 days'
        ORDER BY cr.created_at DESC LIMIT 20
      `
      return { bySource, recent, recentCount: recent.length }
    },
  },
])
