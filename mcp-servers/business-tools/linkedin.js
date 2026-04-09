/**
 * LinkedIn MCP tools — DMs, posts, connections.
 * Note: LinkedIn doesn't have a proper API for DMs. These tools call
 * the EcodiaOS backend API which uses browser automation under the hood.
 */
import { z } from 'zod'

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

  server.tool('linkedin_check_dms',
    'Check recent LinkedIn DMs. Returns conversations with messages, categories, and lead scores.',
    z.object({
      limit: z.number().optional().describe('Max conversations (default 20)'),
      unreadOnly: z.boolean().optional().describe('Only unread (default false)'),
    }),
    async ({ limit = 20, unreadOnly = false } = {}) => {
      const params = new URLSearchParams({ limit: String(limit) })
      if (unreadOnly) params.set('status', 'unread')
      const data = await backendFetch(`/api/linkedin/dms?${params}`)
      return { content: [{ type: 'text', text: JSON.stringify(data.dms || data, null, 2) }] }
    })

  server.tool('linkedin_send_dm',
    'Send a LinkedIn DM reply (via backend browser automation).',
    z.object({
      conversationId: z.string().describe('LinkedIn conversation ID'),
      message: z.string().describe('Message text to send'),
    }),
    async ({ conversationId, message }) => {
      const data = await backendFetch('/api/linkedin/dms/reply', {
        method: 'POST',
        body: JSON.stringify({ conversationId, message }),
      })
      return { content: [{ type: 'text', text: data.success ? 'DM sent.' : `Failed: ${data.error}` }] }
    })

  server.tool('linkedin_get_posts',
    'Get recent LinkedIn posts (published and scheduled).',
    z.object({
      limit: z.number().optional().describe('Max posts (default 20)'),
    }),
    async ({ limit = 20 } = {}) => {
      const data = await backendFetch(`/api/linkedin/posts?limit=${limit}`)
      return { content: [{ type: 'text', text: JSON.stringify(data.posts || data, null, 2) }] }
    })

  server.tool('linkedin_create_post',
    'Create and publish a LinkedIn post (via backend).',
    z.object({
      content: z.string().describe('Post text content'),
      scheduleAt: z.string().optional().describe('ISO datetime to schedule (optional, publishes immediately if omitted)'),
    }),
    async ({ content, scheduleAt }) => {
      const data = await backendFetch('/api/linkedin/posts', {
        method: 'POST',
        body: JSON.stringify({ content, scheduledAt: scheduleAt }),
      })
      return { content: [{ type: 'text', text: `Post ${scheduleAt ? 'scheduled' : 'created'}. ID: ${data.id || 'ok'}` }] }
    })
}
