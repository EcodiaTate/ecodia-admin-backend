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
  logger.error('Capability registry failed to boot — actions will not work', { error: err.message })
}

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
  //
  // If they have a cc_cli_session_id, mark as 'paused' (resumable via --resume).
  // Only truly orphan sessions that have no CLI session ID (old sessions or
  // sessions that died before the init message was received).
  // 'completing' means the close handler is actively processing — don't touch those
  const resumable = await db`
    UPDATE cc_sessions
    SET status = 'paused',
        error_message = 'Process interrupted — session is resumable'
    WHERE status IN ('running', 'initializing')
      AND cc_cli_session_id IS NOT NULL
      AND (
        (last_heartbeat_at IS NULL AND started_at < now() - interval '5 minutes')
        OR (last_heartbeat_at IS NOT NULL AND last_heartbeat_at < now() - interval '3 minutes')
      )
    RETURNING id, started_at
  `
  if (resumable.length > 0) {
    logger.info(`Marked ${resumable.length} interrupted CC session(s) as paused (resumable via --resume)`, {
      ids: resumable.map(r => r.id),
    })
  }

  // Sessions without a CLI session ID truly are orphaned — no way to resume
  const orphans = await db`
    UPDATE cc_sessions
    SET status = 'error',
        error_message = 'Session orphaned — process was killed without graceful shutdown (no CLI session ID)',
        completed_at = now()
    WHERE status IN ('running', 'initializing')
      AND cc_cli_session_id IS NULL
      AND (
        (last_heartbeat_at IS NULL AND started_at < now() - interval '5 minutes')
        OR (last_heartbeat_at IS NOT NULL AND last_heartbeat_at < now() - interval '3 minutes')
      )
    RETURNING id, started_at
  `
  if (orphans.length > 0) {
    logger.warn(`Marked ${orphans.length} orphaned CC session(s) on startup (no CLI session ID — not resumable)`, {
      ids: orphans.map(r => r.id),
    })
  }

  // Sessions stuck in 'completing' for >10 minutes — the close handler crashed or
  // the process was killed mid-close. These need cleanup too, but with a longer
  // window since 'completing' is a legitimate transitional state.
  const stuckCompleting = await db`
    UPDATE cc_sessions
    SET status = 'error',
        error_message = 'Session stuck in completing state — close handler did not finish',
        completed_at = now()
    WHERE status = 'completing'
      AND (
        (last_heartbeat_at IS NOT NULL AND last_heartbeat_at < now() - interval '10 minutes')
        OR (last_heartbeat_at IS NULL AND started_at < now() - interval '15 minutes')
      )
    RETURNING id, started_at
  `
  if (stuckCompleting.length > 0) {
    logger.warn(`Cleaned up ${stuckCompleting.length} session(s) stuck in completing state`, {
      ids: stuckCompleting.map(r => r.id),
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
      logger.info(`Pausing ${activeCount} active CC session(s) before shutdown (resumable)`)
      // stopAllSessions kills child processes and marks DB as 'paused' (resumable)
      await Promise.race([
        ccService.stopAllSessions('Process restarting — session paused for resume'),
        new Promise(resolve => setTimeout(resolve, 30000)), // Don't block shutdown >30s (kill_timeout is 45s)
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

  // Close the DB connection pool — prevents connection leaks across restarts
  // and ensures in-flight queries complete before the process exits.
  try { await db.end({ timeout: 5 }) } catch {}

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
// Track unhandled rejections — crash only on repeated rapid-fire failures
// (a sign of systemic breakage, not transient hiccups during shutdown/restart).
let _unhandledRejectionCount = 0
let _unhandledRejectionWindowStart = Date.now()
const REJECTION_CRASH_THRESHOLD = parseInt(env.UNHANDLED_REJECTION_CRASH_THRESHOLD || '5')
const REJECTION_CRASH_WINDOW_MS = parseInt(env.UNHANDLED_REJECTION_CRASH_WINDOW_MS || '10000')

process.on('unhandledRejection', (reason) => {
  const msg = reason instanceof Error ? reason.message : String(reason)
  const stack = reason instanceof Error ? reason.stack : undefined
  logger.error('Unhandled rejection (non-fatal)', { error: msg, stack })

  // If we're already shutting down, swallow — don't compound the shutdown
  if (shuttingDown) return

  // Track rate — crash only if rejections are piling up (systemic failure)
  const now = Date.now()
  if (now - _unhandledRejectionWindowStart > REJECTION_CRASH_WINDOW_MS) {
    _unhandledRejectionCount = 0
    _unhandledRejectionWindowStart = now
  }
  _unhandledRejectionCount++

  if (REJECTION_CRASH_THRESHOLD > 0 && _unhandledRejectionCount >= REJECTION_CRASH_THRESHOLD) {
    logger.error(`${_unhandledRejectionCount} unhandled rejections in ${REJECTION_CRASH_WINDOW_MS}ms — triggering shutdown`)
    gracefulShutdown('unhandledRejection:flood').catch(() => {})
  }
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
