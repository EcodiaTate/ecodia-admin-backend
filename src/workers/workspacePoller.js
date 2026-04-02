require('../config/env')
const cron = require('node-cron')
const logger = require('../config/logger')
const env = require('../config/env')
const { createNotification } = require('../db/queries/transactions')
const { recordHeartbeat } = require('./heartbeat')

// ═══════════════════════════════════════════════════════════════════════
// WORKSPACE POLLER
//
// Unified worker for Google Drive, Vercel, and Meta Graph API.
// Everything runs on staggered schedules to avoid thundering herd.
// ═══════════════════════════════════════════════════════════════════════

// ─── Google Drive: every 10 minutes ────────────────────────────────────

if (env.GOOGLE_SERVICE_ACCOUNT_JSON && env.GOOGLE_SERVICE_ACCOUNT_JSON !== '{}') {
  const driveService = require('../services/googleDriveService')

  // File sync every 10 min
  cron.schedule('*/10 * * * *', async () => {
    try {
      await driveService.pollDrive()
      await recordHeartbeat('google_drive', 'active')
    } catch (err) {
      logger.error('Google Drive poll failed', { error: err.message })
      await recordHeartbeat('google_drive', 'error', err.message)
      await createNotification({
        type: 'system',
        message: `Google Drive poller failed: ${err.message}`,
        metadata: { error: err.message, worker: 'workspacePoller:drive' },
      }).catch(() => {})
    }
  })

  // Content extraction every 15 min (offset by 5 min from sync)
  cron.schedule('5,20,35,50 * * * *', async () => {
    try {
      await driveService.extractContent(20)
    } catch (err) {
      logger.debug('Drive content extraction failed', { error: err.message })
    }
  })

  // Embedding every 20 min (offset from extraction)
  cron.schedule('10,30,50 * * * *', async () => {
    try {
      await driveService.embedStaleFiles(20)
    } catch (err) {
      logger.debug('Drive embedding failed', { error: err.message })
    }
  })

  logger.info('Google Drive poller started (sync: 10min, extract: 15min, embed: 20min)')
}

// ─── Vercel: every 5 minutes ───────────────────────────────────────────

if (env.VERCEL_API_TOKEN) {
  const vercelService = require('../services/vercelService')

  cron.schedule('*/5 * * * *', async () => {
    try {
      await vercelService.poll()
      await recordHeartbeat('vercel', 'active')
    } catch (err) {
      logger.error('Vercel poll failed', { error: err.message })
      await recordHeartbeat('vercel', 'error', err.message)
    }
  })

  logger.info('Vercel poller started (every 5 min)')
}

// ─── Meta Graph API: every 15 minutes ──────────────────────────────────

if (env.META_USER_ACCESS_TOKEN) {
  const metaService = require('../services/metaService')

  cron.schedule('*/15 * * * *', async () => {
    try {
      await metaService.poll()
      await recordHeartbeat('meta', 'active')
    } catch (err) {
      logger.error('Meta poll failed', { error: err.message })
      await recordHeartbeat('meta', 'error', err.message)
    }
  })

  logger.info('Meta Graph API poller started (every 15 min)')
}

// ─── Action Queue: expire stale items every hour ───────────────────────

const actionQueue = require('../services/actionQueueService')
cron.schedule('0 * * * *', async () => {
  try {
    await actionQueue.expireStale()
  } catch (err) {
    logger.debug('Action queue expiry failed', { error: err.message })
  }
})

logger.info('Workspace poller worker started')
