const { google } = require('googleapis')
const env = require('../config/env')
const db = require('../config/db')
const logger = require('../config/logger')
const { createNotification } = require('../db/queries/transactions')
const { findClientByEmail } = require('../db/queries/clients')

const IMPERSONATE_EMAIL = 'code@ecodia.au'

async function getGmailClient() {
  const credentials = JSON.parse(env.GOOGLE_SERVICE_ACCOUNT_JSON)
  // Ensure private_key newlines are actual newlines (not literal \n from env)
  const privateKey = credentials.private_key.replace(/\\n/g, '\n')
  const auth = new google.auth.JWT({
    email: credentials.client_email,
    key: privateKey,
    scopes: ['https://www.googleapis.com/auth/gmail.modify'],
    subject: IMPERSONATE_EMAIL,
  })
  await auth.authorize()
  return google.gmail({ version: 'v1', auth })
}

async function pollInbox() {
  logger.info('Gmail poll started')
  const gmail = await getGmailClient()

  // Check if we have a stored historyId for incremental sync
  const [syncState] = await db`SELECT * FROM gmail_sync_state LIMIT 1`

  if (syncState) {
    await incrementalSync(gmail, syncState.history_id)
  } else {
    await fullSync(gmail)
  }

  logger.info('Gmail poll complete')
}

async function fullSync(gmail) {
  // First sync — grab recent threads
  const res = await gmail.users.threads.list({
    userId: 'me',
    maxResults: 20,
    labelIds: ['INBOX'],
  })

  const threads = res.data.threads || []
  logger.info(`Full sync: found ${threads.length} threads`)

  for (const thread of threads) {
    await processThread(gmail, thread.id)
  }

  // Store the current historyId for future incremental syncs
  const profile = await gmail.users.getProfile({ userId: 'me' })
  await db`
    INSERT INTO gmail_sync_state (history_id)
    VALUES (${profile.data.historyId})
  `
}

async function incrementalSync(gmail, historyId) {
  try {
    const res = await gmail.users.history.list({
      userId: 'me',
      startHistoryId: historyId,
      historyTypes: ['messageAdded'],
      labelId: 'INBOX',
    })

    const history = res.data.history || []

    // Collect unique thread IDs from new messages
    const threadIds = new Set()
    for (const h of history) {
      for (const msg of (h.messagesAdded || [])) {
        threadIds.add(msg.message.threadId)
      }
    }

    logger.info(`Incremental sync: ${threadIds.size} updated threads`)

    for (const threadId of threadIds) {
      await processThread(gmail, threadId)
    }

    // Update historyId
    if (res.data.historyId) {
      await db`UPDATE gmail_sync_state SET history_id = ${res.data.historyId}, updated_at = now()`
    }
  } catch (err) {
    if (err.code === 404) {
      // historyId expired — do a full sync
      logger.warn('History ID expired, falling back to full sync')
      await db`DELETE FROM gmail_sync_state`
      await fullSync(await getGmailClient())
    } else {
      throw err
    }
  }
}

async function processThread(gmail, threadId) {
  // Check if we already have this thread
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
  const fromName = fromRaw.match(/^"?([^"<]+)"?\s*</)?.[ 1]?.trim() || null

  const subject = getHeader('Subject')
  const snippet = firstMsg.snippet || ''
  const body = extractBody(lastMsg)

  const messageIds = messages.map(m => m.id)
  // Collect labels from ALL messages in thread — if any message is UNREAD, thread is unread
  const allLabels = [...new Set(messages.flatMap(m => m.labelIds || []))]
  const isUnread = allLabels.includes('UNREAD')
  const receivedAt = new Date(parseInt(firstMsg.internalDate))

  // Try to match sender to a client
  const client = await findClientByEmail(fromEmail)

  const [inserted] = await db`
    INSERT INTO email_threads (
      gmail_thread_id, gmail_message_ids, subject, from_email, from_name,
      snippet, full_body, labels, client_id, received_at, status
    ) VALUES (
      ${threadId}, ${messageIds}, ${subject}, ${fromEmail}, ${fromName},
      ${snippet}, ${body}, ${allLabels}, ${client?.id || null}, ${receivedAt},
      ${isUnread ? 'unread' : 'triaged'}
    )
    RETURNING *
  `

  // Create notification
  await createNotification({
    type: 'email',
    message: `New email from ${fromName || fromEmail}: ${subject}`,
    link: `/gmail`,
    metadata: { threadId: inserted.id },
  }).catch(err => logger.warn('Failed to create email notification', { error: err.message }))

  logger.info(`Processed thread: ${subject} from ${fromEmail}`)
}

function extractBody(message) {
  const parts = message.payload?.parts || []

  // Try to get text/plain first, then text/html
  for (const mimeType of ['text/plain', 'text/html']) {
    const part = findPart(message.payload, mimeType)
    if (part?.body?.data) {
      return Buffer.from(part.body.data, 'base64url').toString('utf8')
    }
  }

  // Fallback: body directly on payload
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

async function sendReply(threadId, body) {
  const gmail = await getGmailClient()

  const [thread] = await db`SELECT * FROM email_threads WHERE gmail_thread_id = ${threadId}`
  if (!thread) throw new Error('Thread not found')

  const raw = createRawEmail({
    to: thread.from_email,
    subject: `Re: ${thread.subject || ''}`,
    body,
    threadId,
    inReplyTo: thread.gmail_message_ids?.[thread.gmail_message_ids.length - 1],
  })

  await gmail.users.messages.send({
    userId: 'me',
    requestBody: {
      raw,
      threadId,
    },
  })

  logger.info(`Reply sent to ${thread.from_email} in thread ${threadId}`)
}

function createRawEmail({ to, subject, body, inReplyTo }) {
  const lines = [
    `To: ${to}`,
    `From: ${IMPERSONATE_EMAIL}`,
    `Subject: ${subject}`,
    `Content-Type: text/plain; charset=utf-8`,
  ]
  if (inReplyTo) {
    lines.push(`In-Reply-To: ${inReplyTo}`)
    lines.push(`References: ${inReplyTo}`)
  }
  lines.push('', body)

  return Buffer.from(lines.join('\r\n')).toString('base64url')
}

module.exports = { pollInbox, sendReply }
