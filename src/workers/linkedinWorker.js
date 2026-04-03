require('../config/env')
const logger = require('../config/logger')
const linkedinService = require('../services/linkedinService')
const db = require('../config/db')
const { recordHeartbeat } = require('./heartbeat')

// ═══════════════════════════════════════════════════════════════════════
// LINKEDIN WORKER — Adaptive loop
//
// No fixed cron schedules. Each job runs on an adaptive interval:
//   - DM check:           1–4 hours (faster if DMs found)
//   - Post publishing:    15–60 min (faster if posts are queued)
//   - Connection requests: 6–24 hours (adaptive to network activity)
//   - Network analytics:  6–24 hours (adaptive to staleness)
//   - Post performance:   4–24 hours (adaptive to engagement signals)
// ═══════════════════════════════════════════════════════════════════════

let running = false

async function runJob(jobName, fn) {
  if (running) {
    logger.debug(`LinkedIn worker busy, skipping ${jobName}`)
    return null
  }

  // Check if session is suspended
  try {
    const status = await linkedinService.getWorkerStatus()
    if (status.status === 'suspended' || status.status === 'captcha') {
      logger.warn(`LinkedIn worker suspended (${status.reason}), skipping ${jobName}`)
      return null
    }
  } catch (err) {
    logger.warn(`LinkedIn worker status check failed, skipping ${jobName}`, { error: err.message })
    return null
  }

  running = true
  logger.info(`LinkedIn worker starting: ${jobName}`)

  try {
    const result = await fn()
    logger.info(`LinkedIn worker completed: ${jobName}`, result)
    await recordHeartbeat('linkedin', 'active')
    return result
  } catch (err) {
    logger.error(`LinkedIn worker failed: ${jobName}`, { error: err.message, stack: err.stack })
    await recordHeartbeat('linkedin', 'error', err.message)
    await db`
      INSERT INTO notifications (type, message, link, metadata)
      VALUES ('system', ${'LinkedIn ' + jobName + ' failed: ' + err.message.slice(0, 100)}, '/linkedin',
        ${JSON.stringify({ job: jobName, error: err.message, action: 'linkedin_job_failed' })})
    `.catch(e => logger.error('Failed to create failure notification', { error: e.message }))
    return null
  } finally {
    running = false
  }
}

// ─── Jitter ──────────────────────────────────────────────────────────

function jitter(ms) {
  return ms + Math.floor(Math.random() * ms * 0.2)  // ±20% jitter
}

// ─── Adaptive job loops ───────────────────────────────────────────────

function startDMLoop() {
  let timer
  async function loop() {
    const result = await runJob('dm_check', linkedinService.checkDMs)
    const hasNew = result?.newDMs ?? result?.count ?? 0
    const delay = hasNew > 0 ? jitter(60 * 60_000) : jitter(4 * 60 * 60_000)
    if (running !== undefined) timer = setTimeout(loop, delay)
  }
  timer = setTimeout(loop, jitter(5 * 60_000))  // first run 5 min after boot
  return () => clearTimeout(timer)
}

function startPostPublishLoop() {
  let timer
  async function loop() {
    const result = await runJob('post_publish', linkedinService.publishDuePosts)
    const queued = result?.queued ?? result?.remaining ?? 0
    const delay = queued > 0 ? jitter(15 * 60_000) : jitter(60 * 60_000)
    if (running !== undefined) timer = setTimeout(loop, delay)
  }
  timer = setTimeout(loop, jitter(2 * 60_000))  // first run 2 min after boot
  return () => clearTimeout(timer)
}

function startConnectionLoop() {
  let timer
  async function loop() {
    await runJob('connection_requests', linkedinService.checkConnectionRequests)
    timer = setTimeout(loop, jitter(12 * 60 * 60_000))  // ~12h
  }
  timer = setTimeout(loop, jitter(30 * 60_000))  // first run 30 min after boot
  return () => clearTimeout(timer)
}

function startNetworkStatsLoop() {
  let timer
  async function loop() {
    await runJob('network_stats', linkedinService.scrapeNetworkStats)
    timer = setTimeout(loop, jitter(12 * 60 * 60_000))  // ~12h
  }
  timer = setTimeout(loop, jitter(60 * 60_000))  // first run 1h after boot
  return () => clearTimeout(timer)
}

function startPostPerformanceLoop() {
  let timer
  async function loop() {
    await runJob('post_performance', linkedinService.scrapePostPerformance)
    timer = setTimeout(loop, jitter(8 * 60 * 60_000))  // ~8h
  }
  timer = setTimeout(loop, jitter(45 * 60_000))  // first run 45 min after boot
  return () => clearTimeout(timer)
}

const stops = [
  startDMLoop(),
  startPostPublishLoop(),
  startConnectionLoop(),
  startNetworkStatsLoop(),
  startPostPerformanceLoop(),
]

logger.info('LinkedIn multi-job worker started — adaptive loops')

// ─── Manual Trigger Support ────────────────────────────────────────────

const JOB_MAP = {
  dms: () => runJob('dm_check', linkedinService.checkDMs),
  posts: () => runJob('post_publish', linkedinService.publishDuePosts),
  connections: () => runJob('connection_requests', linkedinService.checkConnectionRequests),
  network_stats: () => runJob('network_stats', linkedinService.scrapeNetworkStats),
  post_performance: () => runJob('post_performance', linkedinService.scrapePostPerformance),
}

async function triggerJob(jobType) {
  const fn = JOB_MAP[jobType]
  if (!fn) throw new Error(`Unknown job type: ${jobType}. Valid: ${Object.keys(JOB_MAP).join(', ')}`)
  fn().catch(err => logger.error(`Manual trigger ${jobType} failed`, { error: err.message }))
  return { triggered: jobType }
}

module.exports = { triggerJob, JOB_MAP }
