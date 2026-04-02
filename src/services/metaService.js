const env = require('../config/env')
const db = require('../config/db')
const logger = require('../config/logger')
const kgHooks = require('./kgIngestionHooks')
const deepseekService = require('./deepseekService')

// ═══════════════════════════════════════════════════════════════════════
// META GRAPH API SERVICE
//
// Connects to Facebook/Instagram Graph API for page management,
// post insights, Messenger/Instagram DMs. Feeds everything into KG.
//
// Requires: META_APP_ID, META_APP_SECRET, META_USER_ACCESS_TOKEN
// Pages get their own long-lived tokens stored in meta_pages table.
// ═══════════════════════════════════════════════════════════════════════

const GRAPH_API = 'https://graph.facebook.com/v19.0'

async function graphFetch(path, token, opts = {}) {
  const url = `${GRAPH_API}${path}${path.includes('?') ? '&' : '?'}access_token=${token}`
  const res = await fetch(url, opts)

  if (!res.ok) {
    const body = await res.json().catch(() => ({}))
    const msg = body.error?.message || `HTTP ${res.status}`
    throw new Error(`Graph API: ${msg}`)
  }

  return res.json()
}

// ─── Page Discovery & Token Exchange ───────────────────────────────────

async function discoverPages() {
  if (!env.META_USER_ACCESS_TOKEN) return []

  const data = await graphFetch('/me/accounts?fields=id,name,category,access_token,followers_count,fan_count', env.META_USER_ACCESS_TOKEN)
  const pages = data.data || []

  for (const page of pages) {
    await db`
      INSERT INTO meta_pages (page_id, name, category, access_token, followers_count, fan_count)
      VALUES (${page.id}, ${page.name}, ${page.category || null}, ${page.access_token}, ${page.followers_count || 0}, ${page.fan_count || 0})
      ON CONFLICT (page_id) DO UPDATE SET
        name = EXCLUDED.name,
        category = EXCLUDED.category,
        access_token = EXCLUDED.access_token,
        followers_count = EXCLUDED.followers_count,
        fan_count = EXCLUDED.fan_count,
        updated_at = now()
    `
  }

  logger.info(`Meta pages discovered: ${pages.length}`)
  return pages
}

// ─── Post Sync ─────────────────────────────────────────────────────────

async function syncPosts(pageDbId, pageId, token, limit = 50) {
  const data = await graphFetch(
    `/${pageId}/posts?fields=id,message,story,permalink_url,created_time&limit=${limit}`,
    token
  )

  const posts = data.data || []
  let newCount = 0

  for (const post of posts) {
    const [existing] = await db`SELECT id FROM meta_posts WHERE post_id = ${post.id} LIMIT 1`

    await db`
      INSERT INTO meta_posts (
        post_id, page_id, message, story, permalink_url, type,
        likes_count, comments_count, shares_count,
        created_time
      ) VALUES (
        ${post.id}, ${pageDbId},
        ${post.message || null}, ${post.story || null},
        ${post.permalink_url || null}, ${post.type || null},
        ${0},
        ${0},
        ${0},
        ${post.created_time || null}
      )
      ON CONFLICT (post_id) DO UPDATE SET
        message = EXCLUDED.message,
        likes_count = EXCLUDED.likes_count,
        comments_count = EXCLUDED.comments_count,
        shares_count = EXCLUDED.shares_count,
        updated_at = now()
    `

    if (!existing) {
      newCount++
      kgHooks.onMetaPostCreated({ post, pageName: null }).catch(() => {})
    }
  }

  return newCount
}

// ─── Post Insights (reach, impressions) ────────────────────────────────

async function syncPostInsights(pageId, token) {
  // Get recent posts missing insights
  const posts = await db`
    SELECT mp.post_id FROM meta_posts mp
    JOIN meta_pages pg ON mp.page_id = pg.id
    WHERE pg.page_id = ${pageId}
      AND mp.reach IS NULL
      AND mp.created_time > now() - interval '30 days'
    LIMIT 20
  `

  for (const post of posts) {
    try {
      const data = await graphFetch(
        `/${post.post_id}/insights?metric=post_impressions,post_reach`,
        token
      )

      const metrics = {}
      for (const entry of data.data || []) {
        if (entry.name === 'post_impressions') metrics.impressions = entry.values?.[0]?.value || 0
        if (entry.name === 'post_reach') metrics.reach = entry.values?.[0]?.value || 0
      }

      if (metrics.impressions || metrics.reach) {
        await db`
          UPDATE meta_posts SET
            reach = ${metrics.reach || 0},
            impressions = ${metrics.impressions || 0},
            updated_at = now()
          WHERE post_id = ${post.post_id}
        `
      }
    } catch (err) {
      // Insights may not be available for all post types
      logger.debug(`Failed to get insights for ${post.post_id}`, { error: err.message })
    }
  }
}

// ─── Messenger Conversations ───────────────────────────────────────────

async function syncConversations(pageDbId, pageId, token, platform = 'messenger') {
  const endpoint = platform === 'instagram'
    ? `/${pageId}/conversations?platform=instagram&fields=id,participants,updated_time`
    : `/${pageId}/conversations?fields=id,participants,updated_time,message_count`

  const data = await graphFetch(endpoint, token)
  const conversations = data.data || []

  let newMessages = 0

  for (const conv of conversations) {
    const participant = conv.participants?.data?.find(p => p.id !== pageId)

    const [dbConv] = await db`
      INSERT INTO meta_conversations (
        conversation_id, page_id, participant_name, participant_id,
        platform, last_message_at
      ) VALUES (
        ${conv.id}, ${pageDbId},
        ${participant?.name || null}, ${participant?.id || null},
        ${platform}, ${conv.updated_time || null}
      )
      ON CONFLICT (conversation_id) DO UPDATE SET
        participant_name = COALESCE(EXCLUDED.participant_name, meta_conversations.participant_name),
        last_message_at = EXCLUDED.last_message_at,
        updated_at = now()
      RETURNING *
    `

    // Fetch messages for this conversation
    try {
      const msgData = await graphFetch(
        `/${conv.id}/messages?fields=id,message,from,created_time&limit=20`,
        token
      )

      for (const msg of msgData.data || []) {
        const [existing] = await db`SELECT id FROM meta_messages WHERE message_id = ${msg.id} LIMIT 1`
        if (existing) continue

        await db`
          INSERT INTO meta_messages (
            message_id, conversation_id, sender_name, sender_id,
            message_text, is_from_page, created_time
          ) VALUES (
            ${msg.id}, ${dbConv.id},
            ${msg.from?.name || null}, ${msg.from?.id || null},
            ${msg.message || null},
            ${msg.from?.id === pageId},
            ${msg.created_time || null}
          )
          ON CONFLICT (message_id) DO NOTHING
        `
        newMessages++
      }

      // KG hook for conversations with new messages
      if (newMessages > 0) {
        kgHooks.onMetaConversationUpdated({
          conversation: dbConv,
          participantName: participant?.name,
          platform,
          newMessageCount: newMessages,
        }).catch(() => {})
      }
    } catch (err) {
      logger.debug(`Failed to fetch messages for conversation ${conv.id}`, { error: err.message })
    }
  }

  return newMessages
}

// ─── AI Triage for Meta DMs ───────────────────────────────────────────

async function triagePendingConversations() {
  if (!env.DEEPSEEK_API_KEY) return

  // Get conversations with new unread messages that haven't been triaged recently
  const conversations = await db`
    SELECT mc.*, pg.name AS page_name,
      (SELECT json_agg(json_build_object('sender', mm.sender_name, 'text', mm.message_text, 'from_page', mm.is_from_page, 'time', mm.created_time)
       ORDER BY mm.created_time DESC)
       FROM meta_messages mm WHERE mm.conversation_id = mc.id LIMIT 10
      ) AS recent_messages
    FROM meta_conversations mc
    JOIN meta_pages pg ON mc.page_id = pg.id
    WHERE mc.triage_status IS NULL OR mc.triage_status = 'pending'
    ORDER BY mc.last_message_at DESC NULLS LAST
    LIMIT 10
  `

  if (conversations.length === 0) return

  const actionQueue = require('./actionQueueService')

  for (const conv of conversations) {
    try {
      const messages = (conv.recent_messages || []).reverse()
      const lastFromCustomer = messages.filter(m => !m.from_page).slice(-1)[0]
      if (!lastFromCustomer) continue // No customer message to triage

      const prompt = `You are managing social media DMs for Ecodia (software development company). A ${conv.platform || 'messenger'} conversation needs triage.

Page: ${conv.page_name}
Participant: ${conv.participant_name || 'Unknown'}

Recent messages:
${messages.map(m => `${m.from_page ? 'Page' : conv.participant_name || 'Customer'}: ${m.text || '(no text)'}`).join('\n')}

Classify and decide what to do. Respond with JSON only:
{
  "priority": "urgent|high|medium|low|spam",
  "summary": "one sentence summary",
  "suggestedAction": "reply|ignore|escalate|create_task",
  "draftReply": "draft reply if suggestedAction is reply, null otherwise",
  "surfaceToHuman": true or false,
  "surfaceReason": "reason to surface (null if not surfacing)"
}`

      const raw = await deepseekService.callDeepSeek(
        [{ role: 'user', content: prompt }],
        { module: 'meta_triage', skipRetrieval: true }
      )

      const triage = JSON.parse(raw.replace(/```json?\s*/g, '').replace(/```/g, '').trim())

      await db`
        UPDATE meta_conversations SET
          triage_status = 'complete',
          triage_priority = ${triage.priority},
          triage_summary = ${triage.summary},
          updated_at = now()
        WHERE id = ${conv.id}
      `

      // Surface to action queue if AI says so
      if (triage.surfaceToHuman) {
        await actionQueue.enqueue({
          source: 'meta',
          sourceRefId: String(conv.id),
          actionType: triage.draftReply ? 'send_meta_message' : 'follow_up',
          title: `${conv.platform || 'Messenger'}: ${conv.participant_name || 'Unknown'}`,
          summary: triage.surfaceReason || triage.summary,
          preparedData: {
            message: triage.draftReply || null,
            conversationId: conv.id,
            participantName: conv.participant_name,
          },
          context: { platform: conv.platform, pageName: conv.page_name, participantName: conv.participant_name },
          priority: triage.priority === 'spam' ? 'low' : triage.priority,
        }).catch(() => {})
      }

      logger.debug(`Meta DM triaged: ${conv.participant_name} → ${triage.priority}/${triage.suggestedAction}`)
    } catch (err) {
      logger.warn(`Meta DM triage failed for ${conv.id}`, { error: err.message })
      await db`UPDATE meta_conversations SET triage_status = 'pending', updated_at = now() WHERE id = ${conv.id}`.catch(() => {})
    }
  }
}

// ─── Full Poll ─────────────────────────────────────────────────────────

async function poll() {
  if (!env.META_USER_ACCESS_TOKEN) return

  // Discover/refresh pages
  await discoverPages()

  // Sync each page
  const pages = await db`SELECT * FROM meta_pages`

  for (const page of pages) {
    try {
      await syncPosts(page.id, page.page_id, page.access_token)
      await syncPostInsights(page.page_id, page.access_token)
      await syncConversations(page.id, page.page_id, page.access_token, 'messenger')
    } catch (err) {
      logger.error(`Meta sync failed for page ${page.name}`, { error: err.message })
    }
  }

  // After sync, triage new conversations (like Gmail does for emails)
  await triagePendingConversations()
}

// ─── Queries ───────────────────────────────────────────────────────────

async function getPages() {
  return db`
    SELECT mp.*,
      (SELECT count(*)::int FROM meta_posts WHERE page_id = mp.id) AS post_count,
      (SELECT count(*)::int FROM meta_conversations WHERE page_id = mp.id) AS conversation_count
    FROM meta_pages mp
    ORDER BY mp.name
  `
}

async function getPosts({ pageId, limit = 30 } = {}) {
  return db`
    SELECT mp.*, pg.name AS page_name
    FROM meta_posts mp
    JOIN meta_pages pg ON mp.page_id = pg.id
    WHERE 1=1 ${pageId ? db`AND mp.page_id = ${pageId}` : db``}
    ORDER BY mp.created_time DESC
    LIMIT ${limit}
  `
}

async function getConversations({ pageId, limit = 30 } = {}) {
  return db`
    SELECT mc.*, pg.name AS page_name,
      (SELECT message_text FROM meta_messages WHERE conversation_id = mc.id ORDER BY created_time DESC LIMIT 1) AS last_message
    FROM meta_conversations mc
    JOIN meta_pages pg ON mc.page_id = pg.id
    WHERE 1=1 ${pageId ? db`AND mc.page_id = ${pageId}` : db``}
    ORDER BY mc.last_message_at DESC NULLS LAST
    LIMIT ${limit}
  `
}

async function getStats() {
  const [stats] = await db`
    SELECT
      (SELECT count(*)::int FROM meta_pages) AS total_pages,
      (SELECT count(*)::int FROM meta_posts) AS total_posts,
      (SELECT count(*)::int FROM meta_conversations) AS total_conversations,
      (SELECT count(*)::int FROM meta_messages) AS total_messages,
      (SELECT sum(followers_count)::int FROM meta_pages) AS total_followers,
      (SELECT avg(likes_count)::numeric(10,1) FROM meta_posts WHERE created_time > now() - interval '30 days') AS avg_likes_30d,
      (SELECT avg(reach)::int FROM meta_posts WHERE reach IS NOT NULL AND created_time > now() - interval '30 days') AS avg_reach_30d
  `
  return stats
}

// ─── Write Operations ──────────────────────────────────────────────────

async function publishPost(pageDbId, { message, link, imageUrl }) {
  const [page] = await db`SELECT page_id, access_token, name FROM meta_pages WHERE id = ${pageDbId}`
  if (!page) throw new Error('Page not found')

  const params = { message }
  if (link) params.link = link

  let endpoint = `/${page.page_id}/feed`

  // If imageUrl provided, use photos endpoint
  if (imageUrl) {
    endpoint = `/${page.page_id}/photos`
    params.url = imageUrl
    if (message) params.caption = message
    delete params.message
  }

  const data = await graphFetch(endpoint, page.access_token, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
  })

  logger.info(`Published post to ${page.name}: ${data.id}`)

  // Sync the new post back immediately
  await syncPosts(pageDbId, page.page_id, page.access_token, 5)

  return { postId: data.id, pageName: page.name }
}

async function deletePost(postId) {
  // Find which page owns this post
  const [post] = await db`
    SELECT mp.post_id, pg.access_token FROM meta_posts mp
    JOIN meta_pages pg ON mp.page_id = pg.id
    WHERE mp.id = ${postId} OR mp.post_id = ${postId}
    LIMIT 1
  `
  if (!post) throw new Error('Post not found')

  await graphFetch(`/${post.post_id}`, post.access_token, { method: 'DELETE' })
  await db`DELETE FROM meta_posts WHERE post_id = ${post.post_id}`

  logger.info(`Deleted post ${post.post_id}`)
  return { deleted: true }
}

async function replyToComment(commentId, pageDbId, message) {
  const [page] = await db`SELECT access_token FROM meta_pages WHERE id = ${pageDbId}`
  if (!page) throw new Error('Page not found')

  const data = await graphFetch(`/${commentId}/comments`, page.access_token, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message }),
  })

  return { commentId: data.id }
}

async function sendMessage(conversationId, message) {
  const [conv] = await db`
    SELECT mc.participant_id, pg.access_token, pg.page_id
    FROM meta_conversations mc
    JOIN meta_pages pg ON mc.page_id = pg.id
    WHERE mc.id = ${conversationId}
    LIMIT 1
  `
  if (!conv) throw new Error('Conversation not found')

  const data = await graphFetch(`/${conv.page_id}/messages`, conv.access_token, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      recipient: { id: conv.participant_id },
      message: { text: message },
      messaging_type: 'RESPONSE',
    }),
  })

  // Store the sent message locally
  await db`
    INSERT INTO meta_messages (
      message_id, conversation_id, sender_name, sender_id,
      message_text, is_from_page, created_time
    ) VALUES (
      ${data.message_id || `sent_${Date.now()}`}, ${conversationId},
      ${'Page'}, ${conv.page_id},
      ${message}, ${true}, ${new Date().toISOString()}
    ) ON CONFLICT (message_id) DO NOTHING
  `

  logger.info(`Sent message in conversation ${conversationId}`)
  return { messageId: data.message_id }
}

async function likePost(postId, pageDbId) {
  const [page] = await db`SELECT access_token FROM meta_pages WHERE id = ${pageDbId}`
  if (!page) throw new Error('Page not found')

  await graphFetch(`/${postId}/likes`, page.access_token, { method: 'POST' })
  return { liked: true }
}

module.exports = {
  poll,
  discoverPages,
  syncPosts,
  syncConversations,
  triagePendingConversations,
  getPages,
  getPosts,
  getConversations,
  getStats,
  // Write operations
  publishPost,
  deletePost,
  replyToComment,
  sendMessage,
  likePost,
}
