require('../config/env')
const cron = require('node-cron')
const logger = require('../config/logger')
const linkedinService = require('../services/linkedinService')
const db = require('../config/db')

// ═══════════════════════════════════════════════════════════════════════
// Multi-Job LinkedIn Worker
//
// Schedule (all AEST — UTC+10):
//   DM check:           Every 4 hours (6am, 10am, 2pm, 6pm, 10pm)
//   Post publishing:    Every 30 min
//   Connection requests: Once daily at 8am
//   Network analytics:   Once daily at 11pm
//   Post performance:    Once daily at 7am
// ═══════════════════════════════════════════════════════════════════════

let running = false

async function runJob(jobName, fn) {
  if (running) {
    logger.debug(`LinkedIn worker busy, skipping ${jobName}`)
    return
  }

  // Check if session is suspended
  try {
    const status = await linkedinService.getWorkerStatus()
    if (status.status === 'suspended' || status.status === 'captcha') {
      logger.warn(`LinkedIn worker suspended (${status.reason}), skipping ${jobName}`)
      return
    }
  } catch {
    return
  }

  running = true
  logger.info(`LinkedIn worker starting: ${jobName}`)

  try {
    const result = await fn()
    logger.info(`LinkedIn worker completed: ${jobName}`, result)
  } catch (err) {
    logger.error(`LinkedIn worker failed: ${jobName}`, { error: err.message, stack: err.stack })

    await db`
      INSERT INTO notifications (type, message, link, metadata)
      VALUES ('system', ${'LinkedIn ' + jobName + ' failed: ' + err.message.slice(0, 100)}, '/linkedin',
        ${JSON.stringify({ job: jobName, error: err.message, action: 'linkedin_job_failed' })})
    `.catch(e => logger.error('Failed to create failure notification', { error: e.message }))
  } finally {
    running = false
  }
}

// ─── Jitter ────────────────────────────────────────────────────────────

function withJitter(fn) {
  return async () => {
    const jitterMs = Math.floor(Math.random() * 5 * 60 * 1000)
    await new Promise(r => setTimeout(r, jitterMs))
    return fn()
  }
}

// ─── Cron Schedules ────────────────────────────────────────────────────

// DM check: every 4 hours starting at 6am
cron.schedule('20 6,10,14,18,22 * * *', withJitter(() => runJob('dm_check', linkedinService.checkDMs)))

// Post publishing: every 30 min
cron.schedule('*/30 * * * *', () => runJob('post_publish', linkedinService.publishDuePosts))

// Connection requests: daily at 8am
cron.schedule('0 8 * * *', withJitter(() => runJob('connection_requests', linkedinService.checkConnectionRequests)))

// Network analytics: daily at 11pm
cron.schedule('0 23 * * *', withJitter(() => runJob('network_stats', linkedinService.scrapeNetworkStats)))

// Post performance: daily at 7am
cron.schedule('0 7 * * *', withJitter(() => runJob('post_performance', linkedinService.scrapePostPerformance)))

logger.info('LinkedIn multi-job worker started')

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
