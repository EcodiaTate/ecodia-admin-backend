const db = require('../config/db')
const logger = require('../config/logger')
const env = require('../config/env')
const { broadcast } = require('../websocket/wsManager')

// ═══════════════════════════════════════════════════════════════════════
// ACTION QUEUE SERVICE — Decision Intelligence Engine
//
// Not a notification inbox. A learning decision-support system.
//
// Every integration enqueues candidate actions. Before surfacing:
//  1. Decision memory is checked — has the user historically dismissed
//     this kind of item? If so, suppress or downgrade priority.
//  2. Semantic consolidation — items are merged by topic similarity,
//     not just sender identity. Two emails about "invoicing" merge;
//     two from the same person about different topics stay separate.
//  3. Resource locking — batch execute groups by target resource to
//     prevent concurrent mutations against the same entity.
//  4. Default expiry — nothing lives forever. 48h default.
//
// Every approval and dismissal is recorded in action_decisions with
// structured reasons. These accumulate into suppression signals that
// feed back into triage, closing the learning loop.
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

// ─── Constants ────────────────────────────────────────────────────────

const PRIORITY_RANK = { urgent: 0, high: 1, medium: 2, low: 3 }
const VALID_PRIORITIES = new Set(['urgent', 'high', 'medium', 'low'])
const DEFAULT_EXPIRY_HOURS = parseInt(env.ACTION_QUEUE_DEFAULT_EXPIRY_HOURS || '48', 10)

// Suppression thresholds — after N consecutive dismissals of the same
// (source, action_type, sender) pattern with no approvals, auto-suppress
const SUPPRESSION_THRESHOLD = parseInt(env.ACTION_QUEUE_SUPPRESSION_THRESHOLD || '4', 10)
const SUPPRESSION_LOOKBACK_DAYS = parseInt(env.ACTION_QUEUE_SUPPRESSION_LOOKBACK_DAYS || '30', 10)

// Dismissal suppression window — context-aware, not flat
const DISMISSAL_WINDOW_DEFAULT_HOURS = 2
const DISMISSAL_WINDOW_URGENT_HOURS = 0 // urgent items always surface

// ─── Decision Memory ─────────────────────────────────────────────────
// Records every approval/dismissal for pattern analysis.
// This is the core learning mechanism.

async function recordDecision(action, decision, { reasonCategory, reasonDetail } = {}) {
  try {
    const timeToDecision = action.created_at
      ? Math.round((Date.now() - new Date(action.created_at).getTime()) / 1000)
      : null

    await db`
      INSERT INTO action_decisions (
        action_id, decision, reason_category, reason_detail,
        source, action_type, sender_email, sender_name,
        priority_when_surfaced, title, time_to_decision_seconds
      ) VALUES (
        ${action.id}, ${decision}, ${reasonCategory || null}, ${reasonDetail || null},
        ${action.source}, ${action.action_type},
        ${action.context?.email || null}, ${action.context?.from || null},
        ${action.priority}, ${action.title}, ${timeToDecision}
      )
    `
  } catch (err) {
    logger.debug('Decision recording failed (non-blocking)', { error: err.message })
  }
}

// ─── Suppression Intelligence ────────────────────────────────────────
// Queries decision history to determine if an item should be suppressed,
// downgraded, or surfaced as normal.
//
// Returns: { suppress: bool, adjustedPriority: string|null, reason: string|null }

async function evaluateSuppression({ source, actionType, senderEmail, senderName, priority }) {
  try {
    // Get recent decision history for this pattern
    const history = await db`
      SELECT decision, reason_category, created_at
      FROM action_decisions
      WHERE source = ${source}
        AND action_type = ${actionType}
        AND (
          (${senderEmail || ''} != '' AND sender_email = ${senderEmail || ''})
          OR (${senderName || ''} != '' AND sender_name = ${senderName || ''})
          OR (${senderEmail || ''} = '' AND ${senderName || ''} = '' AND sender_email IS NULL AND sender_name IS NULL)
        )
        AND created_at > now() - interval '1 day' * ${SUPPRESSION_LOOKBACK_DAYS}
      ORDER BY created_at DESC
      LIMIT 20
    `

    if (history.length === 0) return { suppress: false, adjustedPriority: null, reason: null }

    const totalDecisions = history.length
    const dismissals = history.filter(h => h.decision === 'dismissed').length
    const executions = history.filter(h => h.decision === 'executed').length
    const dismissRate = dismissals / totalDecisions

    // Count consecutive recent dismissals (streak)
    let consecutiveDismissals = 0
    for (const h of history) {
      if (h.decision === 'dismissed') consecutiveDismissals++
      else break
    }

    // Hard suppress: N+ consecutive dismissals with no recent approvals
    if (consecutiveDismissals >= SUPPRESSION_THRESHOLD) {
      return {
        suppress: true,
        adjustedPriority: null,
        reason: `${consecutiveDismissals} consecutive dismissals (${senderEmail || senderName || actionType})`,
      }
    }

    // Priority downgrade: >70% dismiss rate but not enough for full suppression
    if (dismissRate > 0.7 && totalDecisions >= 3) {
      const currentRank = PRIORITY_RANK[priority] ?? 2
      const downgraded = currentRank < 3 ? Object.entries(PRIORITY_RANK).find(([, r]) => r === currentRank + 1)?.[0] : 'low'
      return {
        suppress: false,
        adjustedPriority: downgraded || 'low',
        reason: `${Math.round(dismissRate * 100)}% dismiss rate (${dismissals}/${totalDecisions})`,
      }
    }

    // Priority upgrade: >80% execute rate — the user consistently acts on these
    if (executions / totalDecisions > 0.8 && totalDecisions >= 3) {
      const currentRank = PRIORITY_RANK[priority] ?? 2
      const upgraded = currentRank > 0 ? Object.entries(PRIORITY_RANK).find(([, r]) => r === currentRank - 1)?.[0] : 'urgent'
      return {
        suppress: false,
        adjustedPriority: upgraded || priority,
        reason: `${Math.round((executions / totalDecisions) * 100)}% execute rate — consistently acted on`,
      }
    }

    return { suppress: false, adjustedPriority: null, reason: null }
  } catch (err) {
    logger.debug('Suppression evaluation failed (non-blocking)', { error: err.message })
    return { suppress: false, adjustedPriority: null, reason: null }
  }
}

// ─── Sender Reputation ───────────────────────────────────────────────
// Aggregated decision stats for a sender across all sources/types.
// Used by triage services to inform surfacing decisions.

async function getSenderReputation(email, name) {
  if (!email && !name) return null
  try {
    const [stats] = await db`
      SELECT
        count(*)::int AS total,
        count(*) FILTER (WHERE decision = 'executed')::int AS executed,
        count(*) FILTER (WHERE decision = 'dismissed')::int AS dismissed,
        mode() WITHIN GROUP (ORDER BY reason_category) FILTER (WHERE decision = 'dismissed') AS top_dismiss_reason,
        EXTRACT(EPOCH FROM avg(make_interval(secs => time_to_decision_seconds)) FILTER (WHERE decision = 'executed'))::int AS avg_time_to_execute_seconds,
        min(created_at) AS first_seen,
        max(created_at) AS last_seen
      FROM action_decisions
      WHERE (
        (${email || ''} != '' AND sender_email = ${email || ''})
        OR (${name || ''} != '' AND sender_name = ${name || ''})
      )
      AND created_at > now() - interval '90 days'
    `

    if (!stats || stats.total === 0) return null

    return {
      total: stats.total,
      executed: stats.executed,
      dismissed: stats.dismissed,
      executeRate: stats.total > 0 ? Math.round((stats.executed / stats.total) * 100) : 0,
      dismissRate: stats.total > 0 ? Math.round((stats.dismissed / stats.total) * 100) : 0,
      topDismissReason: stats.top_dismiss_reason,
      avgTimeToExecuteSeconds: stats.avg_time_to_execute_seconds,
      firstSeen: stats.first_seen,
      lastSeen: stats.last_seen,
    }
  } catch (err) {
    logger.debug('Sender reputation query failed', { error: err.message })
    return null
  }
}

// ─── Decision History ────────────────────────────────────────────────
// Recent decisions for dashboard introspection

async function getDecisionHistory({ limit = 30, source, actionType, decision } = {}) {
  return db`
    SELECT * FROM action_decisions
    WHERE TRUE
      ${source ? db`AND source = ${source}` : db``}
      ${actionType ? db`AND action_type = ${actionType}` : db``}
      ${decision ? db`AND decision = ${decision}` : db``}
    ORDER BY created_at DESC
    LIMIT ${limit}
  `
}

// ─── Decision Stats (aggregate patterns) ─────────────────────────────

async function getDecisionStats() {
  try {
    const patterns = await db`
      SELECT
        source, action_type, sender_email,
        count(*)::int AS total,
        count(*) FILTER (WHERE decision = 'executed')::int AS executed,
        count(*) FILTER (WHERE decision = 'dismissed')::int AS dismissed,
        mode() WITHIN GROUP (ORDER BY reason_category) FILTER (WHERE decision = 'dismissed') AS top_dismiss_reason,
        max(created_at) AS last_decision
      FROM action_decisions
      WHERE created_at > now() - interval '30 days'
      GROUP BY source, action_type, sender_email
      HAVING count(*) >= 2
      ORDER BY count(*) DESC
      LIMIT 50
    `

    const suppressed = patterns.filter(p => {
      const dismissRate = p.dismissed / p.total
      return dismissRate >= 0.75 && p.total >= SUPPRESSION_THRESHOLD
    })

    return { patterns, suppressed, total: patterns.length }
  } catch (err) {
    logger.debug('Decision stats query failed', { error: err.message })
    return { patterns: [], suppressed: [], total: 0 }
  }
}

// ─── Enqueue ───────────────────────────────────────────────────────────

async function enqueue({ source, sourceRefId, actionType, title, summary, preparedData, context, priority, expiresInHours, resourceKey }) {
  // ── Priority validation: only accept known values ──
  const validatedPriority = VALID_PRIORITIES.has(priority) ? priority : 'medium'

  // ── Suppression check: has the user historically dismissed this pattern? ──
  const suppression = await evaluateSuppression({
    source,
    actionType,
    senderEmail: context?.email,
    senderName: context?.from,
    priority: validatedPriority,
  })

  if (suppression.suppress) {
    logger.info(`Action queue: suppressed "${title}" — ${suppression.reason}`)
    emitEvent('action:suppressed', { source, actionType, title, reason: suppression.reason })
    return null
  }

  // Apply priority adjustment from decision history
  const effectivePriority = suppression.adjustedPriority || validatedPriority
  if (suppression.adjustedPriority) {
    logger.info(`Action queue: priority adjusted ${validatedPriority}→${effectivePriority} for "${title}" — ${suppression.reason}`)
  }

  // ── Dismissal cooldown: don't re-surface items from same sender shortly after dismissal ──
  // Urgent items always bypass — if something genuinely urgent comes in 5 minutes after
  // a dismissal, it must surface.
  if (effectivePriority !== 'urgent' && (context?.email || context?.from)) {
    const senderEmail = context?.email
    const senderName = context?.from
    const recentDismissal = await db`
      SELECT id FROM action_queue
      WHERE source = ${source}
        AND status = 'dismissed'
        AND (
          (${senderEmail || ''} != '' AND context->>'email' = ${senderEmail || ''})
          OR (${senderName || ''} != '' AND context->>'from' = ${senderName || ''})
        )
        AND (context->>'dismissed_at')::timestamptz > now() - interval '1 hour' * ${DISMISSAL_WINDOW_DEFAULT_HOURS}
      LIMIT 1
    `
    if (recentDismissal.length > 0) {
      logger.info(`Action queue: dismissal cooldown for "${title}" — same sender dismissed recently`)
      emitEvent('action:suppressed', { source, actionType, title, reason: 'dismissal_cooldown' })
      return null
    }
  }

  // ── Consolidation: merge into existing pending item if semantically related ──
  const merged = await tryConsolidate({ source, sourceRefId, actionType, title, summary, preparedData, context, priority: effectivePriority, resourceKey })
  if (merged) return merged

  // ── Default expiry: nothing lives forever ──
  const expiresAt = expiresInHours
    ? new Date(Date.now() + expiresInHours * 60 * 60 * 1000).toISOString()
    : new Date(Date.now() + DEFAULT_EXPIRY_HOURS * 60 * 60 * 1000).toISOString()

  // ── Derive resource key if not provided ──
  const derivedResourceKey = resourceKey || deriveResourceKey(source, actionType, sourceRefId, preparedData)

  const [item] = await db`
    INSERT INTO action_queue (source, source_ref_id, action_type, title, summary, prepared_data, context, priority, expires_at, resource_key)
    VALUES (${source}, ${sourceRefId || null}, ${actionType}, ${title}, ${summary || null},
            ${JSON.stringify(preparedData || {})},
            ${JSON.stringify({ ...(context || {}), suppression_evaluation: suppression.reason || null })},
            ${effectivePriority}, ${expiresAt}, ${derivedResourceKey})
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

// ─── Resource Key Derivation ─────────────────────────────────────────
// Maps action items to their target resource for conflict detection.

function deriveResourceKey(source, actionType, sourceRefId, preparedData) {
  if (sourceRefId) return `${source}:${actionType}:${sourceRefId}`
  // For actions without a ref, use the target entity from prepared data
  if (preparedData?.threadId) return `gmail:thread:${preparedData.threadId}`
  if (preparedData?.leadId) return `crm:lead:${preparedData.leadId}`
  if (preparedData?.taskId) return `crm:task:${preparedData.taskId}`
  if (preparedData?.eventId) return `calendar:event:${preparedData.eventId}`
  // Singleton resources (only one can run at a time)
  if (actionType === 'sync_xero') return 'xero:sync:global'
  if (actionType === 'trigger_vercel_build') return `vercel:build:${preparedData?.project || 'default'}`
  return null
}

// ─── Consolidation: semantic merge, not just sender dedup ────────────

async function tryConsolidate({ source, sourceRefId, actionType, title, summary, preparedData, context, priority, resourceKey }) {
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

  if (candidates.length === 0) return null

  // ── Semantic matching: multi-signal scoring ──
  // Score each candidate. Highest score wins. Threshold prevents bad merges.
  const scored = candidates.map(c => {
    const cCtx = c.context || {}
    let score = 0
    let signals = []

    // Signal 1: Same sender (strong)
    if (senderEmail && cCtx.email === senderEmail) { score += 40; signals.push('sender_email') }
    else if (senderName && cCtx.from === senderName) { score += 30; signals.push('sender_name') }

    // Signal 2: Same action type (moderate)
    if (c.action_type === actionType) { score += 25; signals.push('action_type') }

    // Signal 3: Same resource key (strong — literally the same target)
    const candidateResourceKey = c.resource_key || deriveResourceKey(c.source, c.action_type, c.source_ref_id, c.prepared_data)
    const incomingResourceKey = resourceKey || deriveResourceKey(source, actionType, sourceRefId, preparedData)
    if (incomingResourceKey && candidateResourceKey === incomingResourceKey) { score += 45; signals.push('resource_key') }

    // Signal 4: Title similarity (topic overlap via word intersection)
    const titleSimilarity = computeTitleSimilarity(title, c.title)
    if (titleSimilarity > 0.5) { score += Math.round(titleSimilarity * 30); signals.push(`title_sim:${titleSimilarity.toFixed(2)}`) }

    // Signal 5: Same source_ref_id (exact same entity)
    if (sourceRefId && c.source_ref_id === sourceRefId) { score += 50; signals.push('source_ref') }

    // Penalty: different action types from same sender = probably different decisions
    if (senderEmail && cCtx.email === senderEmail && c.action_type !== actionType) { score -= 20; signals.push('different_action_penalty') }

    return { candidate: c, score, signals }
  })

  // Sort by score descending, require minimum threshold
  scored.sort((a, b) => b.score - a.score)
  const best = scored[0]

  // Threshold: at least 50 points to merge (prevents merging unrelated items from same sender)
  if (!best || best.score < 50) return null

  const match = best.candidate

  // Merge: keep the existing item but update with latest info
  const existingConsolidated = match.context?.consolidated_count || 1
  const newCount = existingConsolidated + 1

  // Escalate priority if the new signal is higher priority
  const effectivePriority = (PRIORITY_RANK[priority] ?? 2) < (PRIORITY_RANK[match.priority] ?? 2)
    ? priority
    : match.priority

  // Keep the most recent draft/summary, accumulate source refs and merge signals
  const existingCtx = match.context || {}
  const mergedSourceRefs = [...(existingCtx.source_ref_ids || [match.source_ref_id]), sourceRefId].filter(Boolean)
  const mergedContext = {
    ...existingCtx,
    ...(context || {}),
    consolidated_count: newCount,
    source_ref_ids: mergedSourceRefs,
    latest_signal_at: new Date().toISOString(),
    merge_signals: best.signals,
    merge_score: best.score,
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

  logger.info(`Consolidated action queue item ${match.id}: ${title} (${newCount} signals, score:${best.score}, signals:[${best.signals.join(',')}])`)

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

// ─── Title Similarity (Jaccard on significant words) ─────────────────

function computeTitleSimilarity(a, b) {
  if (!a || !b) return 0
  const stopwords = new Set(['the', 'a', 'an', 'is', 'to', 'from', 'for', 'and', 'or', 'of', 'in', 'on', 'at', 'by', 'no', 're'])
  const tokenize = s => new Set(s.toLowerCase().replace(/[^a-z0-9\s]/g, '').split(/\s+/).filter(w => w.length > 2 && !stopwords.has(w)))
  const setA = tokenize(a)
  const setB = tokenize(b)
  if (setA.size === 0 || setB.size === 0) return 0
  let intersection = 0
  for (const w of setA) { if (setB.has(w)) intersection++ }
  return intersection / (setA.size + setB.size - intersection) // Jaccard index
}

// ─── Execute (approve + act) ───────────────────────────────────────────

async function execute(actionId) {
  // Atomically claim the item
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

    // Record decision + KG ingestion
    recordDecision(item, 'executed').catch(() => {})
    const kgHooks = require('./kgIngestionHooks')
    kgHooks.onActionExecuted({ action: item, result }).catch(() => {})

    return result
  } catch (err) {
    await db`UPDATE action_queue SET status = 'pending', error_message = ${err.message} WHERE id = ${actionId}`
    throw err
  }
}

// ─── Perform the actual action — via CapabilityRegistry ───────────────

const ACTION_TYPE_ALIASES = {
  send_reply: 'send_email_reply',
  publish_post: 'publish_meta_post',
  send_meta_message: 'send_meta_message',
  reply_to_comment: 'reply_to_meta_comment',
  schedule_meeting: 'create_calendar_event',
  create_doc: 'create_doc',
  send_linkedin_reply: 'send_linkedin_reply',
  create_lead: 'create_lead',
  create_task: 'create_task',
  sync_xero: 'sync_xero',
  start_cc_session: 'start_cc_session',
  trigger_vercel_build: 'trigger_vercel_build',
  follow_up: 'create_task',
}

async function performAction(item) {
  const data = item.prepared_data || {}
  const ctx = item.context || {}

  const rawType = item.action_type
  const capabilityName = ACTION_TYPE_ALIASES[rawType] || rawType

  const params = {
    ...data,
    _sourceRefId: item.source_ref_id,
    _source: item.source,
    _priority: item.priority,
    _context: ctx,
  }

  if (rawType === 'follow_up' && !params.title) {
    params.title = `Follow up: ${data.subject || ctx.from || 'pending item'}`
    params.description = data.notes || item.summary
    params.priority = item.priority || 'medium'
    params.source = item.source || 'ai'
  }

  if (rawType === 'send_reply' && !params.threadId) {
    params.threadId = item.source_ref_id
  }

  const registry = require('./capabilityRegistry')

  if (!registry.has(capabilityName)) {
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

async function dismiss(actionId, { reason, reasonCategory, reasonDetail } = {}) {
  const [item] = await db`
    UPDATE action_queue
    SET status = 'dismissed', updated_at = now(),
        context = COALESCE(context, '{}'::jsonb) || ${JSON.stringify({
          dismissed_reason: reason || reasonDetail || null,
          dismissed_reason_category: reasonCategory || null,
          dismissed_at: new Date().toISOString(),
        })}::jsonb
    WHERE id = ${actionId} AND status = 'pending'
    RETURNING *
  `
  broadcast('action_queue:dismissed', { id: actionId })
  publishRedis('dismissed', { id: actionId })
  emitEvent('action:dismissed', { id: actionId, reason: reason || null, reasonCategory: reasonCategory || null })

  if (item) {
    // Record structured decision
    recordDecision(item, 'dismissed', { reasonCategory, reasonDetail: reason || reasonDetail }).catch(() => {})

    const kgHooks = require('./kgIngestionHooks')
    kgHooks.onActionDismissed({ action: item, reason: reason || reasonDetail, reasonCategory }).catch(() => {})
  }
}

// ─── Batch Dismiss (single SQL) ──────────────────────────────────────

async function batchDismiss(ids, { reason, reasonCategory, reasonDetail } = {}) {
  if (!ids?.length) return 0
  const dismissed = await db`
    UPDATE action_queue
    SET status = 'dismissed', updated_at = now(),
        context = COALESCE(context, '{}'::jsonb) || ${JSON.stringify({
          dismissed_reason: reason || reasonDetail || null,
          dismissed_reason_category: reasonCategory || null,
          dismissed_at: new Date().toISOString(),
        })}::jsonb
    WHERE id = ANY(${ids}) AND status = 'pending'
    RETURNING *
  `
  const kgHooks = require('./kgIngestionHooks')
  for (const item of dismissed) {
    broadcast('action_queue:dismissed', { id: item.id })
    publishRedis('dismissed', { id: item.id })
    emitEvent('action:dismissed', { id: item.id, reason: reason || null, reasonCategory: reasonCategory || null })
    recordDecision(item, 'dismissed', { reasonCategory, reasonDetail: reason || reasonDetail }).catch(() => {})
    kgHooks.onActionDismissed({ action: item, reason: reason || reasonDetail, reasonCategory }).catch(() => {})
  }
  return dismissed.length
}

// ─── Batch Execute (resource-aware, concurrency-limited) ─────────────
// Groups by resource_key so actions targeting the same entity execute
// serially, while independent resources execute in parallel.

async function batchExecute(ids, { concurrency = 3 } = {}) {
  if (!ids?.length) return { succeeded: 0, failed: 0, results: [] }

  // Fetch all items with resource keys
  const items = await db`
    SELECT id, resource_key, priority FROM action_queue
    WHERE id = ANY(${ids}) AND status = 'pending'
    ORDER BY
      CASE priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 WHEN 'low' THEN 3 END,
      created_at ASC
  `

  // Group by resource_key — items sharing a resource must serialize
  const resourceGroups = new Map()
  const ungrouped = []

  for (const item of items) {
    if (item.resource_key) {
      if (!resourceGroups.has(item.resource_key)) {
        resourceGroups.set(item.resource_key, [])
      }
      resourceGroups.get(item.resource_key).push(item.id)
    } else {
      ungrouped.push(item.id)
    }
  }

  const results = []
  let succeeded = 0
  let failed = 0

  // Execute each resource group serially (within group), parallel across groups
  const groupExecutors = []

  // Each resource group becomes a serial chain
  for (const [, groupIds] of resourceGroups) {
    groupExecutors.push(async () => {
      const groupResults = []
      for (const id of groupIds) {
        try {
          const result = await execute(id)
          groupResults.push({ status: 'fulfilled', value: result })
        } catch (err) {
          groupResults.push({ status: 'rejected', reason: err.message || 'unknown' })
        }
      }
      return groupResults
    })
  }

  // Ungrouped items can all run in parallel (chunked by concurrency)
  for (let i = 0; i < ungrouped.length; i += concurrency) {
    const chunk = ungrouped.slice(i, i + concurrency)
    groupExecutors.push(async () => {
      const chunkResults = await Promise.allSettled(chunk.map(id => execute(id)))
      return chunkResults.map(r => r.status === 'fulfilled'
        ? { status: 'fulfilled', value: r.value }
        : { status: 'rejected', reason: r.reason?.message || 'unknown' }
      )
    })
  }

  // Run all group executors with concurrency limit
  for (let i = 0; i < groupExecutors.length; i += concurrency) {
    const batch = groupExecutors.slice(i, i + concurrency)
    const batchResults = await Promise.allSettled(batch.map(fn => fn()))
    for (const br of batchResults) {
      const groupResults = br.status === 'fulfilled' ? br.value : [{ status: 'rejected', reason: br.reason?.message || 'unknown' }]
      for (const r of groupResults) {
        results.push(r)
        if (r.status === 'fulfilled') succeeded++
        else failed++
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
      EXTRACT(EPOCH FROM (now() - min(created_at) FILTER (WHERE status = 'pending' AND (expires_at IS NULL OR expires_at > now()))))::int AS oldest_pending_seconds,
      EXTRACT(EPOCH FROM (now() - avg(created_at) FILTER (WHERE status = 'pending' AND (expires_at IS NULL OR expires_at > now()))))::int AS avg_wait_seconds,
      EXTRACT(EPOCH FROM avg(executed_at - created_at) FILTER (WHERE status = 'executed' AND executed_at > now() - interval '24 hours'))::int AS avg_execution_latency_seconds,
      count(*) FILTER (WHERE status = 'pending' AND error_message IS NOT NULL)::int AS pending_with_errors
    FROM action_queue
  `

  // Augment with decision intelligence stats
  let decisionIntel = null
  try {
    const [intel] = await db`
      SELECT
        count(*) FILTER (WHERE decision = 'executed' AND created_at > now() - interval '24 hours')::int AS approved_24h,
        count(*) FILTER (WHERE decision = 'dismissed' AND created_at > now() - interval '24 hours')::int AS dismissed_24h,
        count(DISTINCT CASE WHEN decision = 'dismissed' THEN source || ':' || action_type || ':' || COALESCE(sender_email, '') END)
          FILTER (WHERE created_at > now() - interval '7 days')::int AS unique_dismiss_patterns_7d,
        EXTRACT(EPOCH FROM avg(make_interval(secs => time_to_decision_seconds)) FILTER (WHERE created_at > now() - interval '24 hours'))::int AS avg_decision_time_24h
      FROM action_decisions
    `
    decisionIntel = intel
  } catch {}

  return { ...stats, decisionIntel }
}

// ─── Expire stale items ────────────────────────────────────────────────

async function expireStale() {
  const expired = await db`
    UPDATE action_queue SET status = 'expired'
    WHERE status = 'pending' AND expires_at IS NOT NULL AND expires_at < now()
    RETURNING *
  `
  if (expired.length > 0) {
    logger.info(`Action queue: expired ${expired.length} stale items`)
    broadcast('action_queue:expired', { count: expired.length, ids: expired.map(i => i.id) })
    // Record expiry decisions for pattern analysis
    for (const item of expired) {
      recordDecision(item, 'expired').catch(() => {})
      emitEvent('action:expired', { id: item.id, source: item.source, actionType: item.action_type })
    }
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
    RETURNING *
  `
  if (expired.length > 0) {
    logger.info(`Action queue: manually purged ${expired.length} expired items`)
    broadcast('action_queue:expired', { count: expired.length })
    for (const item of expired) {
      recordDecision(item, 'expired').catch(() => {})
    }
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
  // Decision intelligence exports
  evaluateSuppression,
  getSenderReputation,
  getDecisionHistory,
  getDecisionStats,
  recordDecision,
}
