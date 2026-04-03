const db = require('../config/db')
const logger = require('../config/logger')
const env = require('../config/env')
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
  const senderEmail = context?.email
  const senderName = context?.from

  // Look for pending items from same source in last 7 days
  const candidates = await db`
    SELECT * FROM action_queue
    WHERE source = ${source}
      AND status = 'pending'
      AND (expires_at IS NULL OR expires_at > now())
      AND created_at > now() - interval '7 days'
    ORDER BY created_at DESC
    LIMIT 20
  `

  // If this sender had an item dismissed in the last 2 hours, don't immediately
  // re-consolidate into a new one — let a fresh item be created so it surfaces again.
  if (senderEmail || senderName) {
    const recentDismissal = await db`
      SELECT id FROM action_queue
      WHERE source = ${source}
        AND status = 'dismissed'
        AND (
          (${senderEmail || ''} != '' AND context->>'email' = ${senderEmail || ''})
          OR (${senderName || ''} != '' AND context->>'from' = ${senderName || ''})
        )
        AND (context->>'dismissed_at')::timestamptz > now() - interval '2 hours'
      LIMIT 1
    `
    if (recentDismissal.length > 0) return null
  }

  if (candidates.length === 0) return null

  // Find a match:
  //  1. Same sender (email or name) — classic dedup for Gmail / LinkedIn
  //  2. Same action_type with no sender context — dedup for Meta/Factory/Vercel signals
  const match = candidates.find(c => {
    const cCtx = c.context || {}
    // Sender-based merge (strongest signal)
    if (senderEmail && cCtx.email === senderEmail) return true
    if (senderName && cCtx.from === senderName) return true
    // Topic-based merge: same action_type from same source, no personal sender context
    // (avoids merging unrelated items just because they're from the same integration)
    if (!senderEmail && !senderName && !cCtx.email && !cCtx.from) {
      return c.action_type === actionType
    }
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
  const existingCtx = match.context || {}
  const mergedSourceRefs = [...(existingCtx.source_ref_ids || [match.source_ref_id]), sourceRefId].filter(Boolean)
  const mergedContext = {
    ...existingCtx,
    ...(context || {}),
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

  logger.info(`Consolidated action queue item ${match.id}: ${title} (${newCount} signals${senderEmail || senderName ? ` from ${senderEmail || senderName}` : ` by action_type:${actionType}`})`)

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
  // Atomically claim the item: SELECT + UPDATE in one query to avoid race conditions
  // and reduce DB round trips from 3 to 2
  const [item] = await db`
    UPDATE action_queue
    SET status = 'approved', approved_at = now()
    WHERE id = ${actionId} AND status = 'pending'
    RETURNING *
  `
  if (!item) throw new Error('Action not found or already handled')

  try {
    const result = await performAction(item)

    await db`UPDATE action_queue SET status = 'executed', executed_at = now() WHERE id = ${actionId}`

    broadcast('action_queue:executed', { id: actionId, result })

    const resultSummary = result?.message || (result ? Object.keys(result).join(', ') : 'ok')
    publishRedis('executed', { id: actionId, actionType: item.action_type, result: resultSummary })
    emitEvent('action:executed', { id: actionId, source: item.source, actionType: item.action_type, result: resultSummary })

    const kgHooks = require('./kgIngestionHooks')
    kgHooks.onActionExecuted({ action: item, result }).catch(() => {})

    return result
  } catch (err) {
    await db`UPDATE action_queue SET status = 'pending', error_message = ${err.message} WHERE id = ${actionId}`
    throw err
  }
}

// ─── Perform the actual action — via CapabilityRegistry ───────────────
//
// No switch statement. The action_type maps directly to a registered
// capability. The registry knows how to execute it.
//
// The action item's prepared_data IS the params. Source ref ID is
// injected as a hint for capabilities that need it (e.g. send_reply).
//
// Legacy action type aliases: some integrations still enqueue with old
// names (send_reply, publish_post). We normalise them to canonical names.

const ACTION_TYPE_ALIASES = {
  // Gmail
  send_reply: 'send_email_reply',
  // Meta
  publish_post: 'publish_meta_post',
  send_meta_message: 'send_meta_message',   // same name
  reply_to_comment: 'reply_to_meta_comment',
  // Calendar
  schedule_meeting: 'create_calendar_event',
  // Drive
  create_doc: 'create_doc',                  // same
  // Social
  send_linkedin_reply: 'send_linkedin_reply', // same
  // CRM
  create_lead: 'create_lead',                // same
  create_task: 'create_task',                // same
  // Finance
  sync_xero: 'sync_xero',                   // same
  // Factory
  start_cc_session: 'start_cc_session',      // same
  trigger_vercel_build: 'trigger_vercel_build', // same
  // Legacy follow_up → create_task
  follow_up: 'create_task',
}

async function performAction(item) {
  const data = item.prepared_data || {}
  const ctx = item.context || {}

  // Resolve canonical capability name
  const rawType = item.action_type
  const capabilityName = ACTION_TYPE_ALIASES[rawType] || rawType

  // Inject source ref as a parameter hint (capabilities may use it)
  const params = {
    ...data,
    _sourceRefId: item.source_ref_id,
    _source: item.source,
    _priority: item.priority,
    _context: ctx,
  }

  // Special-case: follow_up becomes create_task with synthesised title
  if (rawType === 'follow_up' && !params.title) {
    params.title = `Follow up: ${data.subject || ctx.from || 'pending item'}`
    params.description = data.notes || item.summary
    params.priority = item.priority || 'medium'
    params.source = item.source || 'ai'
  }

  // For send_reply: threadId comes from source_ref_id
  if (rawType === 'send_reply' && !params.threadId) {
    params.threadId = item.source_ref_id
  }

  const registry = require('./capabilityRegistry')

  if (!registry.has(capabilityName)) {
    // Unknown capability — don't throw, log and return structured error
    // The system should degrade gracefully
    logger.warn(`ActionQueue: unknown capability "${capabilityName}" (raw: "${rawType}") — available: ${
      registry.list({ enabledOnly: true }).map(c => c.name).join(', ')
    }`)
    return { message: `Action type "${rawType}" is not registered. The system will learn to handle this.`, unhandled: true }
  }

  const outcome = await registry.execute(capabilityName, params, { source: 'action_queue', item })

  if (!outcome.success) {
    throw new Error(outcome.error || `Capability "${capabilityName}" failed`)
  }

  return outcome.result || { message: `${capabilityName} executed` }
}

// ─── Dismiss ───────────────────────────────────────────────────────────

async function dismiss(actionId, { reason } = {}) {
  const [item] = await db`
    UPDATE action_queue
    SET status = 'dismissed', updated_at = now(),
        context = context || ${JSON.stringify({ dismissed_reason: reason || null, dismissed_at: new Date().toISOString() })}
    WHERE id = ${actionId} AND status = 'pending'
    RETURNING *
  `
  broadcast('action_queue:dismissed', { id: actionId })
  publishRedis('dismissed', { id: actionId })
  emitEvent('action:dismissed', { id: actionId, reason: reason || null })

  if (item) {
    const kgHooks = require('./kgIngestionHooks')
    kgHooks.onActionDismissed({ action: item, reason }).catch(() => {})
  }
}

// ─── Batch Dismiss (single SQL) ──────────────────────────────────────

async function batchDismiss(ids, { reason } = {}) {
  if (!ids?.length) return 0
  const dismissed = await db`
    UPDATE action_queue
    SET status = 'dismissed', updated_at = now(),
        context = context || ${JSON.stringify({ dismissed_reason: reason || null, dismissed_at: new Date().toISOString() })}
    WHERE id = ANY(${ids}) AND status = 'pending'
    RETURNING *
  `
  const kgHooks = require('./kgIngestionHooks')
  for (const item of dismissed) {
    broadcast('action_queue:dismissed', { id: item.id })
    publishRedis('dismissed', { id: item.id })
    emitEvent('action:dismissed', { id: item.id, reason: reason || null })
    kgHooks.onActionDismissed({ action: item, reason }).catch(() => {})
  }
  return dismissed.length
}

// ─── Batch Execute (concurrency-limited, priority-ordered) ───────────

async function batchExecute(ids, { concurrency = 3 } = {}) {
  if (!ids?.length) return { succeeded: 0, failed: 0, results: [] }

  // Fetch all items and sort by priority so urgent items execute first
  const items = await db`
    SELECT id FROM action_queue
    WHERE id = ANY(${ids}) AND status = 'pending'
    ORDER BY
      CASE priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 WHEN 'low' THEN 3 END,
      created_at ASC
  `
  const orderedIds = items.map(i => i.id)

  const results = []
  let succeeded = 0
  let failed = 0

  // Process in chunks to avoid overwhelming external APIs
  for (let i = 0; i < orderedIds.length; i += concurrency) {
    const chunk = orderedIds.slice(i, i + concurrency)
    const chunkResults = await Promise.allSettled(chunk.map(id => execute(id)))
    for (const r of chunkResults) {
      if (r.status === 'fulfilled') {
        succeeded++
        results.push({ status: 'fulfilled', value: r.value })
      } else {
        failed++
        results.push({ status: 'rejected', reason: r.reason?.message || 'unknown' })
      }
    }
  }

  return { succeeded, failed, results }
}

// ─── Query ─────────────────────────────────────────────────────────────

async function getPending({ limit = 20, priority, source } = {}) {
  return db`
    SELECT * FROM action_queue
    WHERE status = 'pending'
      AND (expires_at IS NULL OR expires_at > now())
      ${priority ? db`AND priority = ${priority}` : db``}
      ${source ? db`AND source = ${source}` : db``}
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
      count(*) FILTER (WHERE status = 'dismissed' AND created_at > now() - interval '24 hours')::int AS dismissed_24h,
      -- Queue health: how long items have been waiting
      EXTRACT(EPOCH FROM (now() - min(created_at) FILTER (WHERE status = 'pending' AND (expires_at IS NULL OR expires_at > now()))))::int AS oldest_pending_seconds,
      EXTRACT(EPOCH FROM (now() - avg(created_at) FILTER (WHERE status = 'pending' AND (expires_at IS NULL OR expires_at > now()))))::int AS avg_wait_seconds,
      -- Execution throughput: avg time from creation to execution in last 24h
      EXTRACT(EPOCH FROM avg(executed_at - created_at) FILTER (WHERE status = 'executed' AND executed_at > now() - interval '24 hours'))::int AS avg_execution_latency_seconds,
      -- Error rate: items that failed and were reset to pending
      count(*) FILTER (WHERE status = 'pending' AND error_message IS NOT NULL)::int AS pending_with_errors
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

// purgeExpired — public alias for manual trigger via route
async function purgeExpired() {
  const expired = await db`
    UPDATE action_queue SET status = 'expired'
    WHERE status = 'pending' AND expires_at IS NOT NULL AND expires_at < now()
    RETURNING id
  `
  if (expired.length > 0) {
    logger.info(`Action queue: manually purged ${expired.length} expired items`)
    broadcast('action_queue:expired', { count: expired.length })
  }
  return expired.length
}

module.exports = {
  enqueue,
  execute,
  dismiss,
  batchDismiss,
  batchExecute,
  getPending,
  getPendingForSender,
  getRecent,
  getStats,
  expireStale,
  purgeExpired,
}
