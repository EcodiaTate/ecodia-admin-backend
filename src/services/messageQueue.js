/**
 * Message Queue Service
 *
 * Tate->OS inbox. Queued messages are held until os_signal_handoff fires or
 * max_age_hours elapses. Direct messages drain the queue opportunistically.
 *
 * Core flows:
 *   POST /api/os-session/message { mode: 'queue' }  -> enqueueMessage
 *   POST /api/os-session/message { mode: 'direct' } -> drainIntoDirectMessage + send
 *   MCP os_signal_handoff                           -> deliverPending
 *   Sweep cron (every 30m)                          -> sweepAged
 */

const db = require('../config/db')
const logger = require('../config/logger')
const env = require('../config/env')

// ── WS broadcast helper (lazy require to avoid circular init) ─────────────
// Frontend listens for these and invalidates ['message-queue'] so the drawer
// and pill refresh in real time instead of waiting for the next poll tick.
function broadcastQueueEvent(kind, payload) {
  try {
    const { broadcast } = require('../websocket/wsManager')
    broadcast(`message_queue:${kind}`, payload || {})
  } catch (err) {
    // WS manager can fail to load in tests / early boot. Queue mutations
    // must never be blocked by a broadcast issue.
    logger.debug(`messageQueue: broadcast failed (${kind}): ${err.message}`)
  }
}

// ── Context snapshot ─────────────────────────────────────────────────────

async function buildContextSnapshot() {
  const snapshot = {}

  try {
    const { readHandoffState } = require('./sessionHandoff')
    const handoff = await readHandoffState()
    if (handoff) snapshot.handoff_state_summary = handoff.slice(0, 500)
  } catch {}

  try {
    const [lastSession] = await db`
      SELECT id, pipeline_stage FROM cc_sessions
      ORDER BY created_at DESC LIMIT 1
    `
    if (lastSession) snapshot.last_cc_session = { id: lastSession.id, stage: lastSession.pipeline_stage }
  } catch {}

  try {
    const [topRow] = await db`
      SELECT name, status, next_action, next_action_by, priority
      FROM status_board WHERE archived_at IS NULL
      ORDER BY priority, entity_type LIMIT 1
    `
    if (topRow) snapshot.top_status_board_row = topRow
  } catch {}

  return snapshot
}

// ── Age suffix helper ────────────────────────────────────────────────────

function ageSuffix(queuedAt) {
  const ageMs = Date.now() - new Date(queuedAt).getTime()
  const ageMin = Math.round(ageMs / 60000)
  if (ageMin >= 60) {
    return `queued ${Math.floor(ageMin / 60)}h ${ageMin % 60}m ago`
  }
  return `queued ${ageMin}m ago`
}

// ── Public API ───────────────────────────────────────────────────────────

async function enqueueMessage({ body, source = 'tate', mode = 'queue', max_age_hours = 24 }) {
  const context_at_queue = await buildContextSnapshot().catch(() => ({}))

  const [row] = await db`
    INSERT INTO message_queue (body, mode, source, max_age_hours, context_at_queue)
    VALUES (${body}, ${mode}, ${source}, ${max_age_hours}, ${JSON.stringify(context_at_queue)})
    RETURNING id, queued_at
  `

  logger.info(`messageQueue: enqueued ${row.id} (source=${source}, max_age=${max_age_hours}h)`)
  broadcastQueueEvent('enqueued', { id: row.id, queued_at: row.queued_at, source })
  return row
}

async function getPending({ limit = 50 } = {}) {
  return db`
    SELECT * FROM message_queue
    WHERE delivered_at IS NULL AND cancelled_at IS NULL
    ORDER BY queued_at
    LIMIT ${limit}
  `
}

/**
 * Core handoff flow. Selects all (or filtered) pending rows inside a transaction,
 * marks them delivered, then fires a single synthesised message to the OS session.
 *
 * The OS session POST happens AFTER the transaction commits so a fetch failure
 * does not roll back the delivery records.
 */
async function deliverPending({ summary = null, turn_id = null, ids = null } = {}) {
  let pending = []
  let pendingIds = []

  await db.begin(async tx => {
    if (ids && ids.length > 0) {
      pending = await tx`
        SELECT * FROM message_queue
        WHERE id = ANY(${ids}::uuid[])
          AND delivered_at IS NULL AND cancelled_at IS NULL
        ORDER BY queued_at
        FOR UPDATE SKIP LOCKED
      `
    } else {
      pending = await tx`
        SELECT * FROM message_queue
        WHERE delivered_at IS NULL AND cancelled_at IS NULL
        ORDER BY queued_at
        FOR UPDATE SKIP LOCKED
      `
    }

    if (pending.length === 0) return

    pendingIds = pending.map(r => r.id)
    await tx`
      UPDATE message_queue
      SET delivered_at = now(), delivered_in_turn_id = ${turn_id}
      WHERE id = ANY(${pendingIds}::uuid[])
    `
  })

  if (pending.length === 0) return { delivered: 0 }

  const intro = summary
    ? `[Queued by Tate, delivering now. I just finished: ${summary}]\n\n`
    : '[Queued messages from Tate, delivering now]\n\n'

  const items = pending.map((row, i) =>
    `${i + 1}. ${row.body} (${ageSuffix(row.queued_at)})`
  )

  const messageBody = intro + items.join('\n')

  const port = env.PORT || 3001
  try {
    await fetch(`http://localhost:${port}/api/os-session/message`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: messageBody }),
      signal: AbortSignal.timeout(5_000),
    })
  } catch (err) {
    logger.warn(`messageQueue.deliverPending: OS session POST failed - ${err.message}`)
  }

  logger.info(`messageQueue: delivered ${pending.length} queued message(s) to OS session`)
  broadcastQueueEvent('delivered', { count: pending.length, ids: pendingIds })
  return { delivered: pending.length, ids: pendingIds }
}

/**
 * Drain any pending queued messages into an outgoing direct message.
 * Called from POST /api/os-session/message when mode='direct'.
 * Returns the (possibly prepended) body string.
 * All DB ops are in a transaction to prevent double-delivery races.
 */
async function drainIntoDirectMessage(directBody) {
  return await db.begin(async tx => {
    const pending = await tx`
      SELECT * FROM message_queue
      WHERE delivered_at IS NULL AND cancelled_at IS NULL
      ORDER BY queued_at
      FOR UPDATE SKIP LOCKED
    `

    if (pending.length === 0) return directBody

    const pendingIds = pending.map(r => r.id)
    await tx`
      UPDATE message_queue SET delivered_at = now()
      WHERE id = ANY(${pendingIds}::uuid[])
    `

    const items = pending.map((row, i) =>
      `${i + 1}. ${row.body} (${ageSuffix(row.queued_at)})`
    )

    const preamble = `[Pending queued messages delivered opportunistically]\n${items.join('\n')}\n---\n`
    logger.info(`messageQueue: drained ${pending.length} queued message(s) into direct send`)
    broadcastQueueEvent('delivered', { count: pending.length, ids: pendingIds, reason: 'drained_into_direct' })
    return preamble + directBody
  })
}

async function cancelMessage(id) {
  const [row] = await db`
    UPDATE message_queue SET cancelled_at = now()
    WHERE id = ${id} AND delivered_at IS NULL AND cancelled_at IS NULL
    RETURNING id
  `
  if (row) broadcastQueueEvent('cancelled', { id: row.id })
  return row || null
}

/**
 * Promote a specific message: mark promoted_at and deliver immediately.
 * deliverPending() fires its own 'delivered' broadcast, so we only emit
 * 'promoted' here for the mark-promoted state change.
 */
async function promoteNow(id) {
  const [row] = await db`
    UPDATE message_queue SET promoted_at = now()
    WHERE id = ${id} AND delivered_at IS NULL AND cancelled_at IS NULL
    RETURNING id
  `
  if (!row) return { promoted: false, delivered: 0 }
  broadcastQueueEvent('promoted', { id: row.id })
  return deliverPending({ ids: [id] })
}

/**
 * Age sweep: find messages past their max_age_hours, promote and deliver them.
 */
async function sweepAged() {
  const aged = await db`
    SELECT id FROM message_queue
    WHERE delivered_at IS NULL
      AND cancelled_at IS NULL
      AND queued_at < now() - (max_age_hours * interval '1 hour')
  `

  if (aged.length === 0) return { swept: 0 }

  const agedIds = aged.map(r => r.id)

  await db`
    UPDATE message_queue SET promoted_at = now()
    WHERE id = ANY(${agedIds}::uuid[]) AND promoted_at IS NULL
  `

  broadcastQueueEvent('swept', { count: agedIds.length, ids: agedIds })

  const result = await deliverPending({
    summary: 'age sweep - messages past their max_age_hours',
    ids: agedIds,
  })

  return { swept: result.delivered || 0 }
}

// ── Background sweep poller ──────────────────────────────────────────────

const SWEEP_INTERVAL_MS = 30 * 60 * 1000 // 30 minutes
let _sweepInterval = null

function startSweepPoller() {
  if (_sweepInterval) return
  _sweepInterval = setInterval(async () => {
    try {
      const result = await sweepAged()
      if (result.swept > 0) {
        logger.info(`messageQueue sweep: promoted and delivered ${result.swept} aged message(s)`)
      }
    } catch (err) {
      logger.warn('messageQueue sweep failed', { error: err.message })
    }
  }, SWEEP_INTERVAL_MS)
  if (typeof _sweepInterval.unref === 'function') _sweepInterval.unref()
  logger.info('Message queue sweep poller started (every 30m)')
}

function stopSweepPoller() {
  if (_sweepInterval) {
    clearInterval(_sweepInterval)
    _sweepInterval = null
  }
}

module.exports = {
  enqueueMessage,
  getPending,
  deliverPending,
  drainIntoDirectMessage,
  cancelMessage,
  promoteNow,
  sweepAged,
  startSweepPoller,
  stopSweepPoller,
  // Exported for tests
  _ageSuffix: ageSuffix,
}
