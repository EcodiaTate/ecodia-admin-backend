const registry = require('../services/capabilityRegistry')

// ═══════════════════════════════════════════════════════════════════════
// Gmail capabilities — full inbox management for the OS Cortex
// ═══════════════════════════════════════════════════════════════════════

registry.registerMany([

  // ── READ: View, search, stats ────────────────────────────────────────

  {
    name: 'gmail_inbox_overview',
    description: 'Get a complete overview of all inboxes — unread, urgent, high priority, pending triage, per-inbox breakdown. The first thing to call when entering the email workspace.',
    tier: 'read',
    domain: 'gmail',
    params: {},
    handler: async () => {
      const gmail = require('../services/gmailService')
      return await gmail.getInboxStats()
    },
  },
  {
    name: 'gmail_list_threads',
    description: 'List email threads with filters. Use this to see what\'s in the inbox, filter by status/priority/inbox, or paginate through results.',
    tier: 'read',
    domain: 'gmail',
    params: {
      status: { type: 'string', required: false, description: 'Filter: unread, triaged, replied, archived' },
      priority: { type: 'string', required: false, description: 'Filter: urgent, high, normal, low, spam' },
      inbox: { type: 'string', required: false, description: 'Filter by inbox email (e.g. code@ecodia.au)' },
      search: { type: 'string', required: false, description: 'Search subject, sender name, or sender email' },
      limit: { type: 'number', required: false, description: 'Max results (default 20)' },
      offset: { type: 'number', required: false, description: 'Pagination offset' },
    },
    handler: async (params) => {
      const gmail = require('../services/gmailService')
      const threads = await gmail.listThreads({
        status: params.status, priority: params.priority,
        inbox: params.inbox, search: params.search,
        limit: params.limit || 20, offset: params.offset || 0,
      })
      return { threads, count: threads.length }
    },
  },
  {
    name: 'gmail_search',
    description: 'Search emails by keyword across subject, sender, and content. Returns matching threads sorted by date.',
    tier: 'read',
    domain: 'gmail',
    params: {
      query: { type: 'string', required: true, description: 'Search term — matches subject, sender email, sender name, snippet' },
      limit: { type: 'number', required: false, description: 'Max results (default 20)' },
    },
    handler: async (params) => {
      const gmail = require('../services/gmailService')
      const threads = await gmail.searchThreads(params.query, params.limit || 20)
      return { threads, count: threads.length }
    },
  },
  {
    name: 'gmail_get_thread',
    description: 'Get full details of a specific email thread — subject, body, triage summary, suggested action, draft reply, labels.',
    tier: 'read',
    domain: 'gmail',
    params: {
      threadId: { type: 'string', required: true, description: 'Thread UUID (id field) or gmail_thread_id from gmail_list_threads' },
    },
    handler: async (params) => {
      const threadId = params.threadId || params.thread_id || params.id || params.gmail_thread_id
      if (!threadId) throw new Error('threadId is required — pass the id or gmail_thread_id from gmail_list_threads')
      const db = require('../config/db')
      const isUUID = /^[0-9a-f-]{36}$/.test(threadId)
      const [thread] = isUUID
        ? await db`SELECT * FROM email_threads WHERE id = ${threadId} LIMIT 1`
        : await db`SELECT * FROM email_threads WHERE gmail_thread_id = ${threadId} LIMIT 1`
      if (!thread) throw new Error(`Thread not found: ${threadId}`)
      return thread
    },
  },
  {
    name: 'gmail_client_emails',
    description: 'Get all email threads linked to a CRM client — useful for seeing the conversation history with a specific person or company.',
    tier: 'read',
    domain: 'gmail',
    params: {
      client_id: { type: 'string', required: true, description: 'CRM client UUID' },
      limit: { type: 'number', required: false, description: 'Max results (default 20)' },
    },
    handler: async (params) => {
      const gmail = require('../services/gmailService')
      const threads = await gmail.getThreadsByClient(params.client_id, params.limit || 20)
      return { threads, count: threads.length }
    },
  },
  {
    name: 'gmail_list_labels',
    description: 'List all Gmail labels for an inbox — useful for understanding what labels exist before applying them.',
    tier: 'read',
    domain: 'gmail',
    params: {
      inbox: { type: 'string', required: false, description: 'Inbox email (defaults to primary)' },
    },
    handler: async (params) => {
      const gmail = require('../services/gmailService')
      return await gmail.listLabels(params.inbox)
    },
  },

  // ── TRIAGE: AI-powered categorization + delegation ───────────────────

  {
    name: 'gmail_triage',
    description: 'Run AI triage on pending emails. The triage system auto-categorizes by urgency, drafts replies, creates follow-up tasks, delegates receipts to bookkeeping, dev requests to factory, and client emails to CRM.',
    tier: 'write',
    domain: 'gmail',
    params: {},
    handler: async () => {
      const gmail = require('../services/gmailService')
      const { recordHeartbeat } = require('../workers/heartbeat')
      await gmail.triagePendingEmails()
      await recordHeartbeat('gmail', 'active').catch(() => {})
      const stats = await gmail.getInboxStats()
      return { message: 'Triage complete', stats }
    },
  },
  {
    name: 'gmail_retriage_thread',
    description: 'Force re-triage a specific email thread — useful when triage failed or you want a fresh AI assessment.',
    tier: 'write',
    domain: 'gmail',
    params: {
      threadId: { type: 'string', required: true, description: 'Thread UUID' },
    },
    handler: async ({ threadId }) => {
      const db = require('../config/db')
      const gmail = require('../services/gmailService')
      await db`UPDATE email_threads SET triage_status = 'pending', triage_attempts = 0 WHERE id = ${threadId}`
      await gmail.triagePendingEmails()
      const [thread] = await db`SELECT triage_priority, triage_summary, triage_action, triage_status FROM email_threads WHERE id = ${threadId}`
      return { retriaged: true, ...thread }
    },
  },
  {
    name: 'gmail_sync',
    description: 'Trigger an immediate inbox sync — polls Gmail for new messages across all configured inboxes.',
    tier: 'write',
    domain: 'gmail',
    params: {},
    handler: async () => {
      const gmail = require('../services/gmailService')
      const { recordHeartbeat } = require('../workers/heartbeat')
      await gmail.pollInbox()
      await recordHeartbeat('gmail', 'active').catch(() => {})
      const stats = await gmail.getInboxStats()
      return { synced: true, stats }
    },
  },

  // ── DRAFT & REPLY ────────────────────────────────────────────────────

  {
    name: 'gmail_draft_reply',
    description: 'Generate an AI draft reply for an email thread. Uses knowledge graph context and company tone. Draft is saved to the thread and to Gmail drafts. Human must approve before sending.',
    tier: 'write',
    domain: 'gmail',
    params: {
      threadId: { type: 'string', required: true, description: 'Thread UUID or gmail_thread_id' },
      instructions: { type: 'string', required: false, description: 'Optional instructions for the AI (e.g. "be brief", "decline politely", "ask for more details")' },
    },
    handler: async ({ threadId, instructions }) => {
      const db = require('../config/db')
      const isUUID = /^[0-9a-f-]{36}$/.test(threadId)
      const [thread] = isUUID
        ? await db`SELECT * FROM email_threads WHERE id = ${threadId} LIMIT 1`
        : await db`SELECT * FROM email_threads WHERE gmail_thread_id = ${threadId} LIMIT 1`
      if (!thread) throw new Error(`Thread not found: ${threadId}`)

      const deepseek = require('../services/deepseekService')
      const prompt = instructions
        ? `Draft a reply to this email. ${instructions}\n\nOriginal email from ${thread.from_name || thread.from_email}:\nSubject: ${thread.subject}\n\n${thread.full_body || thread.snippet}`
        : null
      const draft = prompt
        ? await deepseek.callDeepSeek([{ role: 'user', content: prompt }], { module: 'gmail', skipRetrieval: false })
        : await deepseek.draftEmailReply(thread)

      await db`UPDATE email_threads SET draft_reply = ${draft}, updated_at = now() WHERE id = ${thread.id}`

      // Also save as Gmail draft
      const gmail = require('../services/gmailService')
      await gmail.saveDraftToGmail(thread, draft).catch(() => {})

      return { draft, threadId: thread.gmail_thread_id, message: 'Draft saved — review and approve before sending' }
    },
  },
  {
    name: 'gmail_send_reply',
    description: 'Send a reply to an email thread. Uses the saved draft if no body provided. IMPORTANT: Only call this after the human has approved the draft.',
    tier: 'write',
    domain: 'gmail',
    params: {
      threadId: { type: 'string', required: true, description: 'Gmail thread ID (not UUID)' },
      body: { type: 'string', required: false, description: 'Reply body text. If omitted, sends the saved draft.' },
    },
    handler: async ({ threadId, body }) => {
      const db = require('../config/db')
      const gmail = require('../services/gmailService')

      if (!body) {
        // Use saved draft
        const isUUID = /^[0-9a-f-]{36}$/.test(threadId)
        const [thread] = isUUID
          ? await db`SELECT * FROM email_threads WHERE id = ${threadId} LIMIT 1`
          : await db`SELECT * FROM email_threads WHERE gmail_thread_id = ${threadId} LIMIT 1`
        if (!thread?.draft_reply) throw new Error('No draft found. Generate one first with gmail_draft_reply.')
        body = thread.draft_reply
        threadId = thread.gmail_thread_id
      }

      await gmail.sendReply(threadId, body)
      return { sent: true, threadId }
    },
  },
  {
    name: 'gmail_send_new',
    description: 'Compose and send a new email (not a reply). Use for outbound communication.',
    tier: 'write',
    domain: 'gmail',
    params: {
      to: { type: 'string', required: true, description: 'Recipient email address' },
      subject: { type: 'string', required: true, description: 'Email subject line' },
      body: { type: 'string', required: true, description: 'Email body text' },
      inbox: { type: 'string', required: false, description: 'Send from this inbox (defaults to primary)' },
    },
    handler: async (params) => {
      const gmail = require('../services/gmailService')
      return await gmail.sendNewEmail(params.inbox, params.to, params.subject, params.body)
    },
  },

  // ── ACTIONS: Archive, trash, label, star, forward ────────────────────

  {
    name: 'gmail_archive',
    description: 'Archive an email thread — removes from inbox but keeps in All Mail. Good for dealt-with emails.',
    tier: 'write',
    domain: 'gmail',
    params: {
      threadId: { type: 'string', required: true, description: 'Thread UUID' },
    },
    handler: async ({ threadId }) => {
      const gmail = require('../services/gmailService')
      await gmail.archiveThread(threadId)
      return { archived: true }
    },
  },
  {
    name: 'gmail_trash',
    description: 'Move an email thread to trash. Use for junk, spam, or unwanted emails.',
    tier: 'write',
    domain: 'gmail',
    params: {
      threadId: { type: 'string', required: true, description: 'Thread UUID' },
    },
    handler: async ({ threadId }) => {
      const gmail = require('../services/gmailService')
      await gmail.trashThread(threadId)
      return { trashed: true }
    },
  },
  {
    name: 'gmail_mark_read',
    description: 'Mark an email thread as read.',
    tier: 'write',
    domain: 'gmail',
    params: {
      threadId: { type: 'string', required: true, description: 'Thread UUID' },
    },
    handler: async ({ threadId }) => {
      const gmail = require('../services/gmailService')
      await gmail.markRead(threadId)
      return { read: true }
    },
  },
  {
    name: 'gmail_label',
    description: 'Add a label to an email thread. Creates the label if it doesn\'t exist. Use for organizing: "Client/ProjectX", "Needs Response", "Receipts", etc.',
    tier: 'write',
    domain: 'gmail',
    params: {
      threadId: { type: 'string', required: true, description: 'Thread UUID' },
      label: { type: 'string', required: true, description: 'Label name to apply' },
    },
    handler: async (params) => {
      const gmail = require('../services/gmailService')
      return await gmail.labelThread(params.threadId, params.label)
    },
  },
  {
    name: 'gmail_remove_label',
    description: 'Remove a label from an email thread.',
    tier: 'write',
    domain: 'gmail',
    params: {
      threadId: { type: 'string', required: true, description: 'Thread UUID' },
      label: { type: 'string', required: true, description: 'Label name to remove' },
    },
    handler: async (params) => {
      const gmail = require('../services/gmailService')
      return await gmail.removeLabel(params.threadId, params.label)
    },
  },
  {
    name: 'gmail_star',
    description: 'Star/unstar an email thread. Starred emails are important and should be kept visible.',
    tier: 'write',
    domain: 'gmail',
    params: {
      threadId: { type: 'string', required: true, description: 'Thread UUID' },
      star: { type: 'boolean', required: false, description: 'true to star, false to unstar (default: true)' },
    },
    handler: async (params) => {
      const gmail = require('../services/gmailService')
      if (params.star === false) return await gmail.unstarThread(params.threadId)
      return await gmail.starThread(params.threadId)
    },
  },
  {
    name: 'gmail_forward',
    description: 'Forward an email thread to another address. Good for delegation or sharing.',
    tier: 'write',
    domain: 'gmail',
    params: {
      threadId: { type: 'string', required: true, description: 'Thread UUID' },
      to: { type: 'string', required: true, description: 'Email address to forward to' },
    },
    handler: async (params) => {
      const gmail = require('../services/gmailService')
      return await gmail.forwardThread(params.threadId, params.to)
    },
  },

  // ── BATCH: Bulk operations ───────────────────────────────────────────

  {
    name: 'gmail_batch_archive',
    description: 'Archive multiple email threads at once. Pass an array of thread UUIDs.',
    tier: 'write',
    domain: 'gmail',
    params: {
      threadIds: { type: 'array', required: true, description: 'Array of thread UUIDs to archive' },
    },
    handler: async (params) => {
      const gmail = require('../services/gmailService')
      if (typeof params.threadIds === 'string') params.threadIds = JSON.parse(params.threadIds)
      return await gmail.batchArchive(params.threadIds)
    },
  },
  {
    name: 'gmail_batch_trash',
    description: 'Trash multiple email threads at once. Use for bulk cleanup of spam, newsletters, etc.',
    tier: 'write',
    domain: 'gmail',
    params: {
      threadIds: { type: 'array', required: true, description: 'Array of thread UUIDs to trash' },
    },
    handler: async (params) => {
      const gmail = require('../services/gmailService')
      if (typeof params.threadIds === 'string') params.threadIds = JSON.parse(params.threadIds)
      return await gmail.batchTrash(params.threadIds)
    },
  },
  {
    name: 'gmail_cleanup_inbox',
    description: 'Smart inbox cleanup — archives all low-priority triaged emails, trashes spam, and returns what\'s left. Keeps urgent/high/starred untouched.',
    tier: 'write',
    domain: 'gmail',
    params: {
      dry_run: { type: 'boolean', required: false, description: 'If true, just show what would be cleaned without doing it' },
    },
    handler: async (params) => {
      const db = require('../config/db')
      const gmail = require('../services/gmailService')

      // Find emails that are safe to auto-clean
      const toArchive = await db`
        SELECT id FROM email_threads
        WHERE status IN ('triaged', 'replied') AND triage_priority IN ('low', 'normal')
          AND received_at < now() - interval '2 days'
          AND NOT ('STARRED' = ANY(labels))
        LIMIT 100`

      const toTrash = await db`
        SELECT id FROM email_threads
        WHERE triage_priority = 'spam' AND status != 'archived'
        LIMIT 100`

      if (params.dry_run) {
        return { would_archive: toArchive.length, would_trash: toTrash.length, message: 'Dry run — no changes made' }
      }

      const archiveResult = await gmail.batchArchive(toArchive.map(r => r.id))
      const trashResult = await gmail.batchTrash(toTrash.map(r => r.id))

      return {
        archived: archiveResult.archived,
        trashed: trashResult.trashed,
        message: `Cleaned up: ${archiveResult.archived} archived, ${trashResult.trashed} trashed`,
      }
    },
  },

  // ── FOLLOW-UP: Create tasks from emails ──────────────────────────────

  {
    name: 'gmail_create_followup',
    description: 'Create a follow-up task from an email thread. The task is linked to the email and (if available) the CRM client. Use when an email requires action that can\'t be done right now.',
    tier: 'write',
    domain: 'gmail',
    params: {
      threadId: { type: 'string', required: true, description: 'Thread UUID' },
      title: { type: 'string', required: false, description: 'Task title (defaults to email subject)' },
      description: { type: 'string', required: false, description: 'Task description (defaults to triage summary)' },
      priority: { type: 'string', required: false, description: 'urgent, high, medium, low (default: medium)' },
    },
    handler: async (params) => {
      const gmail = require('../services/gmailService')
      return await gmail.createFollowUpTask(params.threadId, params.title, params.description, params.priority || 'medium')
    },
  },

  // ── UNSUBSCRIBE: Stop receiving newsletters/spam ─────────────────────

  {
    name: 'gmail_unsubscribe',
    description: 'Unsubscribe from a sender — trashes the email and remembers the sender for auto-trashing future emails from them.',
    tier: 'write',
    domain: 'gmail',
    params: {
      threadId: { type: 'string', required: true, description: 'Thread UUID' },
    },
    handler: async ({ threadId }) => {
      const gmail = require('../services/gmailService')
      return await gmail.unsubscribe(threadId)
    },
  },
])
