const registry = require('../services/capabilityRegistry')

// ═══════════════════════════════════════════════════════════════════════
// CONTEXT TRACKING CAPABILITIES
//
// Let the Cortex and organism dismiss items, resolve issues, set
// preferences, and check whether something should be surfaced — all
// through the standard capability registry.
// ═══════════════════════════════════════════════════════════════════════

registry.registerMany([
  {
    name: 'dismiss_item',
    description: 'Dismiss an item so it won\'t be re-surfaced (action, suggestion, notification, alert).',
    tier: 'write',
    domain: 'context',
    params: {
      source: { type: 'string', required: true, description: 'Integration/service that produced it (gmail, factory, cortex, etc.)' },
      actionType: { type: 'string', required: true, description: 'Type of item (action, suggestion, notification, alert, insight)' },
      identifier: { type: 'string', required: true, description: 'Unique identifier for the item' },
      title: { type: 'string', required: false, description: 'Display title' },
      reason: { type: 'string', required: false, description: 'Why it was dismissed' },
      permanent: { type: 'boolean', required: false, description: 'True = never resurface' },
    },
    handler: async (params) => {
      const ctx = require('../services/contextTrackingService')
      const result = await ctx.dismiss(params)
      return { message: result ? `Dismissed: ${params.source}:${params.actionType}:${params.identifier}` : 'Already dismissed' }
    },
  },

  {
    name: 'resolve_issue',
    description: 'Mark an issue as resolved with details so the system won\'t re-investigate it.',
    tier: 'write',
    domain: 'context',
    params: {
      source: { type: 'string', required: true, description: 'Where the issue originated' },
      issueType: { type: 'string', required: true, description: 'Type of issue' },
      identifier: { type: 'string', required: true, description: 'Unique identifier' },
      title: { type: 'string', required: true, description: 'Issue title' },
      resolution: { type: 'string', required: false, description: 'How it was resolved' },
      resolvedBy: { type: 'string', required: false, description: 'Who resolved it (human, factory, cortex)' },
    },
    handler: async (params) => {
      const ctx = require('../services/contextTrackingService')
      const result = await ctx.resolve(params)
      return { message: result ? `Resolved: ${params.title}` : 'Already resolved' }
    },
  },

  {
    name: 'set_user_preference',
    description: 'Record a user preference or boundary (e.g. "don\'t auto-reply on LinkedIn", "prefer concise briefings").',
    tier: 'write',
    domain: 'context',
    params: {
      category: { type: 'string', required: true, description: 'Category: boundary, preference, workflow, notification' },
      key: { type: 'string', required: true, description: 'Unique key for dedup' },
      description: { type: 'string', required: true, description: 'Human-readable description' },
    },
    handler: async (params) => {
      const ctx = require('../services/contextTrackingService')
      const result = await ctx.setPreference(params)
      return { message: `Preference saved: ${result.description}` }
    },
  },

  {
    name: 'check_should_surface',
    description: 'Check if an item should be surfaced to the human (not dismissed or resolved).',
    tier: 'read',
    domain: 'context',
    params: {
      source: { type: 'string', required: true, description: 'Integration/service' },
      type: { type: 'string', required: true, description: 'Item type' },
      identifier: { type: 'string', required: true, description: 'Unique identifier' },
    },
    handler: async (params) => {
      const ctx = require('../services/contextTrackingService')
      const itemKey = ctx.buildItemKey(params.source, params.type, params.identifier)
      return ctx.shouldSurface(itemKey)
    },
  },

  {
    name: 'get_context_summary',
    description: 'Get a summary of user preferences, recent dismissals, and active topics for awareness.',
    tier: 'read',
    domain: 'context',
    handler: async () => {
      const ctx = require('../services/contextTrackingService')
      const summary = await ctx.getContextSummary()
      return { summary: summary || 'No persistent context recorded yet.' }
    },
  },
])
