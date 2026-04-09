#!/usr/bin/env node
/**
 * CRM MCP Server — exposes the full CRM system to the OS Session.
 *
 * Thin HTTP wrapper over the EcodiaOS CRM API routes.
 * Covers clients, projects, tasks, notes, contacts, timeline, intelligence.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'

const API_BASE = process.env.CRM_API_BASE || 'http://localhost:3001'
const API_TOKEN = process.env.CRM_API_TOKEN || ''

async function api(method, path, body, query) {
  const url = new URL(`${API_BASE}${path}`)
  if (query) Object.entries(query).forEach(([k, v]) => v != null && url.searchParams.set(k, String(v)))
  const res = await fetch(url.toString(), {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(API_TOKEN ? { Authorization: `Bearer ${API_TOKEN}` } : {}),
    },
    ...(body != null ? { body: JSON.stringify(body) } : {}),
  })
  const text = await res.text()
  try { return { ok: res.ok, status: res.status, data: JSON.parse(text) }
  } catch { return { ok: res.ok, status: res.status, data: text } }
}

function ok(data) {
  return { content: [{ type: 'text', text: typeof data === 'string' ? data : JSON.stringify(data, null, 2) }] }
}
function err(msg, detail) {
  const text = detail ? `Error: ${msg}\n${typeof detail === 'string' ? detail : JSON.stringify(detail)}` : `Error: ${msg}`
  return { content: [{ type: 'text', text }] }
}

const server = new McpServer({ name: 'crm', version: '1.0.0' })

// ── Clients ───────────────────────────────────────────────────────────

server.tool('crm_list_clients',
  'List all active clients with basic info and counts.',
  {
    limit:  z.number().optional().describe('Max results (default 50)'),
    offset: z.number().optional().describe('Pagination offset'),
  },
  async ({ limit, offset }) => {
    const { ok: success, data } = await api('GET', '/api/crm/clients', null, { limit: limit || 50, offset: offset || 0 })
    if (!success) return err('Failed to list clients', data)
    return ok(data)
  }
)

server.tool('crm_search_clients',
  'Search clients by name, company, email, or contact name.',
  { q: z.string().describe('Search query') },
  async ({ q }) => {
    const { ok: success, data } = await api('GET', '/api/crm/search', null, { q })
    if (!success) return err('Search failed', data)
    return ok(data)
  }
)

server.tool('crm_get_client',
  'Get full client details including email count, open tasks, sessions, active projects.',
  { id: z.string().describe('Client UUID or use crm_search_clients to find by name') },
  async ({ id }) => {
    const { ok: success, data } = await api('GET', `/api/crm/clients/${id}`)
    if (!success) return err('Client not found', data)
    return ok(data)
  }
)

server.tool('crm_get_intelligence',
  'Rich client intelligence — projects, contacts, recent emails, open tasks, active sessions, revenue, activity timeline. The most complete client view available.',
  { id: z.string().describe('Client UUID') },
  async ({ id }) => {
    const { ok: success, data } = await api('GET', `/api/crm/clients/${id}/intelligence`)
    if (!success) return err('Intelligence fetch failed', data)
    return ok(data)
  }
)

server.tool('crm_get_timeline',
  'Unified activity timeline for a client — emails, notes, tasks, sessions, payments, stage changes in chronological order.',
  {
    id:    z.string().describe('Client UUID'),
    limit: z.number().optional().describe('Max events (default 50)'),
  },
  async ({ id, limit }) => {
    const { ok: success, data } = await api('GET', `/api/crm/clients/${id}/timeline`, null, { limit: limit || 50 })
    if (!success) return err('Timeline fetch failed', data)
    return ok(data)
  }
)

server.tool('crm_create_client',
  'Create a new client/lead in the CRM.',
  {
    name:         z.string().describe('Client or company name'),
    contactName:  z.string().optional().describe('Primary contact person name'),
    contactEmail: z.string().optional().describe('Contact email'),
    contactPhone: z.string().optional().describe('Contact phone'),
    status:       z.enum(['lead', 'proposal', 'contract', 'development', 'live', 'ongoing', 'archived']).optional().describe('Pipeline stage (default: lead)'),
    source:       z.string().optional().describe('How they found us e.g. "referral", "linkedin"'),
  },
  async (params) => {
    const { ok: success, data } = await api('POST', '/api/crm/clients', params)
    if (!success) return err('Failed to create client', data)
    return ok(data)
  }
)

server.tool('crm_update_stage',
  'Move a client to a different pipeline stage.',
  {
    id:     z.string().describe('Client UUID'),
    status: z.enum(['lead', 'proposal', 'contract', 'development', 'live', 'ongoing', 'archived']).describe('New stage'),
    note:   z.string().optional().describe('Optional note about why this stage change happened'),
  },
  async ({ id, status, note }) => {
    const { ok: success, data } = await api('PATCH', `/api/crm/clients/${id}/status`, { status, note })
    if (!success) return err('Stage update failed', data)
    return ok(data)
  }
)

server.tool('crm_add_note',
  'Add a note to a client record — meetings, calls, decisions, anything worth recording.',
  {
    id:      z.string().describe('Client UUID'),
    content: z.string().describe('Note content'),
  },
  async ({ id, content }) => {
    const { ok: success, data } = await api('POST', `/api/crm/clients/${id}/notes`, { content })
    if (!success) return err('Failed to add note', data)
    return ok(data)
  }
)

// ── Contacts ──────────────────────────────────────────────────────────

server.tool('crm_get_contacts',
  'Get all contacts for a client.',
  { id: z.string().describe('Client UUID') },
  async ({ id }) => {
    const { ok: success, data } = await api('GET', `/api/crm/clients/${id}/contacts`)
    if (!success) return err('Failed to get contacts', data)
    return ok(data)
  }
)

server.tool('crm_add_contact',
  'Add a contact person to a client.',
  {
    id:        z.string().describe('Client UUID'),
    name:      z.string().describe('Contact name'),
    role:      z.enum(['decision_maker', 'technical', 'billing', 'general']).optional().describe('Contact role'),
    email:     z.string().optional(),
    phone:     z.string().optional(),
    linkedin:  z.string().optional(),
    isPrimary: z.boolean().optional().describe('Set as primary contact'),
  },
  async ({ id, ...contact }) => {
    const { ok: success, data } = await api('POST', `/api/crm/clients/${id}/contacts`, contact)
    if (!success) return err('Failed to add contact', data)
    return ok(data)
  }
)

// ── Tasks ─────────────────────────────────────────────────────────────

server.tool('crm_get_tasks',
  'Get open tasks for a client.',
  { id: z.string().describe('Client UUID') },
  async ({ id }) => {
    const { ok: success, data } = await api('GET', `/api/crm/clients/${id}/tasks`)
    if (!success) return err('Failed to get tasks', data)
    return ok(data)
  }
)

server.tool('crm_complete_task',
  'Mark a task as complete.',
  { taskId: z.string().describe('Task UUID') },
  async ({ taskId }) => {
    const { ok: success, data } = await api('POST', `/api/crm/tasks/${taskId}/complete`)
    if (!success) return err('Failed to complete task', data)
    return ok(data)
  }
)

// ── Projects ──────────────────────────────────────────────────────────

server.tool('crm_get_projects',
  'Get all projects for a client.',
  { id: z.string().describe('Client UUID') },
  async ({ id }) => {
    const { ok: success, data } = await api('GET', `/api/crm/clients/${id}/projects`)
    if (!success) return err('Failed to get projects', data)
    return ok(data)
  }
)

server.tool('crm_create_project',
  'Create a project under a client.',
  {
    clientId:    z.string().describe('Client UUID'),
    name:        z.string().describe('Project name'),
    description: z.string().optional(),
    status:      z.enum(['active', 'paused', 'complete', 'archived']).optional().describe('Default: active'),
    dealValue:   z.number().optional().describe('Deal value in AUD'),
  },
  async ({ clientId, name, description, status, dealValue }) => {
    const { ok: success, data } = await api('POST', '/api/crm/projects', {
      clientId, name, description, status: status || 'active', deal_value_aud: dealValue,
    })
    if (!success) return err('Failed to create project', data)
    return ok(data)
  }
)

// ── Pipeline & Analytics ──────────────────────────────────────────────

server.tool('crm_pipeline',
  'Pipeline overview — clients by stage with counts and deal values.',
  {},
  async () => {
    const { ok: success, data } = await api('GET', '/api/crm/pipeline')
    if (!success) return err('Pipeline fetch failed', data)
    return ok(data)
  }
)

server.tool('crm_dashboard',
  'Full CRM dashboard — pipeline summary, recent activity, open tasks, revenue overview.',
  {},
  async () => {
    const { ok: success, data } = await api('GET', '/api/crm/dashboard')
    if (!success) return err('Dashboard fetch failed', data)
    return ok(data)
  }
)

server.tool('crm_revenue',
  'Revenue overview — invoiced, received, outstanding by client.',
  {},
  async () => {
    const { ok: success, data } = await api('GET', '/api/crm/revenue')
    if (!success) return err('Revenue fetch failed', data)
    return ok(data)
  }
)

// ── Connect ───────────────────────────────────────────────────────────

const transport = new StdioServerTransport()
await server.connect(transport)
