const registry = require('../services/capabilityRegistry')
const env = require('../config/env')

// Gmail capabilities — registered at require time
registry.registerMany([
  {
    name: 'send_email_reply',
    description: 'Send a reply to an existing Gmail thread using the prepared draft',
    tier: 'write',
    domain: 'gmail',
    params: {
      threadId: { type: 'string', required: true, description: 'Gmail thread ID' },
      draft: { type: 'string', required: false, description: 'Override the prepared draft text' },
    },
    handler: async ({ threadId, draft }) => {
      const gmail = require('../services/gmailService')
      await gmail.sendReply(threadId, draft)
      return { message: `Reply sent to thread ${threadId}` }
    },
  },
  {
    name: 'archive_email',
    description: 'Archive a Gmail thread — remove from inbox, keep in All Mail',
    tier: 'write',
    domain: 'gmail',
    params: {
      threadId: { type: 'string', required: true, description: 'Gmail thread ID' },
    },
    handler: async ({ threadId }) => {
      const gmail = require('../services/gmailService')
      await gmail.archiveThread(threadId)
      return { message: `Thread ${threadId} archived` }
    },
  },
  {
    name: 'trash_email',
    description: 'Move a Gmail thread to trash',
    tier: 'write',
    domain: 'gmail',
    params: {
      threadId: { type: 'string', required: true, description: 'Gmail thread ID' },
    },
    handler: async ({ threadId }) => {
      const gmail = require('../services/gmailService')
      await gmail.trashThread(threadId)
      return { message: `Thread ${threadId} moved to trash` }
    },
  },
  {
    name: 'draft_email_reply',
    description: 'Generate an AI draft reply for a Gmail thread using context from the knowledge graph',
    tier: 'read',
    domain: 'gmail',
    params: {
      threadId: { type: 'string', required: true, description: 'Gmail thread ID' },
    },
    handler: async ({ threadId }) => {
      const gmail = require('../services/gmailService')
      const draft = await gmail.generateDraftReply(threadId)
      return { draft, threadId }
    },
  },
  {
    name: 'get_email_thread',
    description: 'Retrieve a Gmail thread and its messages',
    tier: 'read',
    domain: 'gmail',
    params: {
      threadId: { type: 'string', required: true, description: 'Gmail thread ID' },
    },
    handler: async ({ threadId }) => {
      const gmail = require('../services/gmailService')
      return gmail.getThread ? gmail.getThread(threadId) : { error: 'getThread not available' }
    },
  },
  {
    name: 'get_email_summary',
    description: 'Get a summary of recent emails — unread counts, urgent items, pending triage',
    tier: 'read',
    domain: 'gmail',
    params: {
      hours: { type: 'number', required: false, description: 'Lookback window in hours (default 24)' },
    },
    handler: async ({ hours = 24 }) => {
      const db = require('../config/db')
      const [stats] = await db`
        SELECT
          count(*) FILTER (WHERE status = 'unread')::int AS unread,
          count(*) FILTER (WHERE triage_priority = 'urgent')::int AS urgent,
          count(*) FILTER (WHERE triage_priority = 'high')::int AS high,
          count(*) FILTER (WHERE triage_status = 'pending')::int AS pending_triage
        FROM email_threads
        WHERE received_at > now() - (${hours} || ' hours')::interval
      `
      return stats
    },
  },
])
