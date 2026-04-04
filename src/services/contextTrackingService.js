const logger = require('../config/logger')
const queries = require('../db/queries/contextTracking')

// ═══════════════════════════════════════════════════════════════════════
// CONTEXT TRACKING SERVICE
//
// Persistent memory for the Cortex: what was dismissed, what was resolved,
// what the human prefers, and what topics are being tracked. This is the
// filter that prevents the system from being annoying — re-surfacing
// things the human already dealt with, re-investigating solved problems,
// or violating stated preferences.
//
// Every suggestion, action card, and investigation should pass through
// shouldSurface() before reaching the human.
// ═══════════════════════════════════════════════════════════════════════

/**
 * Build a canonical item key for dedup/lookup.
 * Format: source:type:identifier
 */
function buildItemKey(source, type, identifier) {
  return `${source || 'system'}:${type || 'generic'}:${identifier || 'unknown'}`
}

/**
 * Check whether an item should be surfaced to the human.
 * Returns { surface: boolean, reason: string }
 */
async function shouldSurface(itemKey) {
  try {
    const dismissed = await queries.isDismissed(itemKey)
    if (dismissed) {
      return { surface: false, reason: 'dismissed' }
    }

    const resolved = await queries.isResolved(itemKey)
    if (resolved) {
      return { surface: false, reason: 'resolved' }
    }

    return { surface: true, reason: 'no_prior_context' }
  } catch (err) {
    logger.debug('Context tracking check failed — surfacing by default', { itemKey, error: err.message })
    return { surface: true, reason: 'check_failed' }
  }
}

/**
 * Batch check: filter an array of items, returning only those that should be surfaced.
 * Each item must have an `itemKey` property.
 */
async function filterSurfaceable(items) {
  if (!items?.length) return []

  const keys = items.map(i => i.itemKey).filter(Boolean)
  if (!keys.length) return items

  try {
    const dismissedSet = await queries.isDismissedBulk(keys)

    return items.filter(item => {
      if (!item.itemKey) return true
      return !dismissedSet.has(item.itemKey)
    })
  } catch (err) {
    logger.debug('Context tracking bulk filter failed — returning all', { error: err.message })
    return items
  }
}

/**
 * Dismiss an item — mark it as dealt with so it won't be re-surfaced.
 */
async function dismiss({ source, actionType, identifier, title, reason, metadata, expiresAt, permanent }) {
  const itemKey = buildItemKey(source, actionType, identifier)
  return queries.dismissItem({
    itemType: actionType || 'generic',
    itemKey,
    title,
    reason,
    source,
    sourceRefId: identifier,
    metadata,
    expiresAt,
    permanent: permanent || false,
  })
}

/**
 * Mark an issue as resolved with resolution details.
 */
async function resolve({ source, issueType, identifier, title, description, resolution, resolvedBy, sessionId, metadata }) {
  const issueKey = buildItemKey(source, issueType, identifier)
  return queries.resolveIssue({
    issueKey,
    title,
    description,
    resolution,
    resolvedBy,
    sessionId,
    metadata,
  })
}

/**
 * Reopen a previously resolved issue (e.g. it recurred).
 */
async function reopen({ source, issueType, identifier }) {
  const issueKey = buildItemKey(source, issueType, identifier)
  return queries.reopenIssue(issueKey)
}

/**
 * Undismiss an item — allow it to be surfaced again.
 */
async function undismiss({ source, actionType, identifier }) {
  const itemKey = buildItemKey(source, actionType, identifier)
  return queries.undismiss(itemKey)
}

/**
 * Get a context summary for the Cortex system prompt.
 * Returns a compact text block of active preferences and recent dismissals.
 */
async function getContextSummary() {
  try {
    const [preferences, recentDismissals, activeTopics] = await Promise.all([
      queries.getPreferences({ active: true }),
      queries.getDismissedItems({ limit: 20 }),
      queries.getActiveContexts({ limit: 10 }),
    ])

    const parts = []

    if (preferences.length > 0) {
      parts.push('User preferences/boundaries:')
      for (const p of preferences) {
        parts.push(`  [${p.category}] ${p.description}`)
      }
    }

    if (recentDismissals.length > 0) {
      parts.push(`Recently dismissed (${recentDismissals.length} items):`)
      for (const d of recentDismissals.slice(0, 10)) {
        parts.push(`  - ${d.item_key}${d.reason ? ` (${d.reason})` : ''}`)
      }
    }

    if (activeTopics.length > 0) {
      parts.push('Active conversation topics:')
      for (const t of activeTopics) {
        parts.push(`  - ${t.topic}${t.summary ? `: ${t.summary}` : ''}`)
      }
    }

    return parts.length > 0 ? parts.join('\n') : ''
  } catch (err) {
    logger.debug('Context summary generation failed', { error: err.message })
    return ''
  }
}

module.exports = {
  buildItemKey,
  shouldSurface,
  filterSurfaceable,
  dismiss,
  resolve,
  reopen,
  undismiss,
  getContextSummary,
  // Pass-through for direct access
  setPreference: queries.setPreference,
  getPreference: queries.getPreference,
  getPreferences: queries.getPreferences,
  removePreference: queries.removePreference,
  upsertConversationContext: queries.upsertConversationContext,
  updateConversationContext: queries.updateConversationContext,
  getActiveContexts: queries.getActiveContexts,
  getRecentContexts: queries.getRecentContexts,
  getDismissedItems: queries.getDismissedItems,
  getResolvedIssues: queries.getResolvedIssues,
}
