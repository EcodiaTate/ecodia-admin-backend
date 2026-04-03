const env = require('./config/env')
const app = require('./app')
const { createServer } = require('http')
const { initWS } = require('./websocket/wsManager')
const db = require('./config/db')
const logger = require('./config/logger')

const server = createServer(app)
initWS(app, server)

// Track open connections so we can force-destroy them on shutdown.
// Without this, server.close() hangs on long-lived WebSocket connections
// and PM2 SIGKILLs the process before process.exit() fires → orphans.
const openConnections = new Set()
server.on('connection', (conn) => {
  openConnections.add(conn)
  conn.on('close', () => openConnections.delete(conn))
})

async function cleanupOrphanedSessions() {
  // Sessions still marked 'running'/'initializing' at startup were NOT
  // caught by the graceful SIGTERM handler — they survived a hard kill
  // (OOM, SIGKILL, VPS reboot, kernel upgrade, etc).
  const orphans = await db`
    UPDATE cc_sessions
    SET status = 'error',
        error_message = 'Session orphaned — process was killed without graceful shutdown',
        completed_at = now()
    WHERE status IN ('running', 'initializing')
      AND (
        -- Classic check: session started >5min ago (catches startup cleanup)
        (last_heartbeat_at IS NULL AND started_at < now() - interval '5 minutes')
        -- Heartbeat check: last heartbeat >3min ago (catches mid-run deaths)
        OR (last_heartbeat_at IS NOT NULL AND last_heartbeat_at < now() - interval '3 minutes')
      )
    RETURNING id, started_at, last_heartbeat_at
  `
  if (orphans.length > 0) {
    logger.warn(`Marked ${orphans.length} orphaned CC session(s) on startup (hard kill — not caught by SIGTERM/SIGINT handler)`, {
      ids: orphans.map(r => r.id),
      startedAt: orphans.map(r => r.started_at),
    })
  }
}

// Graceful shutdown — registered at module level so it fires regardless of
// whether the server has finished starting. PM2 sends SIGTERM on restart/delete
// and SIGINT in some shutdown paths.
let shuttingDown = false
async function gracefulShutdown(signal) {
  if (shuttingDown) return // Prevent double-shutdown from SIGTERM+SIGINT race
  shuttingDown = true
  logger.info(`${signal} received — shutting down`)

  // Stop active CC sessions gracefully so they don't become orphans
  try {
    const ccService = require('./services/ccService')
    const activeCount = ccService.getActiveSessionCount()
    if (activeCount > 0) {
      logger.info(`Gracefully stopping ${activeCount} active CC session(s) before shutdown`)
      // stopAllSessions kills child processes and marks DB as 'stopped'
      await Promise.race([
        ccService.stopAllSessions('Process restarting — session stopped gracefully'),
        new Promise(resolve => setTimeout(resolve, 10000)), // Don't block shutdown >10s (kill_timeout is 12s)
      ])
    }
  } catch (err) {
    logger.debug('CC session cleanup on shutdown failed', { error: err.message })
  }

  try {
    const maintenance = require('./workers/autonomousMaintenanceWorker')
    maintenance.stop()
  } catch {}

  // Force-destroy open connections (especially WebSockets) so server.close()
  // doesn't hang waiting for them to end. Without this, PM2 SIGKILLs the
  // process at kill_timeout and sessions that weren't yet marked in DB become orphans.
  for (const conn of openConnections) {
    try { conn.destroy() } catch {}
  }
  server.close(() => process.exit(0))

  // Hard exit fallback — if server.close() still hangs (e.g. connections
  // that survive destroy()), exit before PM2's 12s kill_timeout SIGKILLs us
  setTimeout(() => {
    logger.warn('Graceful shutdown timed out — forcing exit')
    process.exit(1)
  }, 11000).unref()
}
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'))
process.on('SIGINT', () => gracefulShutdown('SIGINT'))

// Crash handlers — without these, uncaught errors kill the process
// without triggering SIGTERM/SIGINT, leaving sessions orphaned in DB.
process.on('uncaughtException', async (err) => {
  logger.error('Uncaught exception — triggering graceful shutdown', { error: err.message, stack: err.stack })
  await gracefulShutdown('uncaughtException').catch(() => {})
  process.exit(1)
})
process.on('unhandledRejection', async (reason) => {
  const msg = reason instanceof Error ? reason.message : String(reason)
  logger.error('Unhandled rejection — triggering graceful shutdown', { error: msg })
  await gracefulShutdown('unhandledRejection').catch(() => {})
  process.exit(1)
})

server.listen(env.PORT, async () => {
  logger.info(`Ecodia API running on :${env.PORT}`)

  await cleanupOrphanedSessions().catch(err =>
    logger.error('Orphan cleanup failed on startup', { error: err.message })
  )

  // Run orphan cleanup periodically — catches sessions orphaned by crashes
  // that happened before the graceful shutdown handlers could fire, or by
  // other process instances that died without cleanup.
  const orphanCleanupTimer = setInterval(() => {
    cleanupOrphanedSessions().catch(err =>
      logger.debug('Periodic orphan cleanup failed', { error: err.message })
    )
  }, 5 * 60 * 1000) // every 5 minutes
  orphanCleanupTimer.unref()

  // ── Boot: Capability Registry ────────────────────────────────────
  // Must load before any worker that uses execute() or performAction().
  try {
    require('./capabilities/index')
  } catch (err) {
    logger.error('Capability registry failed to boot — actions will not work', { error: err.message })
  }

  // ── Boot: Workers ─────────────────────────────────────────────────
  // Workers that have their own PM2 process in ecosystem.config.js are
  // NOT started here — they'd register duplicate cron jobs.
  //
  // PM2-managed (separate processes, NOT started here):
  //   gmailPoller, linkedinWorker, financePoller,
  //   kgEmbeddingWorker, kgConsolidationWorker
  //
  // Inline (started here, restart with this process):
  //   calendarPoller, codebaseIndexWorker, symbridgeWorker,
  //   workspacePoller, autonomousMaintenanceWorker

  const inlineWorkers = [
    { name: 'calendarPoller',              path: './workers/calendarPoller' },
    { name: 'codebaseIndexWorker',         path: './workers/codebaseIndexWorker' },
    { name: 'symbridgeWorker',             path: './workers/symbridgeWorker' },
    { name: 'workspacePoller',             path: './workers/workspacePoller' },
    { name: 'autonomousMaintenanceWorker', path: './workers/autonomousMaintenanceWorker', start: true },
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
})
