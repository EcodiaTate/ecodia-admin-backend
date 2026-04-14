const env = require('./config/env')
const app = require('./app')
const { createServer } = require('http')
const { initWS } = require('./websocket/wsManager')
const db = require('./config/db')
const logger = require('./config/logger')

// ── Boot: Capability Registry ────────────────────────────────────────
// Must load BEFORE server.listen() so that incoming requests never hit
// an empty registry during the boot window.
try {
  require('./capabilities/index')
} catch (err) {
  logger.error('Capability registry failed to boot - actions will not work', { error: err.message })
}

const server = createServer(app)
initWS(app, server)

// Voice relay — Twilio ConversationRelay WebSocket + TwiML
const { initVoiceRelay } = require('./routes/voiceRelay')
initVoiceRelay(app)

// Track open connections so we can force-destroy them on shutdown.
// Without this, server.close() hangs on long-lived WebSocket connections
// and PM2 SIGKILLs the process before process.exit() fires → orphans.
const openConnections = new Set()
server.on('connection', (conn) => {
  openConnections.add(conn)
  conn.on('close', () => openConnections.delete(conn))
})

// Orphan cleanup has moved to factoryRunner - it owns CC session lifecycle.

// Graceful shutdown - registered at module level so it fires regardless of
// whether the server has finished starting. PM2 sends SIGTERM on restart/delete
// and SIGINT in some shutdown paths.
let shuttingDown = false
async function gracefulShutdown(signal) {
  if (shuttingDown) return // Prevent double-shutdown from SIGTERM+SIGINT race
  shuttingDown = true
  logger.info(`${signal} received - shutting down`)

  // CC sessions now run in the separate ecodia-factory process.
  // No session drain needed - that's the entire point of the separation.
  // Shutdown the bridge subscriber cleanly.
  try {
    const bridge = require('./services/factoryBridge')
    await bridge.shutdown()
  } catch {}

  try {
    const maintenance = require('./workers/autonomousMaintenanceWorker')
    maintenance.stop()
  } catch {}

  try {
    const schedulerPoller = require('./services/schedulerPollerService')
    schedulerPoller.stop()
  } catch {}

  try {
    const tokenRefresh = require('./services/claudeTokenRefreshService')
    tokenRefresh.stop()
  } catch {}

  // Force-destroy open connections (especially WebSockets) so server.close()
  // doesn't hang waiting for them to end. Without this, PM2 SIGKILLs the
  // process at kill_timeout and sessions that weren't yet marked in DB become orphans.
  for (const conn of openConnections) {
    try { conn.destroy() } catch {}
  }

  // Close the DB connection pool - prevents connection leaks across restarts
  // and ensures in-flight queries complete before the process exits.
  try { await db.end({ timeout: 5 }) } catch {}

  server.close(() => process.exit(0))

  // Hard exit fallback - if server.close() still hangs (e.g. connections
  // that survive destroy()), exit before PM2's 12s kill_timeout SIGKILLs us
  setTimeout(() => {
    logger.warn('Graceful shutdown timed out - forcing exit')
    process.exit(1)
  }, 11000).unref()
}
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'))
process.on('SIGINT', () => gracefulShutdown('SIGINT'))

// Crash handlers - without these, uncaught errors kill the process
// without triggering SIGTERM/SIGINT, leaving sessions orphaned in DB.
process.on('uncaughtException', async (err) => {
  logger.error('Uncaught exception - triggering graceful shutdown', { error: err.message, stack: err.stack })
  await gracefulShutdown('uncaughtException').catch(() => {})
  process.exit(1)
})
// Track unhandled rejections - crash only on repeated rapid-fire failures
// (a sign of systemic breakage, not transient hiccups during shutdown/restart).
let _unhandledRejectionCount = 0
let _unhandledRejectionWindowStart = Date.now()
const REJECTION_CRASH_THRESHOLD = parseInt(env.UNHANDLED_REJECTION_CRASH_THRESHOLD || '5')
const REJECTION_CRASH_WINDOW_MS = parseInt(env.UNHANDLED_REJECTION_CRASH_WINDOW_MS || '10000')

process.on('unhandledRejection', (reason) => {
  const msg = reason instanceof Error ? reason.message : String(reason)
  const stack = reason instanceof Error ? reason.stack : undefined
  logger.error('Unhandled rejection (non-fatal)', { error: msg, stack })

  // If we're already shutting down, swallow - don't compound the shutdown
  if (shuttingDown) return

  // Track rate - crash only if rejections are piling up (systemic failure)
  const now = Date.now()
  if (now - _unhandledRejectionWindowStart > REJECTION_CRASH_WINDOW_MS) {
    _unhandledRejectionCount = 0
    _unhandledRejectionWindowStart = now
  }
  _unhandledRejectionCount++

  if (REJECTION_CRASH_THRESHOLD > 0 && _unhandledRejectionCount >= REJECTION_CRASH_THRESHOLD) {
    logger.error(`${_unhandledRejectionCount} unhandled rejections in ${REJECTION_CRASH_WINDOW_MS}ms - triggering shutdown`)
    gracefulShutdown('unhandledRejection:flood').catch(() => {})
  }
})

server.listen(env.PORT, async () => {
  logger.info(`Ecodia API running on :${env.PORT}`)

  // ── Boot: Schema Constraint Validator ─────────────────────────────
  // Advisory check — warns if code enum values don't match DB constraints
  try {
    const { validateSchemaConstraints } = require('./utils/schemaValidator')
    await validateSchemaConstraints(db)
  } catch (err) {
    logger.warn('Schema constraint validation failed (non-fatal)', { error: err.message })
  }

  // ── Boot: Factory Bridge ──────────────────────────────────────────
  // Subscribe to Redis channels from factoryRunner for:
  // 1. Session completions → trigger oversight pipeline
  // 2. WS broadcast relay → push to connected WebSocket clients
  try {
    const bridge = require('./services/factoryBridge')
    const { broadcastToSession, broadcast } = require('./websocket/wsManager')

    bridge.subscribeMany({
      // Session completed → OS Session reviews and decides deploy/reject
      [bridge.CHANNELS.SESSION_COMPLETE]: async (data) => {
        try {
          logger.info(`Factory session ${data.sessionId} completed (${data.status}) — routing to OS Session for review`)
          const oversight = require('./services/factoryOversightService')
          const osSession = require('./services/osSessionService')

          // For failed sessions: run mechanical cleanup directly (nothing to review)
          // For completed sessions with changes: hand off to OS Session
          const [session] = await db`SELECT status, files_changed FROM cc_sessions WHERE id = ${data.sessionId}`

          if (!session || session.status !== 'complete') {
            // Failed — run mechanical pipeline (stash/clean) directly, no review needed
            oversight.runPostSessionPipeline(data.sessionId).catch(err => {
              logger.error(`Oversight pipeline (failure path) failed for session ${data.sessionId}`, { error: err.message })
            })
            return
          }

          const filesChanged = session.files_changed || []
          if (filesChanged.length === 0) {
            // No changes — run mechanical no-change handling directly
            oversight.runPostSessionPipeline(data.sessionId).catch(err => {
              logger.error(`Oversight pipeline (no-change path) failed for session ${data.sessionId}`, { error: err.message })
            })
            return
          }

          // Has changes — hand to OS Session for judgment
          const osStatus = await osSession.getStatus().catch(() => null)
          if (!osStatus || osStatus.status === 'error') {
            // OS Session not available — fall back to automated pipeline
            logger.warn(`OS Session unavailable for Factory review (${data.sessionId}) — falling back to automated pipeline`)
            oversight.runPostSessionPipeline(data.sessionId).catch(err => {
              logger.error(`Oversight pipeline (fallback) failed for session ${data.sessionId}`, { error: err.message })
            })
            return
          }

          // Send review request to OS Session
          const [fullSession] = await db`
            SELECT cs.initial_prompt, cb.name AS codebase_name
            FROM cc_sessions cs LEFT JOIN codebases cb ON cs.codebase_id = cb.id
            WHERE cs.id = ${data.sessionId}
          `
          const prompt = (fullSession?.initial_prompt || '').slice(0, 300)
          const codebase = fullSession?.codebase_name || 'unknown'

          await osSession.sendMessage(
            `FACTORY SESSION COMPLETE — review required.\n\n` +
            `Session ID: ${data.sessionId}\n` +
            `Codebase: ${codebase}\n` +
            `Task: ${prompt}\n` +
            `Files changed: ${filesChanged.length}\n\n` +
            `Call review_factory_session("${data.sessionId}") to see the diff and validation results, ` +
            `then call approve_factory_deploy("${data.sessionId}") to deploy or reject_factory_session("${data.sessionId}", reason) to reject. ` +
            `After deciding, extract any learnings into the knowledge graph.`
          )

          logger.info(`Factory session ${data.sessionId} handed to OS Session for review`)
        } catch (err) {
          logger.error('Failed to handle session completion from factory runner', { error: err.message })
          // Emergency fallback
          try {
            const oversight = require('./services/factoryOversightService')
            oversight.runPostSessionPipeline(data.sessionId).catch(() => {})
          } catch {}
        }
      },

      // WS relay - factory runner publishes, we push to connected clients
      [bridge.CHANNELS.WS_BROADCAST]: (data) => {
        try {
          if (data.sessionId) {
            broadcastToSession(data.sessionId, data.type, data.data)
          } else {
            broadcast(data.type, data.data)
          }
        } catch (err) {
          logger.debug('WS relay from factory runner failed', { error: err.message })
        }
      },
    })

    logger.info('Factory bridge subscriptions active (completions + WS relay)')
  } catch (err) {
    logger.warn('Failed to initialize factory bridge subscriptions', { error: err.message })
  }

  // ── Boot: Workers ─────────────────────────────────────────────────
  // DISABLED (2026-04-15): All autonomous workers are off. OS Session is
  // the ONE brain — it calls worker module functions as tools on-demand
  // (e.g. run_calendar_poll, run_kg_consolidation) when it decides the
  // work is needed. Worker source files stay put so OS Session can call
  // their exported functions directly; nothing loops on its own.
  //
  // Logged here only so `workspacePoller` (used on-demand by other code
  // paths that still require() it) can still be loaded by those callers —
  // no auto-start happens in either case because `start: true` was never
  // set on any entry in this list. Kept as a reference surface.

  const inlineWorkers = [
    // { name: 'calendarPoller',              path: './workers/calendarPoller' },
    // { name: 'codebaseIndexWorker',         path: './workers/codebaseIndexWorker' },
    // { name: 'workspacePoller',             path: './workers/workspacePoller' },
    // { name: 'kgEmbeddingWorker',           path: './workers/kgEmbeddingWorker' },
    // { name: 'kgConsolidationWorker',       path: './workers/kgConsolidationWorker' },
    // { name: 'financePoller',               path: './workers/financePoller' },
  ]

  for (const w of inlineWorkers) {
    try {
      const mod = require(w.path)
      if (w.start && typeof mod.start === 'function') {
        mod.start()
      }
    } catch (err) {
      logger.debug(`${w.name} not started`, { error: err.message })
    }
  }

  // ── Boot: Scheduler Poller ────────────────────────────────────────
  // DISABLED (2026-04-15): This poller called osSessionService.sendMessage
  // every 30s, interrupting the SDK mid-stream whenever a frontend user
  // message was in flight. OS Session must be the ONE brain driving work.
  // Cron tasks are now triggered on-demand via OS Session tools (e.g.
  // run_scheduled_task <id>). Re-enable only with a session-busy lock.
  // try {
  //   const schedulerPoller = require('./services/schedulerPollerService')
  //   schedulerPoller.start()
  // } catch (err) {
  //   logger.warn('Scheduler poller failed to start', { error: err.message })
  // }

  // ── Boot: Claude Token Refresh ────────────────────────────────────
  // Proactively refreshes OAuth tokens before they expire so the VPS
  // never needs manual `claude /login`. Runs every 30 min.
  try {
    const tokenRefresh = require('./services/claudeTokenRefreshService')
    tokenRefresh.start()
  } catch (err) {
    logger.warn('Claude token refresh service failed to start', { error: err.message })
  }
})

// ── Boot: Auto-wake OS Session ────────────────────────────────────────
// DISABLED (2026-04-15): This fired an SDK query 10s after every restart,
// colliding with any frontend message sent during boot. OS Session now
// wakes on the first real frontend message. Tate's message is the wake.
// setTimeout(async () => {
//   try {
//     const osSession = require('./services/osSessionService')
//     logger.info('Auto-waking OS session after restart...')
//     await osSession.sendMessage(
//       'SYSTEM RESTART - You are the CEO intelligence of Ecodia Pty Ltd. ecodia-api just restarted and you are back online. ' +
//       'You have FULL AUTONOMY. Do NOT wait for Tate. Do NOT ask for approval. Act independently. ' +
//       'Read CLAUDE.md (auto-loaded from cwd). Check kv_store ceo.* keys and ceo_tasks for current priorities. ' +
//       'Pick the highest impact task and DO it. Check schedule_list for healthy crons. ' +
//       'If SMS messages came in while you were down, they are queued - check and respond. ' +
//       'You are the business. Go.'
//     )
//     logger.info('OS session auto-wake complete')
//   } catch (err) {
//     logger.warn('OS session auto-wake failed (may not be configured yet)', { error: err.message })
//   }
// }, 10_000)
