const env = require('./config/env')
const app = require('./app')
const { createServer } = require('http')
const { initWS } = require('./websocket/wsManager')
const db = require('./config/db')
const logger = require('./config/logger')

const server = createServer(app)
initWS(app, server)

async function cleanupOrphanedSessions() {
  const orphans = await db`
    UPDATE cc_sessions
    SET status = 'error',
        error_message = 'Session orphaned — VPS reboot or process crash',
        completed_at = now()
    WHERE status IN ('running', 'initializing')
      AND started_at < now() - interval '5 minutes'
    RETURNING id
  `
  if (orphans.length > 0) {
    logger.warn(`Marked ${orphans.length} orphaned CC session(s) as error on startup`, {
      ids: orphans.map(r => r.id),
    })
  }
}

// Graceful shutdown — registered at module level so it fires regardless of
// whether the server has finished starting. PM2 sends SIGTERM on restart.
process.on('SIGTERM', () => {
  logger.info('SIGTERM received — shutting down')
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
