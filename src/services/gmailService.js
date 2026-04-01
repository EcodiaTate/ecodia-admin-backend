const { google } = require('googleapis')
const env = require('../config/env')
const db = require('../config/db')
const logger = require('../config/logger')
const deepseekService = require('./deepseekService')
const { createNotification } = require('../db/queries/transactions')
const retry = require('../utils/retry')

// TODO: Implement once Google Workspace service account is configured
// Requires: googleapis package (add to package.json when ready)

async function getGmailClient() {
  const credentials = JSON.parse(env.GOOGLE_SERVICE_ACCOUNT_JSON)
  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ['https://www.googleapis.com/auth/gmail.modify'],
    clientOptions: { subject: credentials.client_email },
  })
  return google.gmail({ version: 'v1', auth })
}

async function pollInbox() {
  logger.info('Gmail poll started')
  // Implementation will use Gmail API history.list for incremental sync
  // For now, stub
  logger.warn('Gmail pollInbox not yet implemented')
}

async function sendReply(threadId, body) {
  logger.info(`Sending reply to thread ${threadId}`)
  // Implementation will use Gmail API messages.send
  logger.warn('Gmail sendReply not yet implemented')
}

module.exports = { pollInbox, sendReply }
