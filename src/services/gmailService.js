const { google } = require('googleapis')
const env = require('../config/env')
const db = require('../config/db')
const logger = require('../config/logger')
const deepseekService = require('./deepseekService')
const { createNotification } = require('../db/queries/transactions')
const { findClientByEmail } = require('../db/queries/clients')
const { createTask } = require('../db/queries/tasks')

const INBOXES = ['code@ecodia.au', 'tate@ecodia.au']
const MAX_TRIAGE_ATTEMPTS = 5

// ─── Gmail Client ────────────────────────────────────────────────────────────

function getGmailClient(userEmail) {
  const credentials = JSON.parse(env.GOOGLE_SERVICE_ACCOUNT_JSON)
  const privateKey = credentials.private_key.replace(/\\n/g, '\n')
  const auth = new google.auth.JWT({
    email: credentials.client_email,
    key: privateKey,
    scopes: [
      'https://www.googleapis.com/auth/gmail.modify',
      'https://www.googleapis.com/auth/gmail.compose',
    ],
    subject: userEmail,
  })
  return google.gmail({ version: 'v1', auth })
}

// ─── Poll All Inboxes ────────────────────────────────────────────────────────

async function pollInbox() {
  for (const inbox of INBOXES) {
    try {
      logger.info(`Polling inbox: ${inbox}`)
      const gmail = getGmailClient(inbox)
      await gmail.users.getProfile({ userId: 'me' }) // auth check

      const [syncState] = await db`
        SELECT * FROM gmail_sync_state WHERE id = ${inbox}
      `

      if (syncState) {
        await incrementalSync(gmail, inbox, syncState.history_id)
      } else {
        await fullSync(gmail, inbox)
      }
    } catch (err) {
      logger.error(`Failed to poll ${inbox}`, { error: err.message })
      // Continue to next inbox — don't let one failure block others
    }
  }

  // After sync, triage any pending emails
  await triagePendingEmails()
}

// ─── Full Sync ───────────────────────────────────────────────────────────────

async function fullSync(gmail, inbox) {
  const res = await gmail.users.threads.list({
    userId: 'me',
    maxResults: 30,
    labelIds: ['INBOX'],
  })

  const threads = res.data.threads || []
  logger.info(`Full sync [${inbox}]: found ${threads.length} threads`)

  for (const thread of threads) {
    await processThread(gmail, inbox, thread.id)
  }

  const profile = await gmail.users.getProfile({ userId: 'me' })
  await db`
    INSERT INTO gmail_sync_state (id, history_id)
    VALUES (${inbox}, ${profile.data.historyId})
    ON CONFLICT (id) DO UPDATE SET history_id = ${profile.data.historyId}, updated_at = now()
  `
}

// ─── Incremental Sync ────────────────────────────────────────────────────────

async function incrementalSync(gmail, inbox, historyId) {
  try {
    const res = await gmail.users.history.list({
      userId: 'me',
      startHistoryId: historyId,
      historyTypes: ['messageAdded'],
      labelId: 'INBOX',
    })

    const history = res.data.history || []
    const threadIds = new Set()
    for (const h of history) {
      for (const msg of (h.messagesAdded || [])) {
        threadIds.add(msg.message.threadId)
      }
    }

    logger.info(`Incremental sync [${inbox}]: ${threadIds.size} updated threads`)

    for (const threadId of threadIds) {
      await processThread(gmail, inbox, threadId)
    }

    if (res.data.historyId) {
      await db`UPDATE gmail_sync_state SET history_id = ${res.data.historyId}, updated_at = now() WHERE id = ${inbox}`
    }
  } catch (err) {
    if (err.code === 404) {
      logger.warn(`History ID expired for ${inbox}, falling back to full sync`)
      await db`DELETE FROM gmail_sync_state WHERE id = ${inbox}`
      await fullSync(gmail, inbox)
    } else {
      throw err
    }
  }
}

// ─── Process Thread ──────────────────────────────────────────────────────────

async function processThread(gmail, inbox, threadId) {
  const [existing] = await db`SELECT id FROM email_threads WHERE gmail_thread_id = ${threadId}`
  if (existing) return

  const thread = await gmail.users.threads.get({
    userId: 'me',
    id: threadId,
    format: 'full',
  })

  const messages = thread.data.messages || []
  if (messages.length === 0) return

  const firstMsg = messages[0]
  const lastMsg = messages[messages.length - 1]
  const headers = firstMsg.payload.headers || []
  const getHeader = (name) => headers.find(h => h.name.toLowerCase() === name.toLowerCase())?.value || ''

  const fromRaw = getHeader('From')
  const fromEmail = fromRaw.match(/<(.+)>/)?.[1] || fromRaw
  const fromName = fromRaw.match(/^"?([^"<]+)"?\s*</)?.[1]?.trim() || null

  const subject = getHeader('Subject')
  const snippet = firstMsg.snippet || ''
  const body = extractBody(lastMsg)

  const messageIds = messages.map(m => m.id)
  const allLabels = [...new Set(messages.flatMap(m => m.labelIds || []))]
  const isUnread = allLabels.includes('UNREAD')
  const receivedAt = new Date(parseInt(firstMsg.internalDate))

  const client = await findClientByEmail(fromEmail)

  await db`
    INSERT INTO email_threads (
      gmail_thread_id, gmail_message_ids, subject, from_email, from_name,
      snippet, full_body, labels, client_id, received_at, status, inbox
    ) VALUES (
      ${threadId}, ${messageIds}, ${subject}, ${fromEmail}, ${fromName},
      ${snippet}, ${body}, ${allLabels}, ${client?.id || null}, ${receivedAt},
      ${isUnread ? 'unread' : 'triaged'}, ${inbox}
    )
  `

  logger.info(`[${inbox}] Processed: ${subject} from ${fromEmail}`)
}

// ─── DeepSeek Triage ─────────────────────────────────────────────────────────

async function triagePendingEmails() {
  if (!env.DEEPSEEK_API_KEY) return

  const pending = await db`
    SELECT * FROM email_threads
    WHERE triage_status IN ('pending', 'pending_retry')
      AND triage_attempts < ${MAX_TRIAGE_ATTEMPTS}
    ORDER BY received_at DESC
    LIMIT 10
  `

  if (pending.length === 0) return
  logger.info(`Triaging ${pending.length} emails`)

  for (const thread of pending) {
    try {
      const client = thread.client_id
        ? (await db`SELECT name, stage FROM clients WHERE id = ${thread.client_id}`)[0]
        : null

      const triage = await deepseekService.triageEmail({
        subject: thread.subject,
        from: `${thread.from_name || ''} <${thread.from_email}>`,
        body: thread.full_body,
        snippet: thread.snippet,
        inbox: thread.inbox,
        clientContext: client,
      })

      await db`
        UPDATE email_threads SET
          triage_priority = ${triage.priority},
          triage_summary = ${triage.summary},
          triage_action = ${triage.suggestedAction},
          draft_reply = ${triage.draftReply || null},
          triage_status = 'complete',
          triage_attempts = triage_attempts + 1,
          updated_at = now()
        WHERE id = ${thread.id}
      `

      // Auto-create task if DeepSeek says so
      if (triage.shouldCreateTask && triage.taskTitle) {
        await createTask({
          title: triage.taskTitle,
          description: triage.taskDescription,
          source: 'gmail',
          sourceRefId: thread.id,
          clientId: thread.client_id,
          priority: triage.taskPriority || 'medium',
        })
        logger.info(`Auto-created task: ${triage.taskTitle}`)
      }

      // ─── AUTONOMOUS ACTIONS ──────────────────────────────────────────
      // Act on the triage result automatically. Only urgent/high need human review.
      await autoAct(thread, triage)

      logger.info(`Triaged [${triage.priority}] → ${triage.suggestedAction}: ${thread.subject}`)
    } catch (err) {
      logger.warn(`Triage failed for ${thread.id}`, { error: err.message })
      const newStatus = thread.triage_attempts + 1 >= MAX_TRIAGE_ATTEMPTS ? 'failed' : 'pending_retry'
      await db`
        UPDATE email_threads SET
          triage_status = ${newStatus},
          triage_attempts = triage_attempts + 1,
          updated_at = now()
        WHERE id = ${thread.id}
      `
    }
  }
}

// ─── Autonomous Actions ──────────────────────────────────────────────────────

async function autoAct(thread, triage) {
  const action = triage.suggestedAction
  const priority = triage.priority

  try {
    // URGENT: never auto-act, always surface to human
    if (priority === 'urgent') {
      await createNotification({
        type: 'email',
        message: `🔴 URGENT: ${thread.from_name || thread.from_email} — ${triage.summary}`,
        link: '/gmail',
        metadata: { threadId: thread.id, priority },
      }).catch(() => {})
      return
    }

    // HIGH: notify + save draft if reply suggested, but don't auto-send
    if (priority === 'high') {
      if (triage.draftReply) {
        await saveDraftToGmail(thread, triage.draftReply).catch(err =>
          logger.warn(`Failed to save Gmail draft for ${thread.id}`, { error: err.message })
        )
      }
      await createNotification({
        type: 'email',
        message: `[HIGH] ${thread.from_name || thread.from_email}: ${triage.summary}`,
        link: '/gmail',
        metadata: { threadId: thread.id, priority },
      }).catch(() => {})
      return
    }

    // SPAM / IGNORE → auto-archive in Gmail, mark archived in DB
    if (priority === 'spam' || action === 'ignore' || action === 'archive') {
      await silentArchive(thread)
      logger.info(`Auto-archived [${priority}/${action}]: ${thread.subject}`)
      return
    }

    // LOW → auto-archive (receipts, notifications, newsletters)
    if (priority === 'low') {
      await silentArchive(thread)
      logger.info(`Auto-archived [low]: ${thread.subject}`)
      return
    }

    // NORMAL + reply → save draft to Gmail for review, don't notify
    if (priority === 'normal' && action === 'reply' && triage.draftReply) {
      await saveDraftToGmail(thread, triage.draftReply).catch(err =>
        logger.warn(`Failed to save Gmail draft for ${thread.id}`, { error: err.message })
      )
      await silentArchive(thread)
      logger.info(`Auto-drafted & archived [normal/reply]: ${thread.subject}`)
      return
    }

    // NORMAL + create_task → task already created above, archive email
    if (priority === 'normal' && action === 'create_task') {
      await silentArchive(thread)
      logger.info(`Auto-archived [normal/create_task]: ${thread.subject}`)
      return
    }

    // NORMAL + anything else → archive silently
    if (priority === 'normal') {
      await silentArchive(thread)
      return
    }
  } catch (err) {
    // Never let auto-act failures crash the triage loop
    logger.error(`Auto-act failed for ${thread.id}`, { error: err.message })
  }
}

async function silentArchive(thread) {
  try {
    const gmail = getGmailClient(thread.inbox || INBOXES[0])
    await gmail.users.threads.modify({
      userId: 'me',
      id: thread.gmail_thread_id,
      requestBody: { removeLabelIds: ['INBOX', 'UNREAD'] },
    })
    await db`UPDATE email_threads SET status = 'archived', updated_at = now() WHERE id = ${thread.id}`
  } catch (err) {
    logger.warn(`Silent archive failed for ${thread.id}`, { error: err.message })
  }
}

async function saveDraftToGmail(thread, draftBody) {
  const inbox = thread.inbox || INBOXES[0]
  const gmail = getGmailClient(inbox)

  const raw = createRawEmail({
    to: thread.from_email,
    from: inbox,
    subject: `Re: ${thread.subject || ''}`,
    body: draftBody,
    inReplyTo: thread.gmail_message_ids?.[thread.gmail_message_ids.length - 1],
  })

  const draft = await gmail.users.drafts.create({
    userId: 'me',
    requestBody: {
      message: {
        raw,
        threadId: thread.gmail_thread_id,
      },
    },
  })

  await db`
    UPDATE email_threads SET draft_gmail_id = ${draft.data.id}, updated_at = now()
    WHERE id = ${thread.id}
  `

  logger.info(`Saved Gmail draft for: ${thread.subject} (draft ID: ${draft.data.id})`)
}

// ─── Email Actions ───────────────────────────────────────────────────────────

async function archiveThread(threadId) {
  const [thread] = await db`SELECT * FROM email_threads WHERE id = ${threadId}`
  if (!thread) throw new Error('Thread not found')

  const gmail = getGmailClient(thread.inbox || INBOXES[0])
  await gmail.users.threads.modify({
    userId: 'me',
    id: thread.gmail_thread_id,
    requestBody: { removeLabelIds: ['INBOX'] },
  })

  await db`UPDATE email_threads SET status = 'archived', updated_at = now() WHERE id = ${threadId}`
  logger.info(`Archived thread: ${thread.subject}`)
}

async function markRead(threadId) {
  const [thread] = await db`SELECT * FROM email_threads WHERE id = ${threadId}`
  if (!thread) throw new Error('Thread not found')

  const gmail = getGmailClient(thread.inbox || INBOXES[0])
  await gmail.users.threads.modify({
    userId: 'me',
    id: thread.gmail_thread_id,
    requestBody: { removeLabelIds: ['UNREAD'] },
  })

  await db`UPDATE email_threads SET status = 'triaged', updated_at = now() WHERE id = ${threadId}`
}

async function trashThread(threadId) {
  const [thread] = await db`SELECT * FROM email_threads WHERE id = ${threadId}`
  if (!thread) throw new Error('Thread not found')

  const gmail = getGmailClient(thread.inbox || INBOXES[0])
  await gmail.users.threads.trash({
    userId: 'me',
    id: thread.gmail_thread_id,
  })

  await db`UPDATE email_threads SET status = 'archived', updated_at = now() WHERE id = ${threadId}`
  logger.info(`Trashed thread: ${thread.subject}`)
}

async function sendReply(threadId, body) {
  const [thread] = await db`SELECT * FROM email_threads WHERE gmail_thread_id = ${threadId}`
  if (!thread) throw new Error('Thread not found')

  const inbox = thread.inbox || INBOXES[0]
  const gmail = getGmailClient(inbox)

  const raw = createRawEmail({
    to: thread.from_email,
    from: inbox,
    subject: `Re: ${thread.subject || ''}`,
    body,
    inReplyTo: thread.gmail_message_ids?.[thread.gmail_message_ids.length - 1],
  })

  await gmail.users.messages.send({
    userId: 'me',
    requestBody: { raw, threadId },
  })

  await db`UPDATE email_threads SET status = 'replied', updated_at = now() WHERE gmail_thread_id = ${threadId}`
  logger.info(`Reply sent from ${inbox} to ${thread.from_email}`)
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function extractBody(message) {
  for (const mimeType of ['text/plain', 'text/html']) {
    const part = findPart(message.payload, mimeType)
    if (part?.body?.data) {
      return Buffer.from(part.body.data, 'base64url').toString('utf8')
    }
  }
  if (message.payload?.body?.data) {
    return Buffer.from(message.payload.body.data, 'base64url').toString('utf8')
  }
  return message.snippet || ''
}

function findPart(payload, mimeType) {
  if (payload.mimeType === mimeType) return payload
  for (const part of (payload.parts || [])) {
    const found = findPart(part, mimeType)
    if (found) return found
  }
  return null
}

function createRawEmail({ to, from, subject, body, inReplyTo }) {
  const lines = [
    `To: ${to}`,
    `From: ${from}`,
    `Subject: ${subject}`,
    'Content-Type: text/plain; charset=utf-8',
  ]
  if (inReplyTo) {
    lines.push(`In-Reply-To: ${inReplyTo}`)
    lines.push(`References: ${inReplyTo}`)
  }
  lines.push('', body)
  return Buffer.from(lines.join('\r\n')).toString('base64url')
}

module.exports = { pollInbox, sendReply, archiveThread, markRead, trashThread, triagePendingEmails }
