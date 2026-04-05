const logger = require('../config/logger')
const cortexService = require('./cortexService')
const contextTracking = require('./contextTrackingService')

// ═══════════════════════════════════════════════════════════════════════
// CONTEXT-AWARE CORTEX WRAPPER
//
// Sits between the route and the raw Cortex service. After Cortex
// produces its blocks, this layer filters out anything the human
// already dismissed or that references a resolved issue. The full
// context summary is still injected into the system prompt (the raw
// cortexService already does that), so the LLM *knows* about dismissed
// items — this layer is the safety net that catches anything it
// proposes anyway.
//
// Fail-open: if context tracking is unavailable, all blocks pass.
// ═══════════════════════════════════════════════════════════════════════

// ─── Item key extraction ─────────────────────────────────────────────
// Derive a canonical key for each block type so we can check it against
// the dismissed_items / resolved_issues tables.

function extractBlockItemKey(block) {
  switch (block.type) {
    case 'action_card':
      return contextTracking.buildItemKey('cortex', block.action, block.title)

    case 'email_card':
      return contextTracking.buildItemKey('gmail', 'email', block.threadId || block.subject)

    case 'task_card':
      return contextTracking.buildItemKey(block.source || 'cortex', 'task', block.title)

    case 'insight':
      // Insights are ephemeral — only filter if there's a clear identifier
      return null

    case 'cc_session':
      return contextTracking.buildItemKey('factory', 'cc_session', block.title || block.prompt?.slice(0, 80))

    case 'status_update':
    case 'text':
      // Never filter plain text or status — these are conversational
      return null

    default:
      return null
  }
}

// ─── Post-filter blocks ──────────────────────────────────────────────

async function filterBlocks(blocks) {
  if (!blocks?.length) return blocks

  // Tag each filterable block with its itemKey
  const tagged = blocks.map((block, idx) => ({
    block,
    idx,
    itemKey: extractBlockItemKey(block),
  }))

  // Split into filterable and pass-through
  const filterable = tagged.filter(t => t.itemKey)
  const passThrough = tagged.filter(t => !t.itemKey)

  if (!filterable.length) return blocks

  // Batch check against dismissed/resolved
  try {
    const surfaceable = await contextTracking.filterSurfaceable(
      filterable.map(t => ({ itemKey: t.itemKey, idx: t.idx }))
    )
    const surfaceableIdxs = new Set(surfaceable.map(s => s.idx))

    const filtered = filterable.filter(t => !surfaceableIdxs.has(t.idx))
    if (filtered.length > 0) {
      logger.info(`Context-aware Cortex: filtered ${filtered.length} block(s) — dismissed/resolved`, {
        filtered: filtered.map(t => ({ type: t.block.type, key: t.itemKey })),
      })
    }

    // Also check resolved_issues for anything that slipped through dismissals
    const stillSurfaceable = filterable.filter(t => surfaceableIdxs.has(t.idx))
    const resolvedFiltered = []
    for (const t of stillSurfaceable) {
      try {
        const resolved = await contextTracking.shouldSurface(t.itemKey)
        if (!resolved.surface) {
          resolvedFiltered.push(t)
        }
      } catch {
        // fail-open
      }
    }

    if (resolvedFiltered.length > 0) {
      logger.info(`Context-aware Cortex: filtered ${resolvedFiltered.length} additional block(s) via resolved check`, {
        filtered: resolvedFiltered.map(t => ({ type: t.block.type, key: t.itemKey })),
      })
    }

    const allFilteredIdxs = new Set([
      ...filtered.map(t => t.idx),
      ...resolvedFiltered.map(t => t.idx),
    ])

    // Rebuild in original order, minus filtered
    return tagged
      .filter(t => !allFilteredIdxs.has(t.idx))
      .map(t => t.block)
  } catch (err) {
    logger.debug('Context-aware filter failed — returning all blocks', { error: err.message })
    return blocks
  }
}

// ─── Wrapped Cortex methods ──────────────────────────────────────────

async function chat(messages, opts) {
  const result = await cortexService.chat(messages, opts)
  result.blocks = await filterBlocks(result.blocks)
  return result
}

async function getLoadBriefing() {
  const result = await cortexService.getLoadBriefing()
  result.blocks = await filterBlocks(result.blocks)
  return result
}

async function chatAndExecute(messages, opts) {
  const result = await cortexService.chatAndExecute(messages, opts)
  result.blocks = await filterBlocks(result.blocks)
  return result
}

// ─── Pass-through exports ────────────────────────────────────────────
// Everything else delegates directly to cortexService — we only wrap
// the methods that produce output blocks.

module.exports = {
  chat,
  chatAndExecute,
  getLoadBriefing,
  executeAction: cortexService.executeAction,
  persistExchange: cortexService.persistExchange,
  getSessionHistory: cortexService.getSessionHistory,
  listSessions: cortexService.listSessions,
}
