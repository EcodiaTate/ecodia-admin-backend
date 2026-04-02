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
      const db = require('../config/db')
      const notes = params.notes
        ? JSON.stringify([{ content: `${params.notes} [source: ${params.source || 'ai'}]`, createdAt: new Date().toISOString(), source: params.source || 'ai' }])
        : '[]'
      const [client] = await db`
        INSERT INTO clients (name, company, email, phone, linkedin_url, stage, priority, notes, tags)
        VALUES (
          ${params.name},
          ${params.company || null},
          ${params.email || null},
          ${params.phone || null},
          ${params.linkedinUrl || null},
          'lead',
          ${(params.leadScore || 0) > 0.7 ? 'high' : 'medium'},
          ${notes}::jsonb,
          '[]'::jsonb
        )
        RETURNING id, name
      `
      return { message: `Lead created: ${client.name}`, clientId: client.id }
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

      // Read current stage before update (needed for pipeline_events)
      const [current] = await db`SELECT name, stage FROM clients WHERE id = ${params.clientId}`
      if (!current) throw new Error(`Client ${params.clientId} not found`)

      await db`
        UPDATE clients SET stage = ${params.stage}, updated_at = now()
        WHERE id = ${params.clientId}
      `

      // Record the transition in pipeline_events (feeds KG and CRM triage)
      await db`
        INSERT INTO pipeline_events (client_id, from_stage, to_stage, note)
        VALUES (${params.clientId}, ${current.stage}, ${params.stage}, ${params.note || null})
      `

      // If a note was provided, append it to the client notes array
      if (params.note) {
        const note = JSON.stringify([{ content: params.note, createdAt: new Date().toISOString(), source: 'ai' }])
        await db`
          UPDATE clients
          SET notes = COALESCE(notes, '[]'::jsonb) || ${note}::jsonb, updated_at = now()
          WHERE id = ${params.clientId}
        `
      }

      return { message: `${current.name} moved from ${current.stage} to ${params.stage}` }
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
      const note = JSON.stringify([{ content: params.content, createdAt: new Date().toISOString(), source: params.source || 'ai' }])
      await db`
        UPDATE clients
        SET notes = COALESCE(notes, '[]'::jsonb) || ${note}::jsonb, updated_at = now()
        WHERE id = ${params.clientId}
      `
      return { message: `Note added to client ${params.clientId}` }
    },
  },
])
