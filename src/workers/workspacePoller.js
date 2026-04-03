require('../config/env')
const logger = require('../config/logger')
const env = require('../config/env')
const { createNotification } = require('../db/queries/transactions')
const { recordHeartbeat } = require('./heartbeat')

// ═══════════════════════════════════════════════════════════════════════
// WORKSPACE POLLER — On-Demand
//
// No fixed schedules. Each poll function is exported so the
// autonomousMaintenanceWorker can call them when the AI decides a poll
// is warranted. This replaces cron-based scheduling entirely.
//
// The AI reads system state (last poll time, pending signals, pressure)
// and decides what to sync and when — not the clock.
// ═══════════════════════════════════════════════════════════════════════

// ─── Google Drive ──────────────────────────────────────────────────────

async function pollDrive() {
  if (!env.GOOGLE_SERVICE_ACCOUNT_JSON || env.GOOGLE_SERVICE_ACCOUNT_JSON === '{}') return
  const driveService = require('../services/googleDriveService')
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
}

async function extractDriveContent(limit = 20) {
  if (!env.GOOGLE_SERVICE_ACCOUNT_JSON || env.GOOGLE_SERVICE_ACCOUNT_JSON === '{}') return
  const driveService = require('../services/googleDriveService')
  try {
    await driveService.extractContent(limit)
  } catch (err) {
    logger.debug('Drive content extraction failed', { error: err.message })
  }
}

async function embedDriveFiles(limit = 20) {
  if (!env.GOOGLE_SERVICE_ACCOUNT_JSON || env.GOOGLE_SERVICE_ACCOUNT_JSON === '{}') return
  const driveService = require('../services/googleDriveService')
  try {
    await driveService.embedStaleFiles(limit)
  } catch (err) {
    logger.debug('Drive embedding failed', { error: err.message })
  }
}

// ─── Vercel ────────────────────────────────────────────────────────────

async function pollVercel() {
  if (!env.VERCEL_API_TOKEN) return
  const vercelService = require('../services/vercelService')
  try {
    await vercelService.poll()
    await recordHeartbeat('vercel', 'active')
  } catch (err) {
    logger.error('Vercel poll failed', { error: err.message })
    await recordHeartbeat('vercel', 'error', err.message)
  }
}

// ─── Meta Graph API ────────────────────────────────────────────────────

async function pollMeta() {
  if (!env.META_USER_ACCESS_TOKEN) return
  const metaService = require('../services/metaService')
  try {
    await metaService.poll()
    await recordHeartbeat('meta', 'active')
  } catch (err) {
    logger.error('Meta poll failed', { error: err.message })
    await recordHeartbeat('meta', 'error', err.message)
  }
}

// ─── Action Queue expiry ───────────────────────────────────────────────

async function expireStaleActions() {
  const actionQueue = require('../services/actionQueueService')
  try {
    await actionQueue.expireStale()
  } catch (err) {
    logger.warn('Action queue expiry failed', { error: err.message })
  }
}

logger.info('Workspace pollers registered (on-demand, no fixed schedules)')

module.exports = { pollDrive, extractDriveContent, embedDriveFiles, pollVercel, pollMeta, expireStaleActions }
