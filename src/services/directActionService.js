const db = require('../config/db')
const logger = require('../config/logger')
const env = require('../config/env')

// ═══════════════════════════════════════════════════════════════════════
// DIRECT ACTION SERVICE — Organism Fast-Path
//
// Executes simple integration actions without spawning a CC session.
// The organism sends {action_type, params} via symbridge, and this
// service routes it directly to the integration service.
//
// ~2 seconds instead of ~2-10 minutes through Factory.
//
// Two tiers:
//   READ  — always enabled (query_kg, get_calendar_events, etc.)
//   WRITE — gated by DIRECT_ACTION_WRITE_ENABLED env var
//
// Full audit trail in direct_actions table + KG hooks.
// ═══════════════════════════════════════════════════════════════════════

const READ_ENABLED = (env.DIRECT_ACTION_READ_ENABLED || 'true') === 'true'
const WRITE_ENABLED = (env.DIRECT_ACTION_WRITE_ENABLED || 'false') === 'true'

// Action registry: action_type → { tier, handler, description }
const ACTIONS = {
  // ── Read-only actions (always enabled) ──
  query_kg: {
    tier: 'read',
    description: 'Query the knowledge graph',
    handler: async (params) => {
      const kg = require('./knowledgeGraphService')
      return kg.getContext(params.query || params.q || '')
    },
  },
  get_calendar_events: {
    tier: 'read',
    description: 'Get upcoming calendar events',
    handler: async (params) => {
      const cal = require('./calendarService')
      return cal.getEvents ? await cal.getEvents(params) : { error: 'Calendar getEvents not available' }
    },
  },
  get_email_thread: {
    tier: 'read',
    description: 'Get an email thread by ID',
    handler: async (params) => {
      const gmail = require('./gmailService')
      return gmail.getThread ? await gmail.getThread(params.threadId) : { error: 'Gmail getThread not available' }
    },
  },
  get_drive_files: {
    tier: 'read',
    description: 'Search Google Drive files',
    handler: async (params) => {
      const drive = require('./googleDriveService')
      return drive.searchFiles ? await drive.searchFiles(params.query || '') : { error: 'Drive searchFiles not available' }
    },
  },
  get_factory_status: {
    tier: 'read',
    description: 'Get Factory session status',
    handler: async () => {
      const [active] = await db`SELECT count(*)::int AS count FROM cc_sessions WHERE status IN ('running', 'initializing')`
      const recent = await db`
        SELECT id, status, codebase_id, initial_prompt, confidence_score, started_at
        FROM cc_sessions ORDER BY started_at DESC LIMIT 5
      `
      return { active: active.count, recent }
    },
  },
  get_action_queue: {
    tier: 'read',
    description: 'Get pending action queue items',
    handler: async () => {
      const aq = require('./actionQueueService')
      return aq.getPending({ limit: 10 })
    },
  },
  get_vital_signs: {
    tier: 'read',
    description: 'Get system vital signs',
    handler: async () => {
      const vitals = require('./vitalSignsService')
      return vitals.getVitals()
    },
  },
  get_codebase_stats: {
    tier: 'read',
    description: 'Get codebase statistics',
    handler: async (params) => {
      const ci = require('./codebaseIntelligenceService')
      return ci.getCodebaseStructure ? await ci.getCodebaseStructure(params.codebaseId) : { error: 'Not available' }
    },
  },

  // ── Write actions (gated by env var) ──
  send_email: {
    tier: 'write',
    description: 'Send an email',
    handler: async (params) => {
      const gmail = require('./gmailService')
      return gmail.sendReply(params.threadId, params.draft || params.body)
    },
  },
  create_calendar_event: {
    tier: 'write',
    description: 'Create a calendar event',
    handler: async (params) => {
      const cal = require('./calendarService')
      return cal.createEvent(params.calendar || 'tate@ecodia.au', {
        summary: params.summary,
        startTime: params.startTime,
        endTime: params.endTime,
        description: params.description,
        attendees: params.attendees,
      })
    },
  },
  archive_email: {
    tier: 'write',
    description: 'Archive an email thread',
    handler: async (params) => {
      const gmail = require('./gmailService')
      return gmail.archiveThread(params.threadId)
    },
  },
  enqueue_action: {
    tier: 'write',
    description: 'Add an item to the action queue',
    handler: async (params) => {
      const aq = require('./actionQueueService')
      return aq.enqueue(params)
    },
  },
  trigger_factory_session: {
    tier: 'write',
    description: 'Trigger a Factory CC session',
    handler: async (params) => {
      const triggers = require('./factoryTriggerService')
      return triggers.dispatchFromKGInsight({
        description: params.description || params.prompt,
        context: params.context,
        suggestedAction: params.suggestedAction,
        codebaseId: params.codebaseId,
      })
    },
  },
}

// ─── Execute Direct Action ──────────────────────────────────────────

async function execute({ actionType, params = {}, correlationId, requestedBy = 'organism' }) {
  const action = ACTIONS[actionType]

  if (!action) {
    return { success: false, error: `Unknown action type: ${actionType}`, availableActions: Object.keys(ACTIONS) }
  }

  // Tier gating
  if (action.tier === 'read' && !READ_ENABLED) {
    return { success: false, error: 'Direct read actions are disabled' }
  }
  if (action.tier === 'write' && !WRITE_ENABLED) {
    return { success: false, error: 'Direct write actions are disabled (set DIRECT_ACTION_WRITE_ENABLED=true)' }
  }

  // Audit trail
  const [record] = await db`
    INSERT INTO direct_actions (action_type, params, status, requested_by, correlation_id)
    VALUES (${actionType}, ${JSON.stringify(params)}, 'executing', ${requestedBy}, ${correlationId || null})
    RETURNING id
  `

  const startTime = Date.now()
  try {
    const result = await action.handler(params)
    const durationMs = Date.now() - startTime

    await db`
      UPDATE direct_actions
      SET status = 'completed', result = ${JSON.stringify(result || {})},
          duration_ms = ${durationMs}, completed_at = now()
      WHERE id = ${record.id}
    `

    logger.info(`Direct action: ${actionType} completed in ${durationMs}ms`, { correlationId })

    // KG ingestion + event bus
    const kgHooks = require('./kgIngestionHooks')
    kgHooks.onDirectAction({ actionType, params, result, status: 'completed', durationMs }).catch(() => {})

    try {
      const eventBus = require('./internalEventBusService')
      eventBus.emit('direct:action_complete', { actionType, status: 'completed', durationMs, correlationId })
    } catch {}

    return { success: true, result, durationMs }
  } catch (err) {
    const durationMs = Date.now() - startTime

    await db`
      UPDATE direct_actions
      SET status = 'failed', result = ${JSON.stringify({ error: err.message })},
          duration_ms = ${durationMs}, completed_at = now()
      WHERE id = ${record.id}
    `

    logger.warn(`Direct action failed: ${actionType}`, { error: err.message, correlationId })

    return { success: false, error: err.message, durationMs }
  }
}

// ─── List Available Actions ─────────────────────────────────────────

function getAvailableActions() {
  return Object.entries(ACTIONS).map(([type, action]) => ({
    type,
    tier: action.tier,
    description: action.description,
    enabled: action.tier === 'read' ? READ_ENABLED : WRITE_ENABLED,
  }))
}

module.exports = {
  execute,
  getAvailableActions,
}
