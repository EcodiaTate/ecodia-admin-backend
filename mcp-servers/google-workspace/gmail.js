/**
 * Gmail MCP tools — read, send, reply, archive, label.
 */
import { z } from 'zod'
import { getGmailClient, primaryAccount } from './auth.js'

// Parse JSON-if-string, pass-through otherwise. Mirrors 35cdb2e (numeric) and 0bec7dd (object).
// On malformed JSON the raw value is passed through so z.array rejects it as a Zod error
// rather than throwing a raw SyntaxError that would crash the MCP server.
const arrayParam = (inner, description) =>
  z.preprocess(
    (v) => {
      if (typeof v !== 'string') return v
      try { return JSON.parse(v) } catch { return v }
    },
    z.array(inner)
  ).describe(description)

const optionalArrayParam = (inner, description) =>
  z.preprocess(
    (v) => {
      if (v === undefined || v === null) return v
      if (typeof v !== 'string') return v
      try { return JSON.parse(v) } catch { return v }
    },
    z.array(inner)
  ).optional().describe(description)

const INTERNAL_DOMAIN = 'ecodia.au'
const SUPABASE_URL = process.env.SUPABASE_URL
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY

function decodeBody(parts) {
  if (!parts) return ''
  for (const part of parts) {
    if (part.mimeType === 'text/plain' && part.body?.data) {
      return Buffer.from(part.body.data, 'base64url').toString('utf-8')
    }
    if (part.parts) {
      const nested = decodeBody(part.parts)
      if (nested) return nested
    }
  }
  for (const part of parts) {
    if (part.mimeType === 'text/html' && part.body?.data) {
      return Buffer.from(part.body.data, 'base64url').toString('utf-8')
    }
  }
  return ''
}

function getHeader(headers, name) {
  return headers?.find(h => h.name.toLowerCase() === name.toLowerCase())?.value || ''
}

// RFC 2047 encoded-word encoding for non-ASCII header values (RFC 2822 §2.2).
// Gmail (and all RFC-compliant clients) require header values to be ASCII-only;
// multi-byte characters must be wrapped as =?UTF-8?B?<base64>?= or they get
// treated as Latin-1 and rendered as mojibake.
function encodeHeaderValue(str) {
  if (!str || !/[^\x00-\x7F]/.test(str)) return str
  return `=?UTF-8?B?${Buffer.from(str, 'utf-8').toString('base64')}?=`
}

// ── External-send gate helpers ───────────────────────────────────────────────

function extractEmailsFromField(field) {
  if (!field) return []
  const s = Array.isArray(field) ? field.join(',') : String(field)
  const matches = s.match(/[\w.+-]+@[\w.-]+\.[a-zA-Z]{2,}/g) || []
  return matches.map(e => e.trim().toLowerCase())
}

function externalRecipients({ to, cc, bcc }) {
  const all = [...extractEmailsFromField(to), ...extractEmailsFromField(cc), ...extractEmailsFromField(bcc)]
  return all.filter(e => {
    const domain = e.split('@')[1] || ''
    return domain && domain !== INTERNAL_DOMAIN
  })
}

async function auditExternalSend({ inbox, to, cc, bcc, external, subject, tateGoaheadRef, messageId, threadId }) {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) return
  const allRecipients = [...extractEmailsFromField(to), ...extractEmailsFromField(cc), ...extractEmailsFromField(bcc)]
  try {
    await fetch(`${SUPABASE_URL}/rest/v1/external_send_audit`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': SUPABASE_SERVICE_ROLE_KEY,
        'Authorization': `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
        'Prefer': 'return=minimal',
      },
      body: JSON.stringify({
        inbox: inbox || primaryAccount,
        recipients_all: allRecipients,
        external_recipients: external,
        subject: subject || null,
        tate_goahead_ref: tateGoaheadRef,
        message_id: messageId || null,
        thread_id: threadId || null,
      }),
    })
  } catch (_) { /* non-blocking — gate already fired, audit failure should not break send */ }
}

// ── Tool registration ────────────────────────────────────────────────────────

export function registerGmailTools(server) {

  server.tool('gmail_list_messages',
    'Search/list Gmail messages. Returns subject, from, date, snippet.',
    { query: z.string().default('is:unread').describe('Gmail search query'), maxResults: z.number().default(20).describe('Max messages (max 100)'), inbox: z.string().optional().describe('Email account (default: primary)') },
    async ({ query, maxResults, inbox }) => {
      const gmail = getGmailClient(inbox || primaryAccount)
      const res = await gmail.users.messages.list({ userId: 'me', q: query, maxResults: Math.min(maxResults || 20, 100) })
      const messages = res.data.messages || []
      if (messages.length === 0) return { content: [{ type: 'text', text: 'No messages found.' }] }
      const results = []
      for (const msg of messages.slice(0, 50)) {
        const detail = await gmail.users.messages.get({ userId: 'me', id: msg.id, format: 'metadata', metadataHeaders: ['Subject', 'From', 'Date', 'To'] })
        const headers = detail.data.payload?.headers || []
        results.push({ id: msg.id, threadId: msg.threadId, subject: getHeader(headers, 'Subject'), from: getHeader(headers, 'From'), to: getHeader(headers, 'To'), date: getHeader(headers, 'Date'), snippet: detail.data.snippet, labels: detail.data.labelIds })
      }
      return { content: [{ type: 'text', text: JSON.stringify(results, null, 2) }] }
    }
  )

  server.tool('gmail_get_message',
    'Read the full content of a Gmail message by ID.',
    { messageId: z.string().describe('The message ID'), inbox: z.string().optional().describe('Email account (default: primary)') },
    async ({ messageId, inbox }) => {
      const gmail = getGmailClient(inbox || primaryAccount)
      const res = await gmail.users.messages.get({ userId: 'me', id: messageId, format: 'full' })
      const headers = res.data.payload?.headers || []
      const body = decodeBody(res.data.payload?.parts || [res.data.payload])
      return { content: [{ type: 'text', text: JSON.stringify({ id: res.data.id, threadId: res.data.threadId, subject: getHeader(headers, 'Subject'), from: getHeader(headers, 'From'), to: getHeader(headers, 'To'), date: getHeader(headers, 'Date'), labels: res.data.labelIds, body: body.slice(0, 10000) }, null, 2) }] }
    }
  )

  server.tool('gmail_get_thread',
    'Read all messages in a Gmail thread.',
    { threadId: z.string().describe('The thread ID'), inbox: z.string().optional().describe('Email account (default: primary)') },
    async ({ threadId, inbox }) => {
      const gmail = getGmailClient(inbox || primaryAccount)
      const res = await gmail.users.threads.get({ userId: 'me', id: threadId, format: 'full' })
      const messages = (res.data.messages || []).map(msg => {
        const headers = msg.payload?.headers || []
        const body = decodeBody(msg.payload?.parts || [msg.payload])
        return { id: msg.id, from: getHeader(headers, 'From'), to: getHeader(headers, 'To'), date: getHeader(headers, 'Date'), subject: getHeader(headers, 'Subject'), body: body.slice(0, 5000) }
      })
      return { content: [{ type: 'text', text: JSON.stringify(messages, null, 2) }] }
    }
  )

  server.tool('gmail_send',
    'Send a new email.',
    {
      to: z.string().describe('Recipient email'),
      subject: z.string().describe('Email subject'),
      body: z.string().describe('Email body (plain text)'),
      cc: z.string().optional().describe('CC recipients (comma-separated)'),
      inbox: z.string().optional().describe('Send-as email account'),
      allowExternal: z.boolean().optional().describe('Must be true to send to any non-ecodia.au recipient'),
      tateGoaheadRef: z.string().optional().describe('Required when allowExternal=true. Pointer to Tate authorisation: SMS id, kv_store key, status_board row id, or free-text explanation.'),
    },
    async ({ to, subject, body, cc, inbox, allowExternal, tateGoaheadRef }) => {
      const external = externalRecipients({ to, cc })
      if (external.length > 0) {
        if (allowExternal !== true) {
          throw new Error(`External send blocked. Recipients: ${external.join(', ')}. Pattern file: /home/tate/ecodiaos/patterns/no-client-contact-without-tate-goahead.md. To send, call gmail_send again with allowExternal=true and tateGoaheadRef populated. Tate must authorise every client-facing send.`)
        }
        if (!tateGoaheadRef || !tateGoaheadRef.trim()) {
          throw new Error('allowExternal=true requires tateGoaheadRef (non-empty string).')
        }
      }
      const gmail = getGmailClient(inbox || primaryAccount)
      const from = inbox || primaryAccount
      const headers = [`From: ${from}`, `To: ${to}`, cc ? `Cc: ${cc}` : '', `Subject: ${encodeHeaderValue(subject)}`, 'Content-Type: text/plain; charset=utf-8', '', body].filter(Boolean).join('\r\n')
      const raw = Buffer.from(headers).toString('base64url')
      const res = await gmail.users.messages.send({ userId: 'me', requestBody: { raw } })
      if (external.length > 0) {
        await auditExternalSend({ inbox, to, cc, bcc: undefined, external, subject, tateGoaheadRef, messageId: res.data.id })
        return { content: [{ type: 'text', text: `EXTERNAL SEND (audited, ref="${tateGoaheadRef}"): Sent. Message ID: ${res.data.id}` }] }
      }
      return { content: [{ type: 'text', text: `Sent. Message ID: ${res.data.id}` }] }
    }
  )

  server.tool('gmail_reply',
    'Reply to an existing email thread.',
    {
      threadId: z.string().describe('Thread ID to reply to'),
      to: z.string().describe('Recipient email'),
      body: z.string().describe('Reply body'),
      subject: z.string().optional().describe('Subject (usually Re: original)'),
      messageId: z.string().optional().describe('Message ID for In-Reply-To header'),
      inbox: z.string().optional().describe('Send-as email account'),
      allowExternal: z.boolean().optional().describe('Must be true to send to any non-ecodia.au recipient'),
      tateGoaheadRef: z.string().optional().describe('Required when allowExternal=true. Pointer to Tate authorisation: SMS id, kv_store key, status_board row id, or free-text explanation.'),
    },
    async ({ threadId, messageId, to, body, subject, inbox, allowExternal, tateGoaheadRef }) => {
      const gmail = getGmailClient(inbox || primaryAccount)

      // Collect all participant emails from thread to detect external recipients
      const threadRes = await gmail.users.threads.get({ userId: 'me', id: threadId, format: 'metadata', metadataHeaders: ['From', 'To', 'Cc'] })
      const participantFields = [to]
      for (const msg of (threadRes.data.messages || [])) {
        const headers = msg.payload?.headers || []
        participantFields.push(
          getHeader(headers, 'From'),
          getHeader(headers, 'To'),
          getHeader(headers, 'Cc'),
        )
      }
      const external = externalRecipients({ to: participantFields.join(','), cc: undefined, bcc: undefined })

      if (external.length > 0) {
        if (allowExternal !== true) {
          throw new Error(`External send blocked. Recipients: ${external.join(', ')}. Pattern file: /home/tate/ecodiaos/patterns/no-client-contact-without-tate-goahead.md. To send, call gmail_reply again with allowExternal=true and tateGoaheadRef populated. Tate must authorise every client-facing send.`)
        }
        if (!tateGoaheadRef || !tateGoaheadRef.trim()) {
          throw new Error('allowExternal=true requires tateGoaheadRef (non-empty string).')
        }
      }

      const from = inbox || primaryAccount
      const headers = [`From: ${from}`, `To: ${to}`, `Subject: ${encodeHeaderValue(subject || 'Re:')}`, messageId ? `In-Reply-To: ${messageId}` : '', messageId ? `References: ${messageId}` : '', 'Content-Type: text/plain; charset=utf-8', '', body].filter(Boolean).join('\r\n')
      const raw = Buffer.from(headers).toString('base64url')
      const res = await gmail.users.messages.send({ userId: 'me', requestBody: { raw, threadId } })

      if (external.length > 0) {
        await auditExternalSend({ inbox, to, cc: undefined, bcc: undefined, external, subject: subject || 'Re:', tateGoaheadRef, messageId: res.data.id, threadId })
        return { content: [{ type: 'text', text: `EXTERNAL SEND (audited, ref="${tateGoaheadRef}"): Reply sent. Message ID: ${res.data.id}` }] }
      }
      return { content: [{ type: 'text', text: `Reply sent. Message ID: ${res.data.id}` }] }
    }
  )

  server.tool('gmail_modify_labels',
    'Add or remove labels from a message.',
    { messageId: z.string().describe('Message ID'), addLabels: optionalArrayParam(z.string(), 'Label IDs to add'), removeLabels: optionalArrayParam(z.string(), 'Label IDs to remove'), inbox: z.string().optional().describe('Email account') },
    async ({ messageId, addLabels, removeLabels, inbox }) => {
      const gmail = getGmailClient(inbox || primaryAccount)
      await gmail.users.messages.modify({ userId: 'me', id: messageId, requestBody: { addLabelIds: addLabels || [], removeLabelIds: removeLabels || [] } })
      return { content: [{ type: 'text', text: `Labels modified on ${messageId}` }] }
    }
  )

  server.tool('gmail_archive',
    'Archive one or more messages (removes INBOX label).',
    { messageIds: arrayParam(z.string(), 'Message IDs to archive'), inbox: z.string().optional().describe('Email account') },
    async ({ messageIds, inbox }) => {
      const gmail = getGmailClient(inbox || primaryAccount)
      for (const id of messageIds) {
        await gmail.users.messages.modify({ userId: 'me', id, requestBody: { removeLabelIds: ['INBOX'] } })
      }
      return { content: [{ type: 'text', text: `Archived ${messageIds.length} message(s)` }] }
    }
  )

  server.tool('gmail_create_draft',
    'Create an email draft (saved but not sent). Use for review workflows.',
    { to: z.string(), subject: z.string(), body: z.string(), cc: z.string().optional(), threadId: z.string().optional().describe('Thread ID to make this a reply draft'), inbox: z.string().optional() },
    async ({ to, subject, body, cc, threadId, inbox }) => {
      const gmail = getGmailClient(inbox || primaryAccount)
      const from = inbox || primaryAccount
      const headers = [`From: ${from}`, `To: ${to}`, cc ? `Cc: ${cc}` : '', `Subject: ${encodeHeaderValue(subject)}`, 'Content-Type: text/plain; charset=utf-8', '', body].filter(Boolean).join('\r\n')
      const raw = Buffer.from(headers).toString('base64url')
      const requestBody = { message: { raw } }
      if (threadId) requestBody.message.threadId = threadId
      const res = await gmail.users.drafts.create({ userId: 'me', requestBody })
      return { content: [{ type: 'text', text: `Draft created. Draft ID: ${res.data.id}` }] }
    }
  )

  server.tool('gmail_list_labels',
    'List all available Gmail labels.',
    { inbox: z.string().optional() },
    async ({ inbox }) => {
      const gmail = getGmailClient(inbox || primaryAccount)
      const res = await gmail.users.labels.list({ userId: 'me' })
      const labels = (res.data.labels || []).map(l => ({ id: l.id, name: l.name, type: l.type }))
      return { content: [{ type: 'text', text: JSON.stringify(labels, null, 2) }] }
    }
  )

  server.tool('gmail_create_label',
    'Create a custom Gmail label.',
    { name: z.string().describe('Label name (use / for nesting, e.g. "Clients/Active")'), inbox: z.string().optional() },
    async ({ name, inbox }) => {
      const gmail = getGmailClient(inbox || primaryAccount)
      const res = await gmail.users.labels.create({ userId: 'me', requestBody: { name, labelListVisibility: 'labelShow', messageListVisibility: 'show' } })
      return { content: [{ type: 'text', text: `Label created: ${res.data.name} (ID: ${res.data.id})` }] }
    }
  )

  server.tool('gmail_trash',
    'Move messages to trash.',
    { messageIds: arrayParam(z.string(), 'Message IDs to trash'), inbox: z.string().optional() },
    async ({ messageIds, inbox }) => {
      const gmail = getGmailClient(inbox || primaryAccount)
      for (const id of messageIds) {
        await gmail.users.messages.trash({ userId: 'me', id })
      }
      return { content: [{ type: 'text', text: `Trashed ${messageIds.length} message(s)` }] }
    }
  )

  server.tool('gmail_mark_read',
    'Mark messages as read.',
    { messageIds: arrayParam(z.string(), 'Message IDs'), inbox: z.string().optional() },
    async ({ messageIds, inbox }) => {
      const gmail = getGmailClient(inbox || primaryAccount)
      for (const id of messageIds) {
        await gmail.users.messages.modify({ userId: 'me', id, requestBody: { removeLabelIds: ['UNREAD'] } })
      }
      return { content: [{ type: 'text', text: `Marked ${messageIds.length} message(s) as read` }] }
    }
  )
}
