const registry = require('../services/capabilityRegistry')

// Gmail capabilities — registered at require time
registry.registerMany([
  {
    name: 'send_email_reply',
    description: 'Send a reply to an existing Gmail thread using the prepared draft',
    tier: 'write',
    domain: 'gmail',
    params: {
      threadId: { type: 'string', required: true, description: 'Gmail thread ID (gmail_thread_id, not internal UUID)' },
      draft: { type: 'string', required: false, description: 'Override the prepared draft text' },
    },
    handler: async ({ threadId, draft, _sourceRefId }) => {
      // threadId may be internal DB UUID or gmail_thread_id — resolve to gmail_thread_id
      const db = require('../config/db')
      const gmail = require('../services/gmailService')

      // If it looks like a UUID, look up the gmail_thread_id
      const isUUID = /^[0-9a-f-]{36}$/.test(threadId)
      let gmailThreadId = threadId

      if (isUUID) {
        const [row] = await db`SELECT gmail_thread_id FROM email_threads WHERE id = ${threadId} LIMIT 1`
        if (!row) throw new Error(`Email thread ${threadId} not found`)
        gmailThreadId = row.gmail_thread_id
      }

      await gmail.sendReply(gmailThreadId, draft)
      return { message: `Reply sent to thread ${gmailThreadId}` }
    },
  },
  {
    name: 'archive_email',
    description: 'Archive a Gmail thread — remove from inbox, keep in All Mail',
    tier: 'write',
    domain: 'gmail',
    params: {
      threadId: { type: 'string', required: true, description: 'Gmail thread ID or internal UUID' },
    },
    handler: async ({ threadId }) => {
      const db = require('../config/db')
      const gmail = require('../services/gmailService')

      const isUUID = /^[0-9a-f-]{36}$/.test(threadId)
      let gmailThreadId = threadId

      if (isUUID) {
        const [row] = await db`SELECT gmail_thread_id FROM email_threads WHERE id = ${threadId} LIMIT 1`
        if (!row) throw new Error(`Email thread ${threadId} not found`)
        gmailThreadId = row.gmail_thread_id
      }

      await gmail.archiveThread(gmailThreadId)
      return { message: `Thread archived` }
    },
  },
  {
    name: 'trash_email',
    description: 'Move a Gmail thread to trash',
    tier: 'write',
    domain: 'gmail',
    params: {
      threadId: { type: 'string', required: true, description: 'Gmail thread ID or internal UUID' },
    },
    handler: async ({ threadId }) => {
      const db = require('../config/db')
      const gmail = require('../services/gmailService')

      const isUUID = /^[0-9a-f-]{36}$/.test(threadId)
      let gmailThreadId = threadId

      if (isUUID) {
        const [row] = await db`SELECT gmail_thread_id FROM email_threads WHERE id = ${threadId} LIMIT 1`
        if (!row) throw new Error(`Email thread ${threadId} not found`)
        gmailThreadId = row.gmail_thread_id
      }

      await gmail.trashThread(gmailThreadId)
      return { message: `Thread moved to trash` }
    },
  },
  {
    name: 'draft_email_reply',
    description: 'Generate an AI draft reply for a Gmail thread using knowledge graph context',
    tier: 'read',
    domain: 'gmail',
    params: {
      threadId: { type: 'string', required: true, description: 'Gmail thread ID or internal UUID' },
    },
    handler: async ({ threadId }) => {
      const db = require('../config/db')
      // Resolve to internal thread record
      const isUUID = /^[0-9a-f-]{36}$/.test(threadId)
      const [thread] = isUUID
        ? await db`SELECT * FROM email_threads WHERE id = ${threadId} LIMIT 1`
        : await db`SELECT * FROM email_threads WHERE gmail_thread_id = ${threadId} LIMIT 1`

      if (!thread) throw new Error(`Email thread not found: ${threadId}`)

      const deepseek = require('../services/deepseekService')
      const draft = await deepseek.draftEmailReply(thread)

      // Save draft to DB
      await db`UPDATE email_threads SET draft_reply = ${draft}, updated_at = now() WHERE id = ${thread.id}`

      return { draft, threadId: thread.gmail_thread_id }
    },
  },
  {
    name: 'get_email_thread',
    description: 'Retrieve a Gmail thread and its messages from the database',
    tier: 'read',
    domain: 'gmail',
    params: {
      threadId: { type: 'string', required: true, description: 'Gmail thread ID or internal UUID' },
    },
    handler: async ({ threadId }) => {
      const db = require('../config/db')
      const isUUID = /^[0-9a-f-]{36}$/.test(threadId)
      const [thread] = isUUID
        ? await db`SELECT * FROM email_threads WHERE id = ${threadId} LIMIT 1`
        : await db`SELECT * FROM email_threads WHERE gmail_thread_id = ${threadId} LIMIT 1`

      if (!thread) throw new Error(`Email thread not found: ${threadId}`)
      return thread
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
      // Use integer arithmetic — never interpolate strings into SQL interval expressions
      const [stats] = await db`
        SELECT
          count(*) FILTER (WHERE status = 'unread')::int AS unread,
          count(*) FILTER (WHERE triage_priority = 'urgent')::int AS urgent,
          count(*) FILTER (WHERE triage_priority = 'high')::int AS high,
          count(*) FILTER (WHERE triage_status = 'pending')::int AS pending_triage
        FROM email_threads
        WHERE received_at > now() - (${Math.max(1, Math.floor(hours))} * interval '1 hour')
      `
      return stats
    },
  },
])
