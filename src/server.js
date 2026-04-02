const env = require('./config/env')
const app = require('./app')
const { createServer } = require('http')
const { initWS } = require('./websocket/wsManager')
const db = require('./config/db')
const logger = require('./config/logger')

const server = createServer(app)
initWS(app, server)

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
      AND started_at < now() - interval '5 minutes'
    RETURNING id, started_at
  `
  if (orphans.length > 0) {
    logger.warn(`Marked ${orphans.length} orphaned CC session(s) on startup (hard kill — not caught by SIGTERM handler)`, {
      ids: orphans.map(r => r.id),
    })
  }
}

// Graceful shutdown — registered at module level so it fires regardless of
// whether the server has finished starting. PM2 sends SIGTERM on restart.
process.on('SIGTERM', async () => {
  logger.info('SIGTERM received — shutting down')

  // Stop active CC sessions gracefully so they don't become orphans
  try {
    const ccService = require('./services/ccService')
    const activeCount = ccService.getActiveSessionCount()
    if (activeCount > 0) {
      logger.info(`Gracefully stopping ${activeCount} active CC session(s) before shutdown`)
      // stopAllSessions kills child processes and marks DB as 'stopped'
      await Promise.race([
        ccService.stopAllSessions('Process restarting — session stopped gracefully'),
        new Promise(resolve => setTimeout(resolve, 8000)), // Don't block shutdown >8s
      ])
    }
  } catch (err) {
    logger.debug('CC session cleanup on shutdown failed', { error: err.message })
  }

  try {
    const maintenance = require('./workers/autonomousMaintenanceWorker')
    maintenance.stop()
  } catch {}
  server.close(() => process.exit(0))
})

server.listen(env.PORT, async () => {
  logger.info(`Ecodia API running on :${env.PORT}`)

  await cleanupOrphanedSessions().catch(err =>
    logger.error('Orphan cleanup failed on startup', { error: err.message })
  )

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
