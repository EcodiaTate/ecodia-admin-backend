const db = require('../config/db')
const logger = require('../config/logger')
const { broadcast } = require('../websocket/wsManager')

// ═══════════════════════════════════════════════════════════════════════
// ACTION QUEUE SERVICE
//
// Unified queue for pre-processed actionable items from every integration.
// The system does the thinking — triage, draft, classify, prepare data.
// You just approve or dismiss.
//
// Every source (Gmail, LinkedIn, Meta, Calendar, Factory) enqueues items.
// The dashboard surfaces them. One tap executes.
// ═══════════════════════════════════════════════════════════════════════

// ─── Enqueue ───────────────────────────────────────────────────────────

async function enqueue({ source, sourceRefId, actionType, title, summary, preparedData, context, priority, expiresInHours }) {
  const expiresAt = expiresInHours
    ? new Date(Date.now() + expiresInHours * 60 * 60 * 1000).toISOString()
    : null

  const [item] = await db`
    INSERT INTO action_queue (source, source_ref_id, action_type, title, summary, prepared_data, context, priority, expires_at)
    VALUES (${source}, ${sourceRefId || null}, ${actionType}, ${title}, ${summary || null},
            ${JSON.stringify(preparedData || {})}, ${JSON.stringify(context || {})},
            ${priority || 'medium'}, ${expiresAt})
    RETURNING *
  `

  // Broadcast to dashboard
  broadcast('action_queue:new', {
    id: item.id,
    source: item.source,
    actionType: item.action_type,
    title: item.title,
    summary: item.summary,
    priority: item.priority,
  })

  return item
}

// ─── Execute (approve + act) ───────────────────────────────────────────

async function execute(actionId) {
  const [item] = await db`
    SELECT * FROM action_queue WHERE id = ${actionId} AND status = 'pending'
  `
  if (!item) throw new Error('Action not found or already handled')

  await db`UPDATE action_queue SET status = 'approved', approved_at = now() WHERE id = ${actionId}`

  try {
    const result = await performAction(item)

    await db`UPDATE action_queue SET status = 'executed', executed_at = now() WHERE id = ${actionId}`

    broadcast('action_queue:executed', { id: actionId, result })

    // KG learning signal
    const kgHooks = require('./kgIngestionHooks')
    kgHooks.onActionExecuted({ action: item, result }).catch(() => {})

    return result
  } catch (err) {
    await db`UPDATE action_queue SET status = 'pending', error_message = ${err.message} WHERE id = ${actionId}`
    throw err
  }
}

// ─── Perform the actual action ─────────────────────────────────────────

async function performAction(item) {
  const data = item.prepared_data || {}
  const ctx = item.context || {}

  switch (item.action_type) {
    // ── Email actions ──
    case 'send_reply': {
      const gmailService = require('./gmailService')
      await gmailService.sendReply(item.source_ref_id, data.draft)
      return { message: `Reply sent to ${ctx.from || 'thread'}` }
    }

    case 'archive_email': {
      const gmailService = require('./gmailService')
      await gmailService.archiveThread(item.source_ref_id)
      return { message: 'Email archived' }
    }

    // ── LinkedIn actions ──
    case 'send_linkedin_reply': {
      const linkedinService = require('./linkedinService')
      await linkedinService.sendReply(item.source_ref_id, data.draft)
      return { message: `LinkedIn reply sent to ${ctx.participantName || 'contact'}` }
    }

    case 'create_lead': {
      const clientQueries = require('../db/queries/clients')
      const client = await clientQueries.createClient({
        name: data.name,
        company: data.company || null,
        email: data.email || null,
        stage: 'lead',
        priority: data.leadScore > 0.7 ? 'high' : 'medium',
        notes: [{ content: data.notes || ctx.summary, createdAt: new Date().toISOString(), source: 'linkedin' }],
      })
      return { message: `Lead created: ${data.name}`, clientId: client.id }
    }

    // ── Meta actions ──
    case 'publish_post': {
      const metaService = require('./metaService')
      const result = await metaService.publishPost(data.pageId, {
        message: data.message,
        link: data.link,
        imageUrl: data.imageUrl,
      })
      return { message: `Posted to ${result.pageName}`, postId: result.postId }
    }

    case 'send_meta_message': {
      const metaService = require('./metaService')
      const result = await metaService.sendMessage(item.source_ref_id, data.message)
      return { message: 'Messenger reply sent', messageId: result.messageId }
    }

    case 'reply_to_comment': {
      const metaService = require('./metaService')
      const result = await metaService.replyToComment(data.commentId, data.pageId, data.message)
      return { message: 'Comment reply posted' }
    }

    // ── Calendar actions ──
    case 'schedule_meeting': {
      const calendarService = require('./calendarService')
      const event = await calendarService.createEvent(data.calendar || 'tate@ecodia.au', {
        summary: data.summary,
        startTime: data.startTime,
        endTime: data.endTime,
        description: data.description,
        attendees: data.attendees,
      })
      return { message: `Meeting scheduled: ${data.summary}` }
    }

    // ── Drive actions ──
    case 'create_doc': {
      const driveService = require('./googleDriveService')
      const doc = await driveService.createDocument(data.account || 'tate@ecodia.au', {
        title: data.title,
        content: data.content,
      })
      return { message: `Document created: ${data.title}`, documentId: doc.documentId }
    }

    // ── Task creation (universal fallback) ──
    case 'create_task': {
      const { createTask } = require('../db/queries/tasks')
      const task = await createTask({
        title: data.title,
        description: data.description,
        source: item.source,
        sourceRefId: item.source_ref_id,
        priority: item.priority,
      })
      return { message: `Task created: ${data.title}`, taskId: task.id }
    }

    // ── Follow-up (generic reminder) ──
    case 'follow_up': {
      const { createTask } = require('../db/queries/tasks')
      const task = await createTask({
        title: `Follow up: ${data.subject || ctx.from || 'item'}`,
        description: data.notes || item.summary,
        source: item.source,
        sourceRefId: item.source_ref_id,
        priority: item.priority || 'medium',
      })
      return { message: `Follow-up task created`, taskId: task.id }
    }

    default:
      throw new Error(`Unknown action type: ${item.action_type}`)
  }
}

// ─── Dismiss ───────────────────────────────────────────────────────────

async function dismiss(actionId) {
  await db`UPDATE action_queue SET status = 'dismissed' WHERE id = ${actionId} AND status = 'pending'`
  broadcast('action_queue:dismissed', { id: actionId })
}

// ─── Query ─────────────────────────────────────────────────────────────

async function getPending({ limit = 20 } = {}) {
  return db`
    SELECT * FROM action_queue
    WHERE status = 'pending'
      AND (expires_at IS NULL OR expires_at > now())
    ORDER BY
      CASE priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 WHEN 'low' THEN 3 END,
      created_at DESC
    LIMIT ${limit}
  `
}

async function getRecent({ limit = 10 } = {}) {
  return db`
    SELECT * FROM action_queue
    WHERE status IN ('executed', 'dismissed')
    ORDER BY COALESCE(executed_at, approved_at, created_at) DESC
    LIMIT ${limit}
  `
}

async function getStats() {
  const [stats] = await db`
    SELECT
      count(*) FILTER (WHERE status = 'pending' AND (expires_at IS NULL OR expires_at > now()))::int AS pending,
      count(*) FILTER (WHERE status = 'pending' AND priority IN ('urgent', 'high'))::int AS urgent,
      count(*) FILTER (WHERE status = 'executed' AND executed_at > now() - interval '24 hours')::int AS executed_24h,
      count(*) FILTER (WHERE status = 'dismissed' AND created_at > now() - interval '24 hours')::int AS dismissed_24h
    FROM action_queue
  `
  return stats
}

// ─── Expire stale items ────────────────────────────────────────────────

async function expireStale() {
  const expired = await db`
    UPDATE action_queue SET status = 'expired'
    WHERE status = 'pending' AND expires_at IS NOT NULL AND expires_at < now()
    RETURNING id
  `
  if (expired.length > 0) {
    logger.info(`Action queue: expired ${expired.length} stale items`)
  }
}

module.exports = {
  enqueue,
  execute,
  dismiss,
  getPending,
  getRecent,
  getStats,
  expireStale,
}
