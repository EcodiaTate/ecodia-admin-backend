const logger = require('../config/logger')
const db = require('../config/db')

// LinkedIn integration uses Playwright for session-based scraping
// TODO: Implement once Playwright is configured on VPS

let suspended = false
let suspendReason = null

async function checkDMs() {
  if (suspended) {
    logger.warn('LinkedIn worker is suspended, skipping DM check')
    return
  }
  logger.info('LinkedIn DM check started')
  // Playwright browser session → scrape DMs
  logger.warn('LinkedIn checkDMs not yet implemented')
}

async function sendMessage(conversationId, text) {
  if (suspended) throw new Error('LinkedIn worker is suspended')
  logger.info(`Sending LinkedIn message to conversation ${conversationId}`)
  // Playwright → type and send
  logger.warn('LinkedIn sendMessage not yet implemented')
}

async function getWorkerStatus() {
  return { suspended, reason: suspendReason }
}

async function resumeWorker() {
  suspended = false
  suspendReason = null
  logger.info('LinkedIn worker resumed')
}

function suspendWorker(reason) {
  suspended = true
  suspendReason = reason
  logger.warn(`LinkedIn worker suspended: ${reason}`)
}

module.exports = { checkDMs, sendMessage, getWorkerStatus, resumeWorker, suspendWorker }
