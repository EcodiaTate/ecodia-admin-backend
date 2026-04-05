const db = require('../config/db')
const logger = require('../config/logger')

// ═══════════════════════════════════════════════════════════════════════
// CRM SERVICE — Unified client intelligence hub
//
// Every system (gmail, factory, bookkeeping, linkedin, cortex) logs
// interactions here. The CRM is the connective tissue — it knows every
// touchpoint with every client across every channel.
//
// Other services call logActivity() to record what happened.
// Cortex queries getClientTimeline() to see the full picture.
// The AI uses getClientIntelligence() for rich context before decisions.
// ═══════════════════════════════════════════════════════════════════════

// ─── Activity Logging ────────────────────────────────────────────────
// Single entry point for ALL client interactions from ANY source

async function logActivity({ clientId, projectId, activityType, title, description, source, sourceRefId, sourceRefType, actor, metadata }) {
  if (!clientId || !activityType || !title) {
    logger.debug('CRM activity skipped: missing required fields', { clientId, activityType, title })
    return null
  }

  try {
    const [activity] = await db`
      INSERT INTO crm_activity_log (
        client_id, project_id, activity_type, title, description,
        source, source_ref_id, source_ref_type, actor, metadata
      ) VALUES (
        ${clientId}, ${projectId || null}, ${activityType}, ${title},
        ${description || null}, ${source || 'manual'}, ${sourceRefId || null},
        ${sourceRefType || null}, ${actor || 'system'}, ${JSON.stringify(metadata || {})}::jsonb
      )
      RETURNING id
    `

    // Update client's last_contact_at
    await db`
      UPDATE clients SET last_contact_at = now(), updated_at = now()
      WHERE id = ${clientId}
    `.catch(() => {})

    return activity
  } catch (err) {
    logger.debug('CRM activity log failed', { error: err.message, clientId, activityType })
    return null
  }
}

// ─── Client Timeline ─────────────────────────────────────────────────
// Unified view of ALL interactions across ALL channels

async function getClientTimeline(clientId, { limit = 50, offset = 0, types } = {}) {
  const activities = await db`
    SELECT * FROM crm_activity_log
    WHERE client_id = ${clientId}
      ${types?.length ? db`AND activity_type = ANY(${types})` : db``}
    ORDER BY created_at DESC
    LIMIT ${limit} OFFSET ${offset}
  `

  const [{ count }] = await db`
    SELECT count(*)::int FROM crm_activity_log
    WHERE client_id = ${clientId}
      ${types?.length ? db`AND activity_type = ANY(${types})` : db``}
  `

  return { activities, total: count }
}

// ─── Client Intelligence ─────────────────────────────────────────────
// Rich context assembly for AI decision-making. Called before any AI
// action involving a client (email reply, task creation, stage change, etc.)

async function getClientIntelligence(clientId) {
  const [client] = await db`
    SELECT c.*,
      (SELECT count(*)::int FROM email_threads WHERE client_id = c.id) AS email_count,
      (SELECT count(*)::int FROM tasks WHERE client_id = c.id AND completed_at IS NULL) AS open_tasks,
      (SELECT count(*)::int FROM cc_sessions WHERE client_id = c.id) AS total_sessions,
      (SELECT count(*)::int FROM code_requests WHERE client_id = c.id AND status = 'pending') AS pending_requests
    FROM clients c WHERE c.id = ${clientId}
  `
  if (!client) return null

  // Projects with deal tracking
  const projects = await db`
    SELECT id, name, description, status, tech_stack, budget_aud, hourly_rate,
           deal_value_aud, contract_date, estimated_hours, actual_hours_logged,
           payment_status, invoice_ref, repo_url
    FROM projects WHERE client_id = ${clientId}
    ORDER BY status = 'active' DESC, created_at DESC
  `

  // Recent activity (last 20)
  const recentActivity = await db`
    SELECT activity_type, title, source, created_at
    FROM crm_activity_log
    WHERE client_id = ${clientId}
    ORDER BY created_at DESC LIMIT 20
  `

  // Recent emails
  const recentEmails = await db`
    SELECT id, subject, from_email, triage_summary, triage_priority, received_at, status
    FROM email_threads
    WHERE client_id = ${clientId}
    ORDER BY received_at DESC LIMIT 5
  `

  // Open tasks
  const openTasks = await db`
    SELECT id, title, priority, source, due_date, created_at
    FROM tasks
    WHERE client_id = ${clientId} AND completed_at IS NULL
    ORDER BY CASE priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END, created_at DESC
    LIMIT 10
  `

  // Active coding sessions
  const activeSessions = await db`
    SELECT cs.id, cs.initial_prompt, cs.status, cs.pipeline_stage, cs.started_at,
           cb.name AS codebase_name
    FROM cc_sessions cs
    LEFT JOIN codebases cb ON cs.codebase_id = cb.id
    WHERE cs.client_id = ${clientId} AND cs.status IN ('running', 'initializing', 'queued')
  `

  // Contacts
  const contacts = await db`
    SELECT name, role, email, phone, linkedin_url, is_primary
    FROM crm_contacts WHERE client_id = ${clientId}
    ORDER BY is_primary DESC, created_at
  `

  // Revenue: sum from projects + linked transactions
  const [revenue] = await db`
    SELECT
      COALESCE(SUM(deal_value_aud), 0) AS total_deal_value,
      COALESCE(SUM(CASE WHEN payment_status = 'paid' THEN deal_value_aud ELSE 0 END), 0) AS total_paid,
      COALESCE(SUM(CASE WHEN payment_status = 'invoiced' THEN deal_value_aud ELSE 0 END), 0) AS total_invoiced
    FROM projects WHERE client_id = ${clientId} AND deal_value_aud IS NOT NULL
  `

  return {
    client,
    projects,
    contacts,
    recentActivity,
    recentEmails,
    openTasks,
    activeSessions,
    revenue,
    summary: {
      emailCount: client.email_count,
      openTasks: client.open_tasks,
      totalSessions: client.total_sessions,
      pendingRequests: client.pending_requests,
      projectCount: projects.length,
      activeProjects: projects.filter(p => p.status === 'active').length,
    },
  }
}

// ─── Revenue Tracking ────────────────────────────────────────────────

async function getRevenueOverview({ clientId, period = '30 days' } = {}) {
  const where = clientId ? db`WHERE p.client_id = ${clientId}` : db``

  const [totals] = await db`
    SELECT
      count(DISTINCT p.client_id)::int AS clients_with_deals,
      count(*)::int AS total_projects,
      COALESCE(SUM(p.deal_value_aud), 0)::numeric AS total_pipeline,
      COALESCE(SUM(CASE WHEN p.payment_status = 'paid' THEN p.deal_value_aud ELSE 0 END), 0)::numeric AS total_realized,
      COALESCE(SUM(CASE WHEN p.payment_status = 'invoiced' THEN p.deal_value_aud ELSE 0 END), 0)::numeric AS total_outstanding,
      COALESCE(SUM(CASE WHEN p.payment_status = 'overdue' THEN p.deal_value_aud ELSE 0 END), 0)::numeric AS total_overdue
    FROM projects p
    ${where}
  `

  // Revenue by stage
  const byStage = await db`
    SELECT c.stage, count(DISTINCT p.id)::int AS projects,
           COALESCE(SUM(p.deal_value_aud), 0)::numeric AS value
    FROM projects p
    JOIN clients c ON p.client_id = c.id
    WHERE p.deal_value_aud IS NOT NULL
    GROUP BY c.stage ORDER BY value DESC
  `

  return { totals, byStage }
}

// ─── Client Health Scoring ───────────────────────────────────────────
// AI-driven health score based on recent activity, response times, etc.

async function computeClientHealth(clientId) {
  const [metrics] = await db`
    SELECT
      (SELECT count(*)::int FROM crm_activity_log WHERE client_id = ${clientId} AND created_at > now() - interval '30 days') AS activities_30d,
      (SELECT count(*)::int FROM email_threads WHERE client_id = ${clientId} AND received_at > now() - interval '14 days') AS emails_14d,
      (SELECT count(*)::int FROM tasks WHERE client_id = ${clientId} AND completed_at IS NULL AND due_date < now()) AS overdue_tasks,
      (SELECT count(*)::int FROM cc_sessions WHERE client_id = ${clientId} AND status = 'error' AND started_at > now() - interval '30 days') AS failed_sessions_30d
  `

  // Simple scoring: active engagement = healthy, silence + overdue = unhealthy
  let score = 0.5  // baseline
  if (metrics.activities_30d > 5) score += 0.2
  else if (metrics.activities_30d > 0) score += 0.1
  else score -= 0.2  // no activity in 30d

  if (metrics.emails_14d > 0) score += 0.1
  if (metrics.overdue_tasks > 0) score -= 0.15 * Math.min(metrics.overdue_tasks, 3)
  if (metrics.failed_sessions_30d > 2) score -= 0.1

  score = Math.max(0, Math.min(1, score))

  await db`UPDATE clients SET health_score = ${score}, updated_at = now() WHERE id = ${clientId}`.catch(() => {})

  return { score, metrics }
}

// ─── Search ──────────────────────────────────────────────────────────

async function searchClients(query, { limit = 20 } = {}) {
  if (!query || query.trim().length < 2) return []

  const q = `%${query.trim()}%`
  return db`
    SELECT c.id, c.name, c.company, c.email, c.stage, c.priority, c.health_score,
           (SELECT count(*)::int FROM projects WHERE client_id = c.id AND status = 'active') AS active_projects,
           (SELECT count(*)::int FROM tasks WHERE client_id = c.id AND completed_at IS NULL) AS open_tasks
    FROM clients c
    WHERE c.archived_at IS NULL
      AND (c.name ILIKE ${q} OR c.company ILIKE ${q} OR c.email ILIKE ${q}
           OR EXISTS (SELECT 1 FROM crm_contacts cc WHERE cc.client_id = c.id AND (cc.name ILIKE ${q} OR cc.email ILIKE ${q})))
    ORDER BY c.updated_at DESC
    LIMIT ${limit}
  `
}

// ─── Task Management ─────────────────────────────────────────────────

async function getClientTasks(clientId, { includeCompleted = false } = {}) {
  return db`
    SELECT t.*, p.name AS project_name
    FROM tasks t
    LEFT JOIN projects p ON t.project_id = p.id
    WHERE t.client_id = ${clientId}
      ${!includeCompleted ? db`AND t.completed_at IS NULL` : db``}
    ORDER BY
      CASE t.priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END,
      t.due_date ASC NULLS LAST,
      t.created_at DESC
  `
}

async function completeTask(taskId, completedBy = 'human') {
  const [task] = await db`
    UPDATE tasks SET completed_at = now(), completed_by = ${completedBy}, status = 'completed', updated_at = now()
    WHERE id = ${taskId} AND completed_at IS NULL
    RETURNING *
  `
  if (!task) return null

  // Log to activity timeline
  if (task.client_id) {
    await logActivity({
      clientId: task.client_id,
      projectId: task.project_id,
      activityType: 'task_completed',
      title: `Task completed: ${task.title}`,
      source: 'crm',
      sourceRefId: task.id,
      sourceRefType: 'task',
      actor: completedBy,
    })
  }

  return task
}

// ─── Contact Management ──────────────────────────────────────────────

async function addContact({ clientId, name, role, email, phone, linkedinUrl, isPrimary, notes }) {
  // If setting as primary, unset other primaries
  if (isPrimary) {
    await db`UPDATE crm_contacts SET is_primary = false WHERE client_id = ${clientId}`
  }

  const [contact] = await db`
    INSERT INTO crm_contacts (client_id, name, role, email, phone, linkedin_url, is_primary, notes)
    VALUES (${clientId}, ${name}, ${role || null}, ${email || null}, ${phone || null},
            ${linkedinUrl || null}, ${!!isPrimary}, ${notes || null})
    RETURNING *
  `

  // Also update the client's primary email if this is the primary contact and client has no email
  if (isPrimary && email) {
    await db`
      UPDATE clients SET email = ${email}, updated_at = now()
      WHERE id = ${clientId} AND (email IS NULL OR email = '')
    `.catch(() => {})
  }

  return contact
}

async function getContacts(clientId) {
  return db`
    SELECT * FROM crm_contacts WHERE client_id = ${clientId}
    ORDER BY is_primary DESC, created_at
  `
}

// ─── Pipeline Analytics ──────────────────────────────────────────────

async function getPipelineAnalytics() {
  const pipeline = await db`
    SELECT c.stage,
      count(*)::int AS count,
      COALESCE(SUM(p.deal_value_aud), 0)::numeric AS total_value,
      avg(c.health_score) AS avg_health
    FROM clients c
    LEFT JOIN projects p ON p.client_id = c.id AND p.status = 'active'
    WHERE c.archived_at IS NULL
    GROUP BY c.stage
    ORDER BY CASE c.stage
      WHEN 'lead' THEN 0 WHEN 'proposal' THEN 1 WHEN 'contract' THEN 2
      WHEN 'development' THEN 3 WHEN 'live' THEN 4 WHEN 'ongoing' THEN 5
      WHEN 'archived' THEN 6 ELSE 7 END
  `

  const [velocity] = await db`
    SELECT
      count(*)::int AS stage_changes_30d,
      count(DISTINCT client_id)::int AS clients_moved_30d
    FROM pipeline_events
    WHERE created_at > now() - interval '30 days'
  `

  const recentMoves = await db`
    SELECT pe.client_id, c.name AS client_name, pe.from_stage, pe.to_stage, pe.note, pe.created_at
    FROM pipeline_events pe
    JOIN clients c ON pe.client_id = c.id
    ORDER BY pe.created_at DESC LIMIT 10
  `

  return { pipeline, velocity, recentMoves }
}

// ─── Build CRM Brief for AI ─────────────────────────────────────────

async function buildCRMBrief() {
  const [stats] = await db`
    SELECT
      count(*) FILTER (WHERE stage = 'lead')::int AS leads,
      count(*) FILTER (WHERE stage = 'proposal')::int AS proposals,
      count(*) FILTER (WHERE stage = 'contract')::int AS contracts,
      count(*) FILTER (WHERE stage = 'development')::int AS development,
      count(*) FILTER (WHERE stage = 'live')::int AS live,
      count(*) FILTER (WHERE stage = 'ongoing')::int AS ongoing,
      count(*) FILTER (WHERE archived_at IS NULL)::int AS total_active
    FROM clients
  `

  const [taskStats] = await db`
    SELECT
      count(*) FILTER (WHERE completed_at IS NULL)::int AS open,
      count(*) FILTER (WHERE completed_at IS NULL AND due_date < now())::int AS overdue,
      count(*) FILTER (WHERE completed_at IS NULL AND priority IN ('urgent', 'high'))::int AS high_priority
    FROM tasks
  `

  const lines = []
  lines.push(`Pipeline: ${stats.leads} leads, ${stats.proposals} proposals, ${stats.contracts} contracts, ${stats.development} dev, ${stats.live} live, ${stats.ongoing} ongoing (${stats.total_active} total)`)
  lines.push(`Tasks: ${taskStats.open} open, ${taskStats.overdue} overdue, ${taskStats.high_priority} high-priority`)

  return lines.join('\n')
}

module.exports = {
  logActivity,
  getClientTimeline,
  getClientIntelligence,
  getRevenueOverview,
  computeClientHealth,
  searchClients,
  getClientTasks,
  completeTask,
  addContact,
  getContacts,
  getPipelineAnalytics,
  buildCRMBrief,
}
