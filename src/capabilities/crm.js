const registry = require('../services/capabilityRegistry')

registry.registerMany([
  {
    name: 'create_lead',
    description: 'Create a new CRM client record from lead data — name, company, contact info, source signal',
    tier: 'write',
    domain: 'crm',
    params: {
      name: { type: 'string', required: true, description: 'Full name' },
      company: { type: 'string', required: false, description: 'Company name' },
      email: { type: 'string', required: false, description: 'Email address' },
      phone: { type: 'string', required: false, description: 'Phone number' },
      linkedinUrl: { type: 'string', required: false, description: 'LinkedIn profile URL' },
      source: { type: 'string', required: false, description: 'Where this lead came from' },
      notes: { type: 'string', required: false, description: 'Initial notes or context' },
      leadScore: { type: 'number', required: false, description: 'Lead quality score 0-1' },
    },
    handler: async (params) => {
      const clientQueries = require('../db/queries/clients')
      const client = await clientQueries.createClient({
        name: params.name,
        company: params.company || null,
        email: params.email || null,
        phone: params.phone || null,
        linkedin_url: params.linkedinUrl || null,
        stage: 'lead',
        priority: (params.leadScore || 0) > 0.7 ? 'high' : 'medium',
        notes: params.notes
          ? [{ content: `${params.notes} [source: ${params.source || 'ai'}]`, createdAt: new Date().toISOString(), source: params.source || 'ai' }]
          : [],
      })
      return { message: `Lead created: ${params.name}`, clientId: client.id }
    },
  },
  {
    name: 'update_crm_stage',
    description: 'Move a CRM client to a new pipeline stage — lead, proposal, contract, development, live, ongoing, archived',
    tier: 'write',
    domain: 'crm',
    params: {
      clientId: { type: 'string', required: true, description: 'Client UUID' },
      stage: { type: 'string', required: true, description: 'New stage name' },
      note: { type: 'string', required: false, description: 'Reason for stage change' },
    },
    handler: async (params) => {
      const db = require('../config/db')
      const [client] = await db`
        UPDATE clients SET stage = ${params.stage}, updated_at = now()
        WHERE id = ${params.clientId}
        RETURNING name, stage
      `
      if (!client) throw new Error(`Client ${params.clientId} not found`)

      if (params.note) {
        await db`
          UPDATE clients
          SET notes = notes || ${JSON.stringify([{ content: params.note, createdAt: new Date().toISOString(), source: 'ai' }])}::jsonb
          WHERE id = ${params.clientId}
        `
      }
      return { message: `${client.name} moved to ${client.stage}` }
    },
  },
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
      const [task] = await db`
        INSERT INTO tasks (title, description, source, client_id, project_id, priority, due_date)
        VALUES (${params.title}, ${params.description || null}, ${params.source || 'ai'},
                ${params.clientId || null}, ${params.projectId || null},
                ${params.priority || 'medium'}, ${params.dueDate || null})
        RETURNING id, title
      `
      return { message: `Task created: ${task.title}`, taskId: task.id }
    },
  },
  {
    name: 'add_client_note',
    description: 'Add a note to a CRM client record',
    tier: 'write',
    domain: 'crm',
    params: {
      clientId: { type: 'string', required: true, description: 'Client UUID' },
      content: { type: 'string', required: true, description: 'Note text' },
      source: { type: 'string', required: false, description: 'Note origin' },
    },
    handler: async (params) => {
      const db = require('../config/db')
      const note = { content: params.content, createdAt: new Date().toISOString(), source: params.source || 'ai' }
      await db`
        UPDATE clients
        SET notes = notes || ${JSON.stringify([note])}::jsonb, updated_at = now()
        WHERE id = ${params.clientId}
      `
      return { message: `Note added to client ${params.clientId}` }
    },
  },
])
