/**
 * Zernio MCP tools — unified social media API (14+ platforms).
 * Replaces per-platform integrations (LinkedIn posts, Meta posts) with a single API.
 * Docs: https://docs.zernio.com
 */
import { z } from 'zod'

const ZERNIO_API_KEY = process.env.ZERNIO_API_KEY || ''
const BASE = 'https://zernio.com/api/v1'

async function zernioFetch(path, opts = {}) {
  const url = `${BASE}${path}`
  const res = await fetch(url, {
    ...opts,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${ZERNIO_API_KEY}`,
      ...opts.headers,
    },
  })
  if (!res.ok) throw new Error(`Zernio API ${res.status}: ${await res.text()}`)
  return res.json()
}

export function registerZernioTools(server) {

  server.tool('zernio_list_accounts',
    'List all connected social media accounts (LinkedIn, Instagram, Facebook, X, TikTok, etc).',
    async () => {
      const data = await zernioFetch('/accounts')
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] }
    })

  server.tool('zernio_create_post',
    'Create and publish/schedule a post across one or more social platforms via Zernio.',
    {
      content: z.string().describe('Post text content'),
      platforms: z.array(z.object({
        platform: z.string().describe('Platform name: twitter, instagram, facebook, linkedin, tiktok, youtube, pinterest, reddit, bluesky, threads, telegram, whatsapp'),
        accountId: z.string().describe('Account ID from zernio_list_accounts'),
      })).describe('Array of {platform, accountId} objects. Get accountIds from zernio_list_accounts.'),
      scheduledFor: z.string().optional().describe('ISO datetime to schedule (optional — publishes immediately if omitted)'),
      timezone: z.string().optional().describe('Timezone for scheduling (default: Australia/Sydney)'),
      mediaUrls: z.array(z.string()).optional().describe('Array of media URLs to attach (optional)'),
    },
    async ({ content, platforms, scheduledFor, timezone, mediaUrls }) => {
      const body = { content, platforms, timezone: timezone || 'Australia/Sydney' }
      if (scheduledFor) body.scheduledFor = scheduledFor
      if (mediaUrls?.length) body.mediaUrls = mediaUrls
      const data = await zernioFetch('/posts', {
        method: 'POST',
        body: JSON.stringify(body),
      })
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] }
    })

  server.tool('zernio_list_posts',
    'List posts from Zernio (published, scheduled, drafts).',
    {
      status: z.string().optional().describe('Filter: published, scheduled, draft (optional)'),
      limit: z.number().optional().describe('Max results (default 20)'),
    },
    async ({ status, limit } = {}) => {
      const params = new URLSearchParams({ limit: String(limit || 20) })
      if (status) params.set('status', status)
      const data = await zernioFetch(`/posts?${params}`)
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] }
    })

  server.tool('zernio_get_post',
    'Get a specific post by ID with platform-level details.',
    {
      postId: z.string().describe('Zernio post ID'),
    },
    async ({ postId }) => {
      const data = await zernioFetch(`/posts/${postId}`)
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] }
    })

  server.tool('zernio_delete_post',
    'Delete an unpublished post, or unpublish a published post from platforms.',
    {
      postId: z.string().describe('Zernio post ID'),
      unpublish: z.boolean().optional().describe('If true, removes from platforms (not just Zernio). Default false.'),
    },
    async ({ postId, unpublish }) => {
      if (unpublish) {
        const data = await zernioFetch(`/posts/${postId}/unpublish`, { method: 'POST' })
        return { content: [{ type: 'text', text: `Post unpublished from platforms. ${JSON.stringify(data)}` }] }
      }
      await zernioFetch(`/posts/${postId}`, { method: 'DELETE' })
      return { content: [{ type: 'text', text: 'Post deleted.' }] }
    })

  server.tool('zernio_get_analytics',
    'Get engagement analytics for posts (likes, comments, shares, impressions).',
    {
      postId: z.string().optional().describe('Filter to specific post (optional)'),
      accountId: z.string().optional().describe('Filter to specific account (optional)'),
      period: z.string().optional().describe('Time period: 7d, 30d, 90d (default 30d)'),
    },
    async ({ postId, accountId, period } = {}) => {
      const params = new URLSearchParams({ period: period || '30d' })
      if (postId) params.set('postId', postId)
      if (accountId) params.set('accountId', accountId)
      const data = await zernioFetch(`/analytics?${params}`)
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] }
    })

  server.tool('zernio_best_time_to_post',
    'Get optimal posting times based on historical engagement data.',
    {
      accountId: z.string().optional().describe('Account ID to analyze (optional — all accounts if omitted)'),
    },
    async ({ accountId } = {}) => {
      const params = accountId ? `?accountId=${accountId}` : ''
      const data = await zernioFetch(`/analytics/best-time-to-post${params}`)
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] }
    })

  server.tool('zernio_get_conversations',
    'Get DM conversations across all connected platforms.',
    {
      accountId: z.string().optional().describe('Filter to specific account (optional)'),
      limit: z.number().optional().describe('Max conversations (default 20)'),
    },
    async ({ accountId, limit } = {}) => {
      const params = new URLSearchParams({ limit: String(limit || 20) })
      if (accountId) params.set('accountId', accountId)
      const data = await zernioFetch(`/messages/conversations?${params}`)
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] }
    })

  server.tool('zernio_send_message',
    'Send a DM in a conversation on any connected platform.',
    {
      conversationId: z.string().describe('Conversation ID from zernio_get_conversations'),
      message: z.string().describe('Message text'),
    },
    async ({ conversationId, message }) => {
      const data = await zernioFetch('/messages/conversations', {
        method: 'POST',
        body: JSON.stringify({ conversationId, message }),
      })
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] }
    })

  server.tool('zernio_get_comments',
    'List comments on posts across platforms.',
    {
      postId: z.string().optional().describe('Filter to specific post (optional)'),
      limit: z.number().optional().describe('Max comments (default 20)'),
    },
    async ({ postId, limit } = {}) => {
      const params = new URLSearchParams({ limit: String(limit || 20) })
      if (postId) params.set('postId', postId)
      const data = await zernioFetch(`/comments?${params}`)
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] }
    })

  server.tool('zernio_reply_comment',
    'Reply to a comment on any platform.',
    {
      commentId: z.string().describe('Comment ID from zernio_get_comments'),
      message: z.string().describe('Reply text'),
    },
    async ({ commentId, message }) => {
      const data = await zernioFetch(`/comments/${commentId}/reply`, {
        method: 'POST',
        body: JSON.stringify({ message }),
      })
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] }
    })

  server.tool('zernio_get_upload_url',
    'Get a presigned URL for uploading media (images/videos up to 5GB) to attach to posts.',
    {
      filename: z.string().describe('File name with extension (e.g. banner.jpg)'),
      contentType: z.string().describe('MIME type (e.g. image/jpeg, video/mp4)'),
    },
    async ({ filename, contentType }) => {
      const params = new URLSearchParams({ filename, contentType })
      const data = await zernioFetch(`/media/presigned-url?${params}`)
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] }
    })
}
