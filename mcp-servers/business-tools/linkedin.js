/**
 * LinkedIn MCP tools — DMs, posts, connections.
 * Note: LinkedIn doesn't have a proper API for DMs. These tools call
 * the EcodiaOS backend API which uses browser automation under the hood.
 */
const BACKEND_URL = process.env.ECODIA_BACKEND_URL || 'http://localhost:3001'
const BACKEND_TOKEN = process.env.ECODIA_INTERNAL_TOKEN || ''

async function backendFetch(path, opts = {}) {
  const res = await fetch(`${BACKEND_URL}${path}`, {
    ...opts,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${BACKEND_TOKEN}`,
      ...opts.headers,
    },
  })
  if (!res.ok) throw new Error(`Backend ${res.status}: ${await res.text()}`)
  return res.json()
}

export function registerLinkedInTools(server) {

  server.tool('linkedin_check_dms', {
    description: 'Check recent LinkedIn DMs. Returns conversations with messages, categories, and lead scores.',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: 'Max conversations (default 20)' },
        unreadOnly: { type: 'boolean', description: 'Only unread (default false)' },
      },
    },
  }, async ({ limit = 20, unreadOnly = false }) => {
    const params = new URLSearchParams({ limit: String(limit) })
    if (unreadOnly) params.set('status', 'unread')
    const data = await backendFetch(`/api/linkedin/dms?${params}`)
    return { content: [{ type: 'text', text: JSON.stringify(data.dms || data, null, 2) }] }
  })

  server.tool('linkedin_send_dm', {
    description: 'Send a LinkedIn DM reply (via backend browser automation).',
    inputSchema: {
      type: 'object',
      properties: {
        conversationId: { type: 'string', description: 'LinkedIn conversation ID' },
        message: { type: 'string', description: 'Message text to send' },
      },
      required: ['conversationId', 'message'],
    },
  }, async ({ conversationId, message }) => {
    const data = await backendFetch('/api/linkedin/dms/reply', {
      method: 'POST',
      body: JSON.stringify({ conversationId, message }),
    })
    return { content: [{ type: 'text', text: data.success ? 'DM sent.' : `Failed: ${data.error}` }] }
  })

  server.tool('linkedin_get_posts', {
    description: 'Get recent LinkedIn posts (published and scheduled).',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: 'Max posts (default 20)' },
      },
    },
  }, async ({ limit = 20 }) => {
    const data = await backendFetch(`/api/linkedin/posts?limit=${limit}`)
    return { content: [{ type: 'text', text: JSON.stringify(data.posts || data, null, 2) }] }
  })

  server.tool('linkedin_create_post', {
    description: 'Create and publish a LinkedIn post (via backend).',
    inputSchema: {
      type: 'object',
      properties: {
        content: { type: 'string', description: 'Post text content' },
        scheduleAt: { type: 'string', description: 'ISO datetime to schedule (optional, publishes immediately if omitted)' },
      },
      required: ['content'],
    },
  }, async ({ content, scheduleAt }) => {
    const data = await backendFetch('/api/linkedin/posts', {
      method: 'POST',
      body: JSON.stringify({ content, scheduledAt: scheduleAt }),
    })
    return { content: [{ type: 'text', text: `Post ${scheduleAt ? 'scheduled' : 'created'}. ID: ${data.id || 'ok'}` }] }
  })
}
