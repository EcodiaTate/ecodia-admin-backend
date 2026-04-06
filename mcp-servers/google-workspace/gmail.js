/**
 * Gmail MCP tools — read, send, reply, archive, label.
 */
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
  // Fallback to html
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

  server.tool('gmail_list_messages', {
    description: 'Search/list Gmail messages. Returns subject, from, date, snippet for each.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Gmail search query (e.g. "is:unread", "from:client@example.com", "subject:invoice"). Default: "is:unread"' },
        maxResults: { type: 'number', description: 'Max messages to return (default 20, max 100)' },
        inbox: { type: 'string', description: 'Email account to query (default: primary account)' },
      },
    },
  }, async ({ query = 'is:unread', maxResults = 20, inbox }) => {
    const gmail = getGmailClient(inbox || primaryAccount)
    const res = await gmail.users.messages.list({
      userId: 'me',
      q: query,
      maxResults: Math.min(maxResults || 20, 100),
    })
    const messages = res.data.messages || []
    if (messages.length === 0) return { content: [{ type: 'text', text: 'No messages found.' }] }

    const results = []
    for (const msg of messages.slice(0, 50)) {
      const detail = await gmail.users.messages.get({ userId: 'me', id: msg.id, format: 'metadata', metadataHeaders: ['Subject', 'From', 'Date', 'To'] })
      const headers = detail.data.payload?.headers || []
      results.push({
        id: msg.id,
        threadId: msg.threadId,
        subject: getHeader(headers, 'Subject'),
        from: getHeader(headers, 'From'),
        to: getHeader(headers, 'To'),
        date: getHeader(headers, 'Date'),
        snippet: detail.data.snippet,
        labels: detail.data.labelIds,
      })
    }
    return { content: [{ type: 'text', text: JSON.stringify(results, null, 2) }] }
  })

  server.tool('gmail_get_message', {
    description: 'Read the full content of a Gmail message by ID.',
    inputSchema: {
      type: 'object',
      properties: {
        messageId: { type: 'string', description: 'The message ID' },
        inbox: { type: 'string', description: 'Email account (default: primary)' },
      },
      required: ['messageId'],
    },
  }, async ({ messageId, inbox }) => {
    const gmail = getGmailClient(inbox || primaryAccount)
    const res = await gmail.users.messages.get({ userId: 'me', id: messageId, format: 'full' })
    const headers = res.data.payload?.headers || []
    const body = decodeBody(res.data.payload?.parts || [res.data.payload])
    return {
      content: [{ type: 'text', text: JSON.stringify({
        id: res.data.id,
        threadId: res.data.threadId,
        subject: getHeader(headers, 'Subject'),
        from: getHeader(headers, 'From'),
        to: getHeader(headers, 'To'),
        date: getHeader(headers, 'Date'),
        labels: res.data.labelIds,
        body: body.slice(0, 10000),
      }, null, 2) }],
    }
  })

  server.tool('gmail_get_thread', {
    description: 'Read all messages in a Gmail thread.',
    inputSchema: {
      type: 'object',
      properties: {
        threadId: { type: 'string', description: 'The thread ID' },
        inbox: { type: 'string', description: 'Email account (default: primary)' },
      },
      required: ['threadId'],
    },
  }, async ({ threadId, inbox }) => {
    const gmail = getGmailClient(inbox || primaryAccount)
    const res = await gmail.users.threads.get({ userId: 'me', id: threadId, format: 'full' })
    const messages = (res.data.messages || []).map(msg => {
      const headers = msg.payload?.headers || []
      const body = decodeBody(msg.payload?.parts || [msg.payload])
      return {
        id: msg.id,
        from: getHeader(headers, 'From'),
        to: getHeader(headers, 'To'),
        date: getHeader(headers, 'Date'),
        subject: getHeader(headers, 'Subject'),
        body: body.slice(0, 5000),
      }
    })
    return { content: [{ type: 'text', text: JSON.stringify(messages, null, 2) }] }
  })

  server.tool('gmail_send', {
    description: 'Send a new email.',
    inputSchema: {
      type: 'object',
      properties: {
        to: { type: 'string', description: 'Recipient email' },
        subject: { type: 'string', description: 'Email subject' },
        body: { type: 'string', description: 'Email body (plain text)' },
        cc: { type: 'string', description: 'CC recipients (comma-separated)' },
        inbox: { type: 'string', description: 'Send-as email account (default: primary)' },
      },
      required: ['to', 'subject', 'body'],
    },
  }, async ({ to, subject, body, cc, inbox }) => {
    const gmail = getGmailClient(inbox || primaryAccount)
    const from = inbox || primaryAccount
    const headers = [
      `From: ${from}`,
      `To: ${to}`,
      cc ? `Cc: ${cc}` : '',
      `Subject: ${subject}`,
      'Content-Type: text/plain; charset=utf-8',
      '',
      body,
    ].filter(Boolean).join('\r\n')
    const raw = Buffer.from(headers).toString('base64url')
    const res = await gmail.users.messages.send({ userId: 'me', requestBody: { raw } })
    return { content: [{ type: 'text', text: `Sent. Message ID: ${res.data.id}` }] }
  })

  server.tool('gmail_reply', {
    description: 'Reply to an existing email thread.',
    inputSchema: {
      type: 'object',
      properties: {
        threadId: { type: 'string', description: 'Thread ID to reply to' },
        messageId: { type: 'string', description: 'Message ID to reply to (for In-Reply-To header)' },
        to: { type: 'string', description: 'Recipient email' },
        body: { type: 'string', description: 'Reply body (plain text)' },
        subject: { type: 'string', description: 'Subject (usually Re: original subject)' },
        inbox: { type: 'string', description: 'Send-as email account (default: primary)' },
      },
      required: ['threadId', 'to', 'body'],
    },
  }, async ({ threadId, messageId, to, body, subject, inbox }) => {
    const gmail = getGmailClient(inbox || primaryAccount)
    const from = inbox || primaryAccount
    const headers = [
      `From: ${from}`,
      `To: ${to}`,
      `Subject: ${subject || 'Re:'}`,
      messageId ? `In-Reply-To: ${messageId}` : '',
      messageId ? `References: ${messageId}` : '',
      'Content-Type: text/plain; charset=utf-8',
      '',
      body,
    ].filter(Boolean).join('\r\n')
    const raw = Buffer.from(headers).toString('base64url')
    const res = await gmail.users.messages.send({ userId: 'me', requestBody: { raw, threadId } })
    return { content: [{ type: 'text', text: `Reply sent. Message ID: ${res.data.id}` }] }
  })

  server.tool('gmail_modify_labels', {
    description: 'Add or remove labels from a message (e.g. mark read, star, move to category).',
    inputSchema: {
      type: 'object',
      properties: {
        messageId: { type: 'string', description: 'Message ID' },
        addLabels: { type: 'array', items: { type: 'string' }, description: 'Label IDs to add (e.g. ["STARRED", "IMPORTANT"])' },
        removeLabels: { type: 'array', items: { type: 'string' }, description: 'Label IDs to remove (e.g. ["UNREAD", "INBOX"])' },
        inbox: { type: 'string', description: 'Email account (default: primary)' },
      },
      required: ['messageId'],
    },
  }, async ({ messageId, addLabels, removeLabels, inbox }) => {
    const gmail = getGmailClient(inbox || primaryAccount)
    await gmail.users.messages.modify({
      userId: 'me',
      id: messageId,
      requestBody: {
        addLabelIds: addLabels || [],
        removeLabelIds: removeLabels || [],
      },
    })
    return { content: [{ type: 'text', text: `Labels modified on ${messageId}` }] }
  })

  server.tool('gmail_archive', {
    description: 'Archive one or more messages (removes INBOX label).',
    inputSchema: {
      type: 'object',
      properties: {
        messageIds: { type: 'array', items: { type: 'string' }, description: 'Message IDs to archive' },
        inbox: { type: 'string', description: 'Email account (default: primary)' },
      },
      required: ['messageIds'],
    },
  }, async ({ messageIds, inbox }) => {
    const gmail = getGmailClient(inbox || primaryAccount)
    for (const id of messageIds) {
      await gmail.users.messages.modify({
        userId: 'me',
        id,
        requestBody: { removeLabelIds: ['INBOX'] },
      })
    }
    return { content: [{ type: 'text', text: `Archived ${messageIds.length} message(s)` }] }
  })
}
