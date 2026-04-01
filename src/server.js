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

server.listen(env.PORT, async () => {
  logger.info(`Ecodia API running on :${env.PORT}`)
  await cleanupOrphanedSessions().catch(err =>
    logger.error('Orphan cleanup failed on startup', { error: err.message })
  )

  // Start workers
  try { require('./workers/kgEmbeddingWorker') } catch (err) { logger.debug('KG embedding worker not started', { error: err.message }) }
  try { require('./workers/kgConsolidationWorker') } catch (err) { logger.debug('KG consolidation worker not started', { error: err.message }) }
  try { require('./workers/calendarPoller') } catch (err) { logger.debug('Calendar poller not started', { error: err.message }) }
})
