#!/usr/bin/env node
/**
 * Factory MCP Server — exposes Factory/CC session tools to the OS Session.
 *
 * Thin HTTP wrapper over the EcodiaOS backend API. All heavy logic lives
 * in factoryTriggerService, factoryOversightService, and factoryRunner.
 * This server just makes those tools callable from inside a Claude Code CLI session.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'

const API_BASE = process.env.FACTORY_API_BASE || 'http://localhost:3001'
const API_TOKEN = process.env.FACTORY_API_TOKEN || process.env.MCP_INTERNAL_TOKEN || process.env.JWT_TOKEN || ''

async function api(method, path, body) {
  const res = await fetch(`${API_BASE}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(API_TOKEN ? { Authorization: `Bearer ${API_TOKEN}` } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  })
  const text = await res.text()
  try {
    return { ok: res.ok, status: res.status, data: JSON.parse(text) }
  } catch {
    return { ok: res.ok, status: res.status, data: text }
  }
}

function ok(data) {
  return { content: [{ type: 'text', text: typeof data === 'string' ? data : JSON.stringify(data, null, 2) }] }
}
function err(msg) {
  return { content: [{ type: 'text', text: `Error: ${msg}` }] }
}
function apiErr(status, data, fallback) {
  const msg = typeof data === 'string' ? data : data?.error || data?.message || fallback
  return err(`Factory API ${status}: ${msg}`)
}

const server = new McpServer({ name: 'factory', version: '1.0.0' })

// ── Dispatch ──────────────────────────────────────────────────────────

server.tool(
  'start_cc_session',
  'Dispatch a coding task to the Factory — a separate Claude Code CLI process that runs autonomously. ' +
  'Use this for ANY coding task: features, bug fixes, refactors, migrations. ' +
  'Write a precise self-contained prompt — the session has no conversation context, only what you give it. ' +
  'Returns immediately with a sessionId. The session runs in background; call get_session_progress to monitor.',
  {
    prompt: z.string().describe(
      'Full task description. Be explicit: what to build/fix/change, in which file(s), why, and any constraints. ' +
      'Include relevant context (current behaviour, expected behaviour, related files). ' +
      'The session reads no prior conversation — every important detail must be in this prompt.'
    ),
    codebaseName: z.string().optional().describe('Codebase name, e.g. "ecodiaos-backend", "roam-frontend". Auto-resolved from prompt if omitted.'),
    workingDir: z.string().optional().describe('Absolute VPS path to the working directory. Overrides codebase lookup.'),
  },
  async ({ prompt, codebaseName, workingDir }) => {
    const { ok: success, status, data } = await api('POST', '/api/cc/sessions', {
      initialPrompt: prompt,
      codebaseName: codebaseName || null,
      workingDir: workingDir || null,
      triggeredBy: 'proactive',
      triggerSource: 'cortex',
    })
    if (!success) return apiErr(status, data, 'Failed to start session')
    return ok({
      message: 'Factory session dispatched',
      sessionId: data.id,
      status: data.status,
      hint: `Monitor with get_session_progress("${data.id}"). Review and deploy with review_factory_session + approve_factory_deploy when complete.`,
    })
  }
)

// ── Status / Progress ─────────────────────────────────────────────────

server.tool(
  'get_factory_status',
  'Get an overview of all Factory sessions — active count, queue, and the 10 most recent sessions with status and confidence scores.',
  {},
  async () => {
    const { ok: success, status, data } = await api('GET', '/api/cc/sessions?limit=10')
    if (!success) return apiErr(status, data, 'Failed to fetch factory status')
    const active = (data.sessions || []).filter(s => ['running', 'initializing', 'completing'].includes(s.status))
    const recent = (data.sessions || []).slice(0, 10)
    return ok({
      activeSessions: active.length,
      totalSessions: data.total,
      active: active.map(s => ({ id: s.id, prompt: s.initial_prompt?.slice(0, 80), stage: s.pipeline_stage })),
      recent: recent.map(s => ({
        id: s.id,
        status: s.status,
        confidence: s.confidence_score,
        prompt: s.initial_prompt?.slice(0, 80),
        codebase: s.codebase_name,
        startedAt: s.started_at,
        completedAt: s.completed_at,
      })),
    })
  }
)

server.tool(
  'get_session_progress',
  'Get concise progress for one specific Factory session — stage, duration, confidence, last output line.',
  {
    sessionId: z.string().describe('CC session UUID'),
  },
  async ({ sessionId }) => {
    const { ok: success, status, data } = await api('GET', `/api/cc/sessions/${sessionId}`)
    if (!success) return apiErr(status, data, `Session not found: ${sessionId}`)
    const s = data.session || data
    const logs = data.recentLogs || []
    const lastOutput = logs.length > 0 ? logs[logs.length - 1]?.chunk?.slice(-400) : null
    const duration = s.started_at
      ? Math.round((Date.now() - new Date(s.started_at).getTime()) / 60000)
      : null
    return ok({
      id: s.id,
      status: s.status,
      pipelineStage: s.pipeline_stage,
      confidence: s.confidence_score,
      durationMinutes: duration,
      filesChanged: Array.isArray(s.files_changed) ? s.files_changed.length : 0,
      error: s.error_message?.slice(0, 300) || null,
      lastOutput,
      hint: s.status === 'complete'
        ? `Ready for review — call review_factory_session("${sessionId}")`
        : s.status === 'error'
          ? `Failed — call get_cc_session_details("${sessionId}") for full logs`
          : `Still running (${s.pipeline_stage})`,
    })
  }
)

server.tool(
  'get_cc_session_details',
  'Get full details and recent logs for a Factory session. Use after get_session_progress when you need the full output.',
  {
    sessionId: z.string().describe('CC session UUID'),
  },
  async ({ sessionId }) => {
    const { ok: success, status, data } = await api('GET', `/api/cc/sessions/${sessionId}`)
    if (!success) return apiErr(status, data, `Session not found: ${sessionId}`)
    return ok(data)
  }
)

// ── Intervention ───────────────────────────────────────────────────────

server.tool(
  'send_cc_message',
  'Send a message to a RUNNING Factory session to steer it mid-flight. Use sparingly — interruptions add latency.',
  {
    sessionId: z.string().describe('CC session UUID'),
    message: z.string().describe('Instruction or clarification to send'),
  },
  async ({ sessionId, message }) => {
    const { ok: success, status, data } = await api('POST', `/api/cc/sessions/${sessionId}/message`, { message })
    if (!success) return apiErr(status, data, 'Failed to send message')
    return ok({ sent: true, sessionId })
  }
)

server.tool(
  'resume_cc_session',
  'Continue a completed or paused Factory session with a follow-up instruction. Full context is preserved.',
  {
    sessionId: z.string().describe('CC session UUID to resume'),
    message: z.string().describe('Follow-up instruction'),
  },
  async ({ sessionId, message }) => {
    const { ok: success, status, data } = await api('POST', `/api/cc/sessions/${sessionId}/resume`, { message })
    if (!success) return apiErr(status, data, 'Failed to resume')
    return ok({ resumed: true, sessionId, newSessionId: data?.id || null })
  }
)

// ── Review & Deploy ────────────────────────────────────────────────────

server.tool(
  'review_factory_session',
  'Get the full review context for a completed Factory session before deciding to deploy or reject. ' +
  'Returns: diff summary, files changed, validation results (tests/lint/typecheck), confidence score, and relevant past learnings. ' +
  'Always call this before approve_factory_deploy or reject_factory_session.',
  {
    sessionId: z.string().describe('CC session UUID awaiting review'),
  },
  async ({ sessionId }) => {
    const { ok: success, status, data } = await api('GET', `/api/cc/sessions/${sessionId}/review`)
    if (!success) return apiErr(status, data, 'Review failed')
    return ok(data)
  }
)

server.tool(
  'approve_factory_deploy',
  'Approve and deploy a reviewed Factory session. Commits changes, restarts affected services, records learning. ' +
  'Only call this after review_factory_session — read the diff first.',
  {
    sessionId: z.string().describe('CC session UUID to deploy'),
    notes: z.string().optional().describe('Why you approved this — recorded as a learning for future sessions'),
  },
  async ({ sessionId, notes }) => {
    const { ok: success, status, data } = await api('POST', `/api/cc/sessions/${sessionId}/approve`, {
      notes: notes || '',
    })
    if (!success) return apiErr(status, data, 'Approval failed')
    return ok(data)
  }
)

server.tool(
  'reject_factory_session',
  'Reject a Factory session — cleans the worktree, records the failure reason as a learning, marks session failed. ' +
  'Optionally re-dispatches with a corrected prompt.',
  {
    sessionId: z.string().describe('CC session UUID to reject'),
    reason: z.string().describe('Why this is being rejected — be specific, this becomes a learning for future sessions'),
    redispatch: z.boolean().optional().describe('Re-dispatch the task with a corrected prompt after rejecting'),
    correctedPrompt: z.string().optional().describe('Corrected prompt if redispatch is true'),
  },
  async ({ sessionId, reason, redispatch, correctedPrompt }) => {
    const { ok: success, status, data } = await api('POST', `/api/cc/sessions/${sessionId}/reject`, {
      reason,
      redispatch: redispatch || false,
      correctedPrompt: correctedPrompt || null,
    })
    if (!success) return apiErr(status, data, 'Rejection failed')
    return ok(data)
  }
)

// ── Codebases ──────────────────────────────────────────────────────────

server.tool(
  'list_codebases',
  'List all registered codebases with language, VPS path, and recent Factory activity.',
  {},
  async () => {
    const { ok: success, status, data } = await api('GET', '/api/codebase')
    if (!success) return apiErr(status, data, 'Failed to fetch codebases')
    const codebases = (data.codebases || data || []).map(cb => ({
      id: cb.id,
      name: cb.name,
      language: cb.language,
      path: cb.repo_path,
      recentSessions: cb.recent_sessions,
      pendingRequests: cb.pending_requests,
    }))
    return ok({ codebases, hint: 'Use name or id in start_cc_session codebaseName parameter' })
  }
)

const transport = new StdioServerTransport()
await server.connect(transport)
