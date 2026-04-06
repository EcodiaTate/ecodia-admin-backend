/**
 * Gmail MCP tools — read, send, reply, archive, label.
 */
import { z } from 'zod'
import { getGmailClient, primaryAccount } from './auth.js'

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
    { to: z.string().describe('Recipient email'), subject: z.string().describe('Email subject'), body: z.string().describe('Email body (plain text)'), cc: z.string().optional().describe('CC recipients (comma-separated)'), inbox: z.string().optional().describe('Send-as email account') },
    async ({ to, subject, body, cc, inbox }) => {
      const gmail = getGmailClient(inbox || primaryAccount)
      const from = inbox || primaryAccount
      const headers = [`From: ${from}`, `To: ${to}`, cc ? `Cc: ${cc}` : '', `Subject: ${subject}`, 'Content-Type: text/plain; charset=utf-8', '', body].filter(Boolean).join('\r\n')
      const raw = Buffer.from(headers).toString('base64url')
      const res = await gmail.users.messages.send({ userId: 'me', requestBody: { raw } })
      return { content: [{ type: 'text', text: `Sent. Message ID: ${res.data.id}` }] }
    }
  )

  server.tool('gmail_reply',
    'Reply to an existing email thread.',
    { threadId: z.string().describe('Thread ID to reply to'), to: z.string().describe('Recipient email'), body: z.string().describe('Reply body'), subject: z.string().optional().describe('Subject (usually Re: original)'), messageId: z.string().optional().describe('Message ID for In-Reply-To header'), inbox: z.string().optional().describe('Send-as email account') },
    async ({ threadId, messageId, to, body, subject, inbox }) => {
      const gmail = getGmailClient(inbox || primaryAccount)
      const from = inbox || primaryAccount
      const headers = [`From: ${from}`, `To: ${to}`, `Subject: ${subject || 'Re:'}`, messageId ? `In-Reply-To: ${messageId}` : '', messageId ? `References: ${messageId}` : '', 'Content-Type: text/plain; charset=utf-8', '', body].filter(Boolean).join('\r\n')
      const raw = Buffer.from(headers).toString('base64url')
      const res = await gmail.users.messages.send({ userId: 'me', requestBody: { raw, threadId } })
      return { content: [{ type: 'text', text: `Reply sent. Message ID: ${res.data.id}` }] }
    }
  )

  server.tool('gmail_modify_labels',
    'Add or remove labels from a message.',
    { messageId: z.string().describe('Message ID'), addLabels: z.array(z.string()).optional().describe('Label IDs to add'), removeLabels: z.array(z.string()).optional().describe('Label IDs to remove'), inbox: z.string().optional().describe('Email account') },
    async ({ messageId, addLabels, removeLabels, inbox }) => {
      const gmail = getGmailClient(inbox || primaryAccount)
      await gmail.users.messages.modify({ userId: 'me', id: messageId, requestBody: { addLabelIds: addLabels || [], removeLabelIds: removeLabels || [] } })
      return { content: [{ type: 'text', text: `Labels modified on ${messageId}` }] }
    }
  )

  server.tool('gmail_archive',
    'Archive one or more messages (removes INBOX label).',
    { messageIds: z.array(z.string()).describe('Message IDs to archive'), inbox: z.string().optional().describe('Email account') },
    async ({ messageIds, inbox }) => {
      const gmail = getGmailClient(inbox || primaryAccount)
      for (const id of messageIds) {
        await gmail.users.messages.modify({ userId: 'me', id, requestBody: { removeLabelIds: ['INBOX'] } })
      }
      return { content: [{ type: 'text', text: `Archived ${messageIds.length} message(s)` }] }
    }
  )
}
