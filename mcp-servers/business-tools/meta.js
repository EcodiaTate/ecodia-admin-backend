/**
 * Meta (Facebook/Instagram) MCP tools — pages, posts, conversations.
 */
const META_TOKEN = process.env.META_USER_ACCESS_TOKEN || ''
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

  server.tool('meta_list_pages', {
    description: 'List managed Facebook/Instagram pages with follower counts.',
    inputSchema: { type: 'object', properties: {} },
  }, async () => {
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

  server.tool('meta_get_conversations', {
    description: 'List recent Messenger/Instagram conversations for a page.',
    inputSchema: {
      type: 'object',
      properties: {
        pageId: { type: 'string', description: 'Facebook Page ID' },
        pageToken: { type: 'string', description: 'Page access token (get from meta_list_pages)' },
        platform: { type: 'string', description: '"messenger" or "instagram" (default: messenger)' },
        limit: { type: 'number', description: 'Max conversations (default 20)' },
      },
      required: ['pageId', 'pageToken'],
    },
  }, async ({ pageId, pageToken, platform = 'messenger', limit = 20 }) => {
    const folder = platform === 'instagram' ? 'instagram_manage_messages' : ''
    const endpoint = `/${pageId}/conversations?fields=id,participants,updated_time,message_count&limit=${limit}${folder ? `&folder=${folder}` : ''}`
    const data = await metaFetch(endpoint, pageToken)
    return { content: [{ type: 'text', text: JSON.stringify(data.data || [], null, 2) }] }
  })

  server.tool('meta_send_message', {
    description: 'Send a message in a Messenger/Instagram conversation.',
    inputSchema: {
      type: 'object',
      properties: {
        pageId: { type: 'string', description: 'Facebook Page ID' },
        pageToken: { type: 'string', description: 'Page access token' },
        recipientId: { type: 'string', description: 'Recipient user ID (from conversation participants)' },
        message: { type: 'string', description: 'Message text to send' },
      },
      required: ['pageId', 'pageToken', 'recipientId', 'message'],
    },
  }, async ({ pageId, pageToken, recipientId, message }) => {
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

  server.tool('meta_create_post', {
    description: 'Create a post on a Facebook page.',
    inputSchema: {
      type: 'object',
      properties: {
        pageId: { type: 'string', description: 'Facebook Page ID' },
        pageToken: { type: 'string', description: 'Page access token' },
        message: { type: 'string', description: 'Post text' },
        link: { type: 'string', description: 'URL to share (optional)' },
      },
      required: ['pageId', 'pageToken', 'message'],
    },
  }, async ({ pageId, pageToken, message, link }) => {
    const body = { message, access_token: pageToken }
    if (link) body.link = link
    const data = await metaFetch(`/${pageId}/feed`, pageToken, {
      method: 'POST',
      body: JSON.stringify(body),
    })
    return { content: [{ type: 'text', text: `Post created. ID: ${data.id}` }] }
  })
}
