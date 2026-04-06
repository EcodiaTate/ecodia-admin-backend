const registry = require('../services/capabilityRegistry')

async function resolveClientId(params) {
  if (params.clientId && /^[0-9a-f-]{36}$/i.test(params.clientId)) return params.clientId
  const name = params.clientName || params.clientId
  if (!name || name.trim().length < 2) throw new Error('Provide a clientId (UUID) or clientName to search')
  const db = require('../config/db')
  const q = `%${name.trim()}%`
  const matches = await db`SELECT id, name FROM clients WHERE archived_at IS NULL AND name ILIKE ${q} ORDER BY updated_at DESC LIMIT 3`
  if (matches.length === 0) throw new Error(`No client found matching "${name}"`)
  if (matches.length > 1) {
    const list = matches.map(m => `${m.name} (${m.id})`).join(', ')
    throw new Error(`Multiple clients match "${name}": ${list}. Be more specific or use the UUID.`)
  }
  return matches[0].id
}

registry.registerMany([
  // ─── Lead & Client Management ──────────────────────────────────────

  {
    name: 'create_lead',
    description: 'Create a new CRM client record from lead data — name, contact info, source signal',
    tier: 'write',
    domain: 'crm',
    params: {
      name: { type: 'string', required: true, description: 'Full name' },
      contactEmail: { type: 'string', required: false, description: 'Contact email address' },
      contactPhone: { type: 'string', required: false, description: 'Contact phone number' },
      source: { type: 'string', required: false, description: 'Where this lead came from: linkedin, gmail, referral, website, manual' },
      notes: { type: 'string', required: false, description: 'Initial notes or context' },
    },
    handler: async (params) => {
      const db = require('../config/db')
      const crmService = require('../services/crmService')
      const notes = params.notes
        ? JSON.stringify([{ content: `${params.notes} [source: ${params.source || 'ai'}]`, createdAt: new Date().toISOString(), source: params.source || 'ai' }])
        : '[]'
      const [client] = await db`
        INSERT INTO clients (name, contact_email, contact_phone, status, notes, tags, source, first_contact_at)
        VALUES (
          ${params.name}, ${params.contactEmail || null},
          ${params.contactPhone || null}, 'lead',
          ${notes}::jsonb,
          ARRAY[]::text[], ${params.source || 'manual'}, now()
        )
        RETURNING id, name
      `

      await crmService.logActivity({
        clientId: client.id,
        activityType: 'lead_created',
        title: `New lead: ${client.name}`,
        description: params.notes,
        source: params.source || 'manual',
        actor: 'ai',
      })

      return { message: `Lead created: ${client.name}`, clientId: client.id }
    },
  },

  {
    name: 'update_crm_status',
    description: 'Move a CRM client to a new pipeline status — lead, proposal, contract, development, live, ongoing, archived',
    tier: 'write',
    domain: 'crm',
    params: {
      clientId: { type: 'string', required: true, description: 'Client UUID' },
      status: { type: 'string', required: true, description: 'New status name' },
      note: { type: 'string', required: false, description: 'Reason for status change' },
    },
    handler: async (params) => {
      const db = require('../config/db')
      const crmService = require('../services/crmService')

      const [current] = await db`SELECT name, status FROM clients WHERE id = ${params.clientId}`
      if (!current) throw new Error(`Client ${params.clientId} not found`)

      await db`UPDATE clients SET status = ${params.status}, updated_at = now() WHERE id = ${params.clientId}`
      await db`
        INSERT INTO pipeline_events (client_id, from_stage, to_stage, note)
        VALUES (${params.clientId}, ${current.status}, ${params.status}, ${params.note || null})
      `

      if (params.note) {
        const note = JSON.stringify([{ content: params.note, createdAt: new Date().toISOString(), source: 'ai' }])
        await db`
          UPDATE clients SET notes = COALESCE(notes, '[]'::jsonb) || ${note}::jsonb, updated_at = now()
          WHERE id = ${params.clientId}
        `
      }

      await crmService.logActivity({
        clientId: params.clientId,
        activityType: 'stage_changed',
        title: `Status: ${current.status} → ${params.status}`,
        description: params.note,
        source: 'crm',
        actor: 'ai',
        metadata: { from: current.status, to: params.status },
      })

      // Fire KG hook
      try {
        const kgHooks = require('../services/kgIngestionHooks')
        kgHooks.onClientUpdated({ client: { ...current, id: params.clientId }, previousStage: current.status }).catch(() => {})
      } catch {}

      return { message: `${current.name} moved from ${current.status} to ${params.status}` }
    },
  },

  // ─── Task Management ───────────────────────────────────────────────

  {
    name: 'create_task',
    description: 'Create a task — anything that needs doing, tied to a client or project or free-standing',
    tier: 'write',
    domain: 'crm',
    params: {
      title: { type: 'string', required: true, description: 'Task title' },
      description: { type: 'string', required: false, description: 'Task context' },
      priority: { type: 'string', required: false, description: 'low|medium|high|urgent' },
      source: { type: 'string', required: false, description: 'Origin: gmail|linkedin|crm|ai|manual' },
      clientId: { type: 'string', required: false, description: 'Associated client UUID' },
      projectId: { type: 'string', required: false, description: 'Associated project UUID' },
      dueDate: { type: 'string', required: false, description: 'ISO date' },
    },
    handler: async (params) => {
      const db = require('../config/db')
      const crmService = require('../services/crmService')
      const validSources = ['gmail', 'linkedin', 'crm', 'manual', 'cc', 'cortex']
      const source = validSources.includes(params.source) ? params.source : 'cortex'
      const [task] = await db`
        INSERT INTO tasks (title, description, source, client_id, project_id, priority, due_date)
        VALUES (${params.title}, ${params.description || null}, ${source},
                ${params.clientId || null}, ${params.projectId || null},
                ${params.priority || 'medium'}, ${params.dueDate || null})
        RETURNING id, title
      `

      if (params.clientId) {
        await crmService.logActivity({
          clientId: params.clientId,
          projectId: params.projectId,
          activityType: 'task_created',
          title: `Task: ${task.title}`,
          description: params.description,
          source,
          sourceRefId: task.id,
          sourceRefType: 'task',
          actor: 'ai',
        })
      }

      return { message: `Task created: ${task.title}`, taskId: task.id }
    },
  },

  {
    name: 'complete_task',
    description: 'Mark a task as completed',
    tier: 'write',
    domain: 'crm',
    params: {
      taskId: { type: 'string', required: true, description: 'Task UUID' },
    },
    handler: async (params) => {
      const crmService = require('../services/crmService')
      const task = await crmService.completeTask(params.taskId, 'ai')
      if (!task) return { error: 'Task not found or already completed' }
      return { message: `Task completed: ${task.title}` }
    },
  },

  {
    name: 'get_client_tasks',
    description: 'Get open tasks for a client, sorted by priority and due date',
    tier: 'read',
    domain: 'crm',
    params: {
      clientId: { type: 'string', required: true, description: 'Client UUID' },
      includeCompleted: { type: 'boolean', required: false, description: 'Include completed tasks (default: false)' },
    },
    handler: async (params) => {
      const crmService = require('../services/crmService')
      const id=await resolveClientId(params)
      const tasks=await crmService.getClientTasks(id, { includeCompleted: params.includeCompleted })
      return { tasks, count: tasks.length }
    },
  },

  // ─── Notes & Communication ─────────────────────────────────────────

  {
    name: 'add_client_note',
    description: 'Add a note to a CRM client record — logged to activity timeline',
    tier: 'write',
    domain: 'crm',
    params: {
      clientId: { type: 'string', required: true, description: 'Client UUID' },
      content: { type: 'string', required: true, description: 'Note text' },
      source: { type: 'string', required: false, description: 'Note origin' },
    },
    handler: async (params) => {
      const db = require('../config/db')
      const crmService = require('../services/crmService')
      const note = JSON.stringify([{ content: params.content, createdAt: new Date().toISOString(), source: params.source || 'ai' }])
      await db`
        UPDATE clients SET notes = COALESCE(notes, '[]'::jsonb) || ${note}::jsonb, updated_at = now()
        WHERE id = ${params.clientId}
      `

      await crmService.logActivity({
        clientId: params.clientId,
        activityType: 'note_added',
        title: 'Note added',
        description: params.content.slice(0, 200),
        source: params.source || 'cortex',
        actor: 'ai',
      })

      return { message: `Note added to client ${params.clientId}` }
    },
  },

  // ─── Intelligence & Timeline ───────────────────────────────────────

  {
    name: 'get_client_intelligence',
    description: 'Get comprehensive client intelligence — projects, emails, tasks, sessions, activity timeline, revenue, contacts. The full picture.',
    tier: 'read',
    domain: 'crm',
    priority: 'critical',
    params: {
      clientId: { type: 'string', required: false, description: 'Client UUID' },
      clientName: { type: 'string', required: false, description: 'Client name to search (if no UUID)' },
    },
    handler: async (params) => {
      const crmService = require('../services/crmService')
      const id = await resolveClientId(params)
      return crmService.getClientIntelligence(id)
    },
  },

  {
    name: 'get_client_timeline',
    description: 'Get the unified activity timeline for a client — every interaction from every channel',
    tier: 'read',
    domain: 'crm',
    params: {
      clientId: { type: 'string', required: false, description: 'Client UUID' },
      clientName: { type: 'string', required: false, description: 'Client name to search (if no UUID)' },
      limit: { type: 'number', required: false, description: 'Max results (default 50)' },
      types: { type: 'string', required: false, description: 'Comma-separated activity types to filter' },
    },
    handler: async (params) => {
      const crmService = require('../services/crmService')
      const types = params.types ? params.types.split(',').map(t => t.trim()) : undefined
      const id = await resolveClientId(params)
      return crmService.getClientTimeline(id, { limit: params.limit || 50, types })
    },
  },

  // ─── Contact Management ────────────────────────────────────────────

  {
    name: 'add_client_contact',
    description: 'Add a contact person to a client — supports multiple stakeholders per client',
    tier: 'write',
    domain: 'crm',
    params: {
      clientId: { type: 'string', required: true, description: 'Client UUID' },
      name: { type: 'string', required: true, description: 'Contact name' },
      role: { type: 'string', required: false, description: 'Role: decision_maker, technical, billing, general' },
      email: { type: 'string', required: false, description: 'Contact email' },
      phone: { type: 'string', required: false, description: 'Contact phone' },
      linkedinUrl: { type: 'string', required: false, description: 'LinkedIn URL' },
      isPrimary: { type: 'boolean', required: false, description: 'Set as primary contact' },
    },
    handler: async (params) => {
      const crmService = require('../services/crmService')
      const cid=await resolveClientId(params)
      const contact=await crmService.addContact({...params,clientId:cid})
      return { message: `Contact added: ${contact.name}`, contactId: contact.id }
    },
  },

  {
    name: 'get_client_contacts',
    description: 'List all contacts for a client',
    tier: 'read',
    domain: 'crm',
    params: {
      clientId: { type: 'string', required: true, description: 'Client UUID' },
    },
    handler: async (params) => {
      const crmService = require('../services/crmService')
      const id=await resolveClientId(params)
      const contacts=await crmService.getContacts(id)
      return { contacts }
    },
  },

  // ─── Revenue & Deals ───────────────────────────────────────────────

  {
    name: 'get_revenue_overview',
    description: 'Get revenue overview — pipeline value, realized revenue, outstanding invoices, by stage',
    tier: 'read',
    domain: 'crm',
    params: {
      clientId: { type: 'string', required: false, description: 'Filter by client (omit for global)' },
    },
    handler: async (params) => {
      const crmService = require('../services/crmService')
      return crmService.getRevenueOverview({ clientId: params.clientId })
    },
  },

  {
    name: 'update_project_deal',
    description: 'Update deal/contract information on a project — value, contract date, payment status, invoice ref',
    tier: 'write',
    domain: 'crm',
    params: {
      projectId: { type: 'string', required: true, description: 'Project UUID' },
      dealValue: { type: 'number', required: false, description: 'Deal value in AUD' },
      contractDate: { type: 'string', required: false, description: 'Contract date (ISO)' },
      estimatedHours: { type: 'number', required: false, description: 'Estimated hours' },
      paymentStatus: { type: 'string', required: false, description: 'none|invoiced|partial|paid|overdue' },
      invoiceRef: { type: 'string', required: false, description: 'Invoice reference' },
    },
    handler: async (params) => {
      const db = require('../config/db')
      const crmService = require('../services/crmService')
      const updates = {}
      if (params.dealValue != null) updates.deal_value_aud = params.dealValue
      if (params.contractDate) updates.contract_date = params.contractDate
      if (params.estimatedHours != null) updates.estimated_hours = params.estimatedHours
      if (params.paymentStatus) updates.payment_status = params.paymentStatus
      if (params.invoiceRef) updates.invoice_ref = params.invoiceRef

      if (Object.keys(updates).length === 0) return { error: 'No fields to update' }

      const [project] = await db`
        UPDATE projects SET ${db(updates, ...Object.keys(updates))}, updated_at = now()
        WHERE id = ${params.projectId}
        RETURNING id, name, client_id
      `
      if (!project) return { error: 'Project not found' }

      if (project.client_id) {
        await crmService.logActivity({
          clientId: project.client_id,
          projectId: project.id,
          activityType: params.paymentStatus === 'paid' ? 'payment_received' : 'deal_updated',
          title: `Deal updated: ${project.name}`,
          description: Object.entries(updates).map(([k, v]) => `${k}: ${v}`).join(', '),
          source: 'crm',
          actor: 'ai',
        })

        // Update client total revenue when payment received
        if (params.paymentStatus === 'paid' && params.dealValue) {
          await db`
            UPDATE clients SET total_revenue_aud = COALESCE(total_revenue_aud, 0) + ${params.dealValue}, updated_at = now()
            WHERE id = ${project.client_id}
          `.catch(() => {})
        }
      }

      return { message: `Project ${project.name} deal updated` }
    },
  },

  // ─── Pipeline Analytics ────────────────────────────────────────────

  {
    name: 'get_pipeline_analytics',
    description: 'Get pipeline analytics — clients by stage, deal values, velocity, recent stage changes',
    tier: 'read',
    domain: 'crm',
    params: {},
    handler: async () => {
      const crmService = require('../services/crmService')
      return crmService.getPipelineAnalytics()
    },
  },

  // ─── Search & Discovery ────────────────────────────────────────────

  {
    name: 'search_clients',
    description: 'Search clients by name, company, email, or contact person',
    tier: 'read',
    domain: 'crm',
    params: {
      query: { type: 'string', required: true, description: 'Search query' },
    },
    handler: async (params) => {
      const crmService = require('../services/crmService')
      const results = await crmService.searchClients(params.query)
      return { results, count: results.length }
    },
  },

  // ─── Health Scoring ────────────────────────────────────────────────

  {
    name: 'compute_client_health',
    description: 'Compute and update the health score for a client based on recent activity',
    tier: 'write',
    domain: 'crm',
    params: {
      clientId: { type: 'string', required: true, description: 'Client UUID' },
    },
    handler: async (params) => {
      const crmService = require('../services/crmService')
      const id=await resolveClientId(params)
      return crmService.computeClientHealth(id)
    },
  },

  // ─── CRM Dashboard ────────────────────────────────────────────────

  {
    name: 'get_crm_dashboard',
    description: 'Get a full CRM snapshot — pipeline by stage, open tasks, overdue items, recent activity, revenue overview',
    tier: 'read',
    domain: 'crm',
    params: {},
    handler: async () => {
      const db = require('../config/db')
      const crmService = require('../services/crmService')

      const pipeline = await crmService.getPipelineAnalytics()
      const revenue = await crmService.getRevenueOverview()

      const [taskStats] = await db`
        SELECT
          count(*) FILTER (WHERE completed_at IS NULL)::int AS open,
          count(*) FILTER (WHERE completed_at IS NULL AND due_date < now())::int AS overdue,
          count(*) FILTER (WHERE completed_at IS NULL AND priority IN ('urgent','high'))::int AS high_priority
        FROM tasks
      `

      const recentActivity = await db`
        SELECT al.*, c.name AS client_name
        FROM crm_activity_log al
        JOIN clients c ON al.client_id = c.id
        ORDER BY al.created_at DESC LIMIT 15
      `

      const unhealthyClients = await db`
        SELECT id, name, status, health_score, last_contact_at
        FROM clients
        WHERE archived_at IS NULL AND health_score IS NOT NULL AND health_score < 0.4
        ORDER BY health_score ASC LIMIT 5
      `

      return { pipeline, revenue, taskStats, recentActivity, unhealthyClients }
    },
  },
])
