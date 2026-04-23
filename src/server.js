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
    const messageQueue = require('./services/messageQueue')
    messageQueue.stopSweepPoller()
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
const REJECTION_CRASH_THRESHOLD = parseInt(env.UNHANDLED_REJECTION_CRASH_THRESHOLD || '20')
const REJECTION_CRASH_WINDOW_MS = parseInt(env.UNHANDLED_REJECTION_CRASH_WINDOW_MS || '60000')

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

  // ── Boot: Neo4j Retrieval Warmup ──────────────────────────────────
  // Warm the Neo4j retrieval path so the first user-turn injection doesn't pay
  // the ~2.4s driver cold-start cost (vs the 2s outer timeout in _injectRelevantMemory).
  setImmediate(() => {
    require('./services/neo4jRetrieval')
      .semanticSearch('warmup', { limit: 1, minScore: 0.99 })
      .catch(() => {}) // intentional - fire and forget
  })

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
  // Re-enabled 2026-04-20 with:
  //   - session-busy gate (checks /api/os-session/status before firing)
  //   - energy-adjusted cadence (poll interval / scheduleMultiplier)
  //   - critical-energy deferral (non-essential tasks pushed out 1h)
  // The original disable reason (mid-stream interruption) is now covered
  // by the busy gate in schedulerPollerService.isSessionBusy().
  try {
    const schedulerPoller = require('./services/schedulerPollerService')
    schedulerPoller.start()
  } catch (err) {
    logger.warn('Scheduler poller failed to start', { error: err.message })
  }

  // ── Boot: Message Queue Sweep ─────────────────────────────────────
  // Promotes and delivers any messages that have exceeded their max_age_hours.
  // Runs every 30 minutes in-process (backend-internal, does not require OS session).
  try {
    const messageQueue = require('./services/messageQueue')
    messageQueue.startSweepPoller()
  } catch (err) {
    logger.warn('Message queue sweep poller failed to start', { error: err.message })
  }

  // ── Boot: OS Heartbeat ────────────────────────────────────────────
  // Wakes the OS Session periodically with an open-ended "check in" prompt
  // when Tate isn't messaging. Makes the OS genuinely autonomous during the
  // 3-month Africa trip instead of silent until prompted.
  try {
    const osHeartbeat = require('./services/osHeartbeatService')
    osHeartbeat.start()
  } catch (err) {
    logger.warn('OS Heartbeat failed to start', { error: err.message })
  }

  // ── Boot: TLS Cert Monitor ────────────────────────────────────────
  // Hourly check of the production cert's remaining validity. Alerts via
  // email at 14 days (warn), bypasses cooldown at 3 days (urgent). Catches
  // certbot autorenew failures before the cert silently expires mid-trip.
  try {
    const certMonitor = require('./services/certMonitorService')
    certMonitor.start()
  } catch (err) {
    logger.warn('TLS cert monitor failed to start', { error: err.message })
  }

  // ── Boot: Claude Token Refresh ────────────────────────────────────
  // Proactively refreshes OAuth tokens before they expire so the VPS
  // never needs manual `claude /login`. Runs every 30 min.
  try {
    const tokenRefresh = require('./services/claudeTokenRefreshService')
    tokenRefresh.start()
  } catch (err) {
    logger.warn('Claude token refresh service failed to start', { error: err.message })
  }

  // ── Boot: Nightly Restart ─────────────────────────────────────────
  // Scheduled `pm2 restart ecodia-api` at 03:00 AEST with a T-5min heads-up
  // (WS broadcast + [SYSTEM] message posted into the OS inbox so it sees
  // the warning in-turn). If the OS is busy at T-0, waits up to 10 min for
  // idle before force-restarting. Disable with NIGHTLY_RESTART_ENABLED=false.
  try {
    const nightlyRestart = require('./services/nightlyRestartService')
    nightlyRestart.start()
  } catch (err) {
    logger.warn('Nightly restart service failed to start', { error: err.message })
  }

  // ── Boot: Process Restart Alert + Alive Beacon ────────────────────
  // Emails Tate when ecodia-api restarts. Uses kv_store to record the
  // previous "I'm alive" beacon timestamp so we can compute prior uptime.
  // Short uptime (<10m) usually means a crash loop — worth knowing.
  try {
    const alerting = require('./services/osAlertingService')
    const row = await db`SELECT value FROM kv_store WHERE key = 'osalive_last'`.catch(() => [])
    const rawPrev = row.length ? row[0].value : null
    const prevAlive = (rawPrev && typeof rawPrev === 'object' && Number.isFinite(rawPrev.ts))
      ? rawPrev.ts
      : Number(typeof rawPrev === 'string' ? rawPrev : NaN)
    const validPrev = Number.isFinite(prevAlive) ? prevAlive : null
    const uptimeMs = validPrev ? Date.now() - validPrev : 0

    // Deploy-sentinel: if a .deploy-sentinel file exists and is <5 min old,
    // this restart is intentional (deploy script wrote it). Skip the alert
    // and clear the sentinel so the next unexpected restart fires normally.
    // Exported to global so the auto-wake block below can see the decision.
    let deployMarker = false
    try {
      const fs = require('fs')
      const path = require('path')
      const sentinelPath = path.join(process.cwd(), '.deploy-sentinel')
      if (fs.existsSync(sentinelPath)) {
        const stat = fs.statSync(sentinelPath)
        const ageMs = Date.now() - stat.mtimeMs
        if (ageMs < 5 * 60 * 1000) {
          deployMarker = true
          logger.info('Deploy sentinel found — skipping restart alert', { ageMs })
        }
        try { fs.unlinkSync(sentinelPath) } catch {}
      }
    } catch (err) {
      logger.debug('Deploy sentinel check failed', { error: err.message })
    }
    // Persist for auto-wake (fires 90s later, after sentinel is gone)
    global.__ecodia_last_restart_was_planned = deployMarker

    if (!deployMarker && validPrev && uptimeMs > 30_000) {
      // Previous beacon >30s ago and no deploy in progress — unplanned restart.
      alerting.alertProcessRestart(uptimeMs).catch(() => {})
    }

    // Alive beacon — ticks every 60s. A restart alert will compute prior
    // uptime as (now - beacon), giving a tight bound on silent-death time.
    // JSONB payload so the schema (value JSONB) is honored explicitly.
    const tickAlive = async () => {
      try {
        await db`
          INSERT INTO kv_store (key, value)
          VALUES ('osalive_last', ${{ ts: Date.now() }})
          ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()
        `
      } catch {}
    }
    tickAlive()
    const aliveTimer = setInterval(tickAlive, 60_000)
    if (typeof aliveTimer.unref === 'function') aliveTimer.unref()
  } catch (err) {
    logger.warn('Process restart alert setup failed', { error: err.message })
  }

  // ── Boot: Session Auto-Wake ───────────────────────────────────────
  // If a recent handoff state exists, fires a wake message after 15s so the
  // OS resumes interrupted work automatically — no need to wait for Tate.
  try {
    require('./services/sessionAutoWake').triggerAutoWakeIfNeeded()
  } catch (err) {
    logger.warn('Session auto-wake setup failed (non-fatal)', { error: err.message })
  }
})

// ── Boot: Conditional Auto-wake OS Session ───────────────────────────
// Re-enabled 2026-04-20 with strict conditions to avoid the old bug
// (auto-wake colliding with a real user message during boot).
//
// Only fires when ALL true:
//   1. This was an UNPLANNED restart (no .deploy-sentinel). Planned deploys
//      don't need auto-wake because Tate is right there deploying.
//   2. A recent breadcrumb exists (<30min old). Means there was an active
//      conversation to resume. No breadcrumb = cold start, don't invent work.
//   3. 60 seconds pass with no real user message. If the user texts/messages
//      during that window their message wins, auto-wake defers.
//
// Fires ONE heartbeat-style turn. The breadcrumb is stitched in by the
// existing recovery path so the OS rehydrates and picks up naturally.
setTimeout(async () => {
  try {
    // Condition 1: unplanned restart. Decision was made at boot and stashed
    // on `global.__ecodia_last_restart_was_planned` because the .deploy-
    // sentinel file is consumed/deleted during the process-restart alert
    // block above — by the time this setTimeout fires the file is gone.
    if (global.__ecodia_last_restart_was_planned === true) {
      logger.info('Auto-wake skipped: last restart was a planned deploy')
      return
    }

    // Condition 2: recent breadcrumb
    const db = require('./config/db')
    const bcRows = await db`SELECT value FROM kv_store WHERE key = 'session.last_breadcrumb'`.catch(() => [])
    const raw = bcRows?.[0]?.value
    let bc = null
    if (raw && typeof raw === 'object') bc = raw
    else if (typeof raw === 'string') { try { bc = JSON.parse(raw) } catch {} }
    if (!bc || !Number.isFinite(bc.ts)) {
      logger.info('Auto-wake skipped: no breadcrumb (cold start)')
      return
    }
    const ageMs = Date.now() - bc.ts
    if (ageMs > 30 * 60 * 1000) {
      logger.info('Auto-wake skipped: breadcrumb too old', { ageMin: Math.round(ageMs / 60000) })
      return
    }

    // Condition 3: no user activity since boot. If the OS is currently
    // streaming (Tate messaged during / just after boot), the busy check
    // fails and we bail.
    const osSession = require('./services/osSessionService')
    const status = await osSession.getStatus().catch(() => null)
    if (status?.active || status?.status === 'streaming') {
      logger.info('Auto-wake skipped: user message arrived during grace window')
      return
    }

    // Fire the wake. Prompt is deliberately minimal — breadcrumb stitching
    // in _sendMessageImpl does the heavy lifting of restoring context.
    logger.info('Auto-wake: firing OS rehydration turn')
    const osIncident = require('./services/osIncidentService')
    osIncident.log({
      kind: 'subsystem_recovered',
      severity: 'info',
      component: 'os_session',
      message: 'auto-wake fired after unplanned restart with recent breadcrumb',
      context: { breadcrumbAgeMin: Math.round(ageMs / 60000) },
    })
    await osSession.sendMessage(
      '[AUTO_WAKE] ecodia-api just restarted unexpectedly ~' +
      Math.round(ageMs / 60000) + ' min ago. The <recent_exchanges> block in this message is the literal tail of the conversation you were in the middle of. ' +
      'Pick up naturally — continue whatever was in flight. Do NOT summarise the gap, do NOT announce that you restarted, do NOT ask Tate to repeat himself. If the last exchange is complete and nothing is pressing, stay silent (empty response is fine). Tate should not notice the restart at all.'
    ).catch(err => logger.warn('Auto-wake turn failed', { error: err.message }))
  } catch (err) {
    logger.warn('Auto-wake setup failed', { error: err.message })
  }
}, 90_000)  // 90s = 30s for boot to settle + 60s grace already baked into the prompt flow. Timer starts fresh.
