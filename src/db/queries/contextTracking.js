const db = require('../../config/db')

// ─── Dismissed Items ────────────────────────────────────────────────────

async function dismissItem({ itemType, itemKey, title, reason, source, sourceRefId, metadata, expiresAt, permanent }) {
  const [item] = await db`
    INSERT INTO dismissed_items (item_type, item_key, title, reason, source, source_ref_id, metadata, expires_at, permanent)
    VALUES (${itemType}, ${itemKey}, ${title || null}, ${reason || null}, ${source || null},
            ${sourceRefId || null}, ${JSON.stringify(metadata || {})}, ${expiresAt || null}, ${permanent || false})
    ON CONFLICT DO NOTHING
    RETURNING *
  `
  return item
}

async function isDismissed(itemKey) {
  const [row] = await db`
    SELECT id FROM dismissed_items
    WHERE item_key = ${itemKey}
      AND (permanent = true OR expires_at IS NULL OR expires_at > now())
    LIMIT 1
  `
  return !!row
}

async function isDismissedBulk(itemKeys) {
  if (!itemKeys.length) return new Set()
  const rows = await db`
    SELECT DISTINCT item_key FROM dismissed_items
    WHERE item_key = ANY(${itemKeys})
      AND (permanent = true OR expires_at IS NULL OR expires_at > now())
  `
  return new Set(rows.map(r => r.item_key))
}

async function getDismissedItems({ itemType, source, limit = 50, offset = 0 } = {}) {
  return db`
    SELECT * FROM dismissed_items
    WHERE (permanent = true OR expires_at IS NULL OR expires_at > now())
      ${itemType ? db`AND item_type = ${itemType}` : db``}
      ${source ? db`AND source = ${source}` : db``}
    ORDER BY dismissed_at DESC
    LIMIT ${limit} OFFSET ${offset}
  `
}

async function undismiss(itemKey) {
  const [removed] = await db`
    DELETE FROM dismissed_items WHERE item_key = ${itemKey} RETURNING *
  `
  return removed
}

// ─── Resolved Issues ────────────────────────────────────────────────────

async function resolveIssue({ issueKey, title, description, resolution, resolvedBy, sessionId, metadata }) {
  const [issue] = await db`
    INSERT INTO resolved_issues (issue_key, title, description, resolution, resolved_by, session_id, metadata)
    VALUES (${issueKey}, ${title}, ${description || null}, ${resolution || null},
            ${resolvedBy || 'human'}, ${sessionId || null}, ${JSON.stringify(metadata || {})})
    ON CONFLICT DO NOTHING
    RETURNING *
  `
  return issue
}

async function isResolved(issueKey) {
  const [row] = await db`
    SELECT id FROM resolved_issues
    WHERE issue_key = ${issueKey} AND status = 'resolved'
    LIMIT 1
  `
  return !!row
}

async function reopenIssue(issueKey) {
  const [issue] = await db`
    UPDATE resolved_issues
    SET status = 'reopened', reopened_at = now()
    WHERE issue_key = ${issueKey} AND status = 'resolved'
    RETURNING *
  `
  return issue
}

async function getResolvedIssues({ status, limit = 50, offset = 0 } = {}) {
  return db`
    SELECT * FROM resolved_issues
    ${status ? db`WHERE status = ${status}` : db``}
    ORDER BY resolved_at DESC
    LIMIT ${limit} OFFSET ${offset}
  `
}

// ─── User Preferences ───────────────────────────────────────────────────

async function setPreference({ category, key, description, value, source }) {
  const [pref] = await db`
    INSERT INTO user_preferences (category, key, description, value, source)
    VALUES (${category}, ${key}, ${description}, ${JSON.stringify(value || {})}, ${source || 'human'})
    ON CONFLICT (key) DO UPDATE SET
      description = EXCLUDED.description,
      value = EXCLUDED.value,
      category = EXCLUDED.category,
      source = EXCLUDED.source,
      active = true,
      updated_at = now()
    RETURNING *
  `
  return pref
}

async function getPreference(key) {
  const [pref] = await db`
    SELECT * FROM user_preferences WHERE key = ${key} AND active = true
  `
  return pref
}

async function getPreferences({ category, active = true } = {}) {
  return db`
    SELECT * FROM user_preferences
    WHERE active = ${active}
      ${category ? db`AND category = ${category}` : db``}
    ORDER BY updated_at DESC
  `
}

async function removePreference(key) {
  const [pref] = await db`
    UPDATE user_preferences SET active = false, updated_at = now()
    WHERE key = ${key}
    RETURNING *
  `
  return pref
}

// ─── Conversation Context ───────────────────────────────────────────────

async function upsertConversationContext({ topic, summary, status, sessionId, relatedItems }) {
  const [ctx] = await db`
    INSERT INTO conversation_context (topic, summary, status, session_ids, related_items, last_mentioned)
    VALUES (${topic}, ${summary || null}, ${status || 'active'},
            ${sessionId ? db`ARRAY[${sessionId}]::uuid[]` : db`'{}'::uuid[]`},
            ${JSON.stringify(relatedItems || {})}, now())
    RETURNING *
  `
  return ctx
}

async function updateConversationContext(id, { summary, status, sessionId, relatedItems }) {
  const [ctx] = await db`
    UPDATE conversation_context SET
      ${summary !== undefined ? db`summary = ${summary},` : db``}
      ${status ? db`status = ${status},` : db``}
      ${sessionId ? db`session_ids = array_append(session_ids, ${sessionId}),` : db``}
      ${relatedItems ? db`related_items = related_items || ${JSON.stringify(relatedItems)},` : db``}
      last_mentioned = now(),
      updated_at = now()
    WHERE id = ${id}
    RETURNING *
  `
  return ctx
}

async function getActiveContexts({ limit = 20 } = {}) {
  return db`
    SELECT * FROM conversation_context
    WHERE status = 'active'
    ORDER BY last_mentioned DESC
    LIMIT ${limit}
  `
}

async function getRecentContexts({ limit = 10 } = {}) {
  return db`
    SELECT * FROM conversation_context
    ORDER BY last_mentioned DESC
    LIMIT ${limit}
  `
}

module.exports = {
  dismissItem, isDismissed, isDismissedBulk, getDismissedItems, undismiss,
  resolveIssue, isResolved, reopenIssue, getResolvedIssues,
  setPreference, getPreference, getPreferences, removePreference,
  upsertConversationContext, updateConversationContext, getActiveContexts, getRecentContexts,
}
