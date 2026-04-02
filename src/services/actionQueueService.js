const db = require('../config/db')
const logger = require('../config/logger')
const { broadcast } = require('../websocket/wsManager')

// ═══════════════════════════════════════════════════════════════════════
// ACTION QUEUE SERVICE — With Redis Pub/Sub
//
// Unified queue for pre-processed actionable items from every integration.
// The system does the thinking — triage, draft, classify, prepare data.
// You just approve or dismiss.
//
// Every source (Gmail, LinkedIn, Meta, Calendar, Factory) enqueues items.
// The dashboard surfaces them. One tap executes.
//
// FREEDOM UPGRADE: Redis pub/sub for real-time event streaming.
// Postgres remains source of truth. Redis is additive.
// Services and the organism can subscribe to action events.
// ═══════════════════════════════════════════════════════════════════════

// Lazy Redis — shared with symbridge
let redis = null
function getRedis() {
  if (redis) return redis
  try {
    const env = require('../config/env')
    if (!env.REDIS_URL) return null
    const Redis = require('ioredis')
    redis = new Redis(env.REDIS_URL, { maxRetriesPerRequest: 3, lazyConnect: true })
    redis.connect().catch(() => { redis = null })
    return redis
  } catch { return null }
}

function publishRedis(event, data) {
  const r = getRedis()
  if (!r) return
  r.publish('ecodiaos:action_events', JSON.stringify({ event, ...data, timestamp: new Date().toISOString() })).catch(() => {})
}

function emitEvent(type, payload) {
  try {
    const eventBus = require('./internalEventBusService')
    eventBus.emit(type, payload)
  } catch {}
}

// ─── Enqueue ───────────────────────────────────────────────────────────

async function enqueue({ source, sourceRefId, actionType, title, summary, preparedData, context, priority, expiresInHours }) {
  // ── Consolidation: merge into existing pending item if same source + similar topic ──
  const merged = await tryConsolidate({ source, sourceRefId, actionType, title, summary, preparedData, context, priority })
  if (merged) return merged

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

  // Redis pub/sub + event bus
  publishRedis('new', { id: item.id, source: item.source, actionType: item.action_type, title: item.title, priority: item.priority })
  emitEvent('action:enqueued', { id: item.id, source: item.source, actionType: item.action_type, title: item.title, priority: item.priority })

  return item
}

// ─── Consolidation: merge duplicate signals into one action ───────────

const PRIORITY_RANK = { urgent: 0, high: 1, medium: 2, low: 3 }

async function tryConsolidate({ source, sourceRefId, actionType, title, summary, preparedData, context, priority }) {
  // Find pending items from same source with same sender (via context.email or context.from)
  const senderEmail = context?.email
  const senderName = context?.from

  if (!senderEmail && !senderName) return null

  // Look for pending items from same source + same sender in last 7 days
  const candidates = await db`
    SELECT * FROM action_queue
    WHERE source = ${source}
      AND status = 'pending'
      AND (expires_at IS NULL OR expires_at > now())
      AND created_at > now() - interval '7 days'
    ORDER BY created_at DESC
    LIMIT 20
  `

  // Find a match: same sender email or same sender name with similar context
  const match = candidates.find(c => {
    const cCtx = c.context || {}
    // Must be from the same person
    if (senderEmail && cCtx.email === senderEmail) return true
    if (senderName && cCtx.from === senderName) return true
    return false
  })

  if (!match) return null

  // Merge: keep the existing item but update with latest info
  const existingConsolidated = match.context?.consolidated_count || 1
  const newCount = existingConsolidated + 1

  // Escalate priority if the new signal is higher priority
  const effectivePriority = (PRIORITY_RANK[priority] ?? 2) < (PRIORITY_RANK[match.priority] ?? 2)
    ? priority
    : match.priority

  // Keep the most recent draft/summary, accumulate source refs
  const mergedSourceRefs = [...(match.context?.source_ref_ids || [match.source_ref_id]), sourceRefId].filter(Boolean)
  const mergedContext = {
    ...match.context,
    ...context,
    consolidated_count: newCount,
    source_ref_ids: mergedSourceRefs,
    latest_signal_at: new Date().toISOString(),
  }

  // Use latest prepared data (most recent draft is most relevant)
  const mergedPreparedData = { ...(match.prepared_data || {}), ...preparedData }

  const [updated] = await db`
    UPDATE action_queue SET
      summary = ${summary || match.summary},
      prepared_data = ${JSON.stringify(mergedPreparedData)},
      context = ${JSON.stringify(mergedContext)},
      priority = ${effectivePriority},
      updated_at = now()
    WHERE id = ${match.id}
    RETURNING *
  `

  logger.info(`Consolidated action queue item ${match.id}: ${title} (${newCount} signals from ${senderEmail || senderName})`)

  broadcast('action_queue:updated', {
    id: updated.id,
    source: updated.source,
    actionType: updated.action_type,
    title: updated.title,
    summary: updated.summary,
    priority: updated.priority,
    consolidatedCount: newCount,
  })

  return updated
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

    // Redis pub/sub + event bus
    publishRedis('executed', { id: actionId, actionType: item.action_type, result: result?.message })
    emitEvent('action:executed', { id: actionId, source: item.source, actionType: item.action_type, result: result?.message })

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
  publishRedis('dismissed', { id: actionId })
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

// ─── Pending items for a sender (used by triage for context) ──────────

async function getPendingForSender(email, name) {
  if (!email && !name) return []
  return db`
    SELECT title, summary, priority, created_at, context FROM action_queue
    WHERE status = 'pending'
      AND (expires_at IS NULL OR expires_at > now())
      AND (
        (context->>'email' = ${email || ''})
        OR (context->>'from' = ${name || ''})
      )
    ORDER BY created_at DESC
    LIMIT 5
  `
}

module.exports = {
  enqueue,
  execute,
  dismiss,
  getPending,
  getPendingForSender,
  getRecent,
  getStats,
  expireStale,
}
