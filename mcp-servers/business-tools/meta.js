/**
 * Meta (Facebook/Instagram) MCP tools — pages, posts, conversations.
 */
import { z } from 'zod'

const META_TOKEN = process.env.META_USER_ACCESS_TOKEN || ''
const META_PAGE_ID = process.env.META_PAGE_ID || ''
const META_PAGE_TOKEN = process.env.META_PAGE_TOKEN || ''
const BASE = 'https://graph.facebook.com/v19.0'

async function metaFetch(path, token, opts = {}) {
  const url = new URL(path, BASE)
  if (!opts.method || opts.method === 'GET') url.searchParams.set('access_token', token || META_TOKEN)
  const res = await fetch(url, {
    ...opts,
    headers: { 'Content-Type': 'application/json', ...opts.headers },
  })
  if (!res.ok) throw new Error(`Meta API ${res.status}: ${await res.text()}`)
  return res.json()
}

export function registerMetaTools(server) {

  server.tool('meta_list_pages',
    'List managed Facebook/Instagram pages with follower counts.',
    async () => {
      const data = await metaFetch('/me/accounts?fields=id,name,category,fan_count,followers_count,access_token')
      const pages = (data.data || []).map(p => ({
        id: p.id,
        name: p.name,
        category: p.category,
        followers: p.followers_count,
        fans: p.fan_count,
      }))
      return { content: [{ type: 'text', text: JSON.stringify(pages, null, 2) }] }
    })

  server.tool('meta_get_conversations',
    'List recent Messenger/Instagram conversations for a page.',
    z.object({
      pageId: z.string().optional().describe('Facebook Page ID (defaults to env)'),
      pageToken: z.string().optional().describe('Page access token (defaults to env)'),
      platform: z.string().optional().describe('"messenger" or "instagram" (default: messenger)'),
      limit: z.number().optional().describe('Max conversations (default 20)'),
    }),
    async ({ pageId, pageToken, platform, limit } = {}) => {
      pageId = pageId || META_PAGE_ID
      pageToken = pageToken || META_PAGE_TOKEN
      const p = platform || 'messenger'
      const l = limit || 20
      const folder = p === 'instagram' ? 'instagram_manage_messages' : ''
      const endpoint = `/${pageId}/conversations?fields=id,participants,updated_time,message_count&limit=${l}${folder ? `&folder=${folder}` : ''}`
      const data = await metaFetch(endpoint, pageToken)
      return { content: [{ type: 'text', text: JSON.stringify(data.data || [], null, 2) }] }
    })

  server.tool('meta_send_message',
    'Send a message in a Messenger/Instagram conversation.',
    z.object({
      pageId: z.string().optional().describe('Facebook Page ID (defaults to env)'),
      pageToken: z.string().optional().describe('Page access token (defaults to env)'),
      recipientId: z.string().describe('Recipient user ID (from conversation participants)'),
      message: z.string().describe('Message text to send'),
    }),
    async ({ pageId, pageToken, recipientId, message }) => {
      pageId = pageId || META_PAGE_ID
      pageToken = pageToken || META_PAGE_TOKEN
      const data = await metaFetch(`/${pageId}/messages`, pageToken, {
        method: 'POST',
        body: JSON.stringify({
          recipient: { id: recipientId },
          messaging_type: 'RESPONSE',
          message: { text: message },
          access_token: pageToken,
        }),
      })
      return { content: [{ type: 'text', text: `Message sent. ID: ${data.message_id || data.id || 'ok'}` }] }
    })

  server.tool('meta_create_post',
    'Create a post on a Facebook page.',
    z.object({
      pageId: z.string().optional().describe('Facebook Page ID (defaults to env)'),
      pageToken: z.string().optional().describe('Page access token (defaults to env)'),
      message: z.string().describe('Post text'),
      link: z.string().optional().describe('URL to share (optional)'),
    }),
    async ({ pageId, pageToken, message, link }) => {
      pageId = pageId || META_PAGE_ID
      pageToken = pageToken || META_PAGE_TOKEN
      const body = { message, access_token: pageToken }
      if (link) body.link = link
      const data = await metaFetch(`/${pageId}/feed`, pageToken, {
        method: 'POST',
        body: JSON.stringify(body),
      })
      return { content: [{ type: 'text', text: `Post created. ID: ${data.id}` }] }
    })
}
