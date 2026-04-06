const registry = require('../services/capabilityRegistry')

// ═══════════════════════════════════════════════════════════════════════
// UNIFIED SOCIAL CAPABILITIES — LinkedIn + Meta (FB/IG/Messenger) + Gmail
// All registered under their respective domains for workspace filtering.
// ═══════════════════════════════════════════════════════════════════════

registry.registerMany([

  // ═══════════════════════════════════════════════════════════════════════
  // META — Facebook, Instagram, Messenger
  // ═══════════════════════════════════════════════════════════════════════

  // ── Read ──
  {
    name: 'meta_overview',
    description: 'Get Meta overview — pages, post counts, conversation counts, followers, avg reach. First call when entering Meta context.',
    tier: 'read',
    domain: 'meta',
    params: {},
    handler: async () => {
      const meta = require('../services/metaService')
      return await meta.getStats()
    },
  },
  {
    name: 'meta_list_pages',
    description: 'List all connected Facebook/Instagram pages with follower counts.',
    tier: 'read',
    domain: 'meta',
    params: {},
    handler: async () => {
      const meta = require('../services/metaService')
      return { pages: await meta.getPages() }
    },
  },
  {
    name: 'meta_list_posts',
    description: 'List posts from Facebook/Instagram pages — filter by page.',
    tier: 'read',
    domain: 'meta',
    params: {
      pageId: { type: 'string', required: false, description: 'Filter by internal page UUID' },
      limit: { type: 'number', required: false, description: 'Max results (default 20)' },
    },
    handler: async (params) => {
      const meta = require('../services/metaService')
      return { posts: await meta.getPosts({ pageId: params.pageId, limit: params.limit || 20 }) }
    },
  },
  {
    name: 'meta_list_conversations',
    description: 'List Messenger and Instagram DM conversations — shows participant, last message, platform, triage status.',
    tier: 'read',
    domain: 'meta',
    params: {
      pageId: { type: 'string', required: false, description: 'Filter by page UUID' },
      limit: { type: 'number', required: false, description: 'Max results (default 20)' },
    },
    handler: async (params) => {
      const meta = require('../services/metaService')
      return { conversations: await meta.getConversations({ pageId: params.pageId, limit: params.limit || 20 }) }
    },
  },
  {
    name: 'meta_get_messages',
    description: 'Get messages for a specific Messenger/Instagram conversation.',
    tier: 'read',
    domain: 'meta',
    params: {
      conversationId: { type: 'string', required: true, description: 'Conversation UUID' },
      limit: { type: 'number', required: false, description: 'Max messages (default 30)' },
    },
    handler: async (params) => {
      const conversationId = params.conversationId || params.conversation_id
      if (!conversationId) throw new Error('conversationId is required')
      const db = require('../config/db')
      const messages = await db`
        SELECT id, conversation_id, sender_id, sender_name, message_text, created_time, is_from_page
        FROM meta_messages WHERE conversation_id = ${conversationId}
        ORDER BY created_time DESC LIMIT ${params.limit || 30}`
      return { messages }
    },
  },

  // ── Write ──
  {
    name: 'meta_publish_post',
    description: 'Publish a post to a Facebook or Instagram Page.',
    tier: 'write',
    domain: 'meta',
    params: {
      pageId: { type: 'string', required: true, description: 'Internal meta_pages.id (UUID)' },
      message: { type: 'string', required: true, description: 'Post text content' },
      link: { type: 'string', required: false, description: 'URL to attach' },
      imageUrl: { type: 'string', required: false, description: 'Image URL to include' },
    },
    handler: async (params) => {
      const meta = require('../services/metaService')
      return await meta.publishPost(params.pageId, {
        message: params.message, link: params.link, imageUrl: params.imageUrl,
      })
    },
  },
  {
    name: 'meta_send_message',
    description: 'Send a message in a Messenger or Instagram DM conversation.',
    tier: 'write',
    domain: 'meta',
    params: {
      conversationId: { type: 'string', required: true, description: 'Conversation UUID' },
      message: { type: 'string', required: true, description: 'Message text' },
    },
    handler: async (params) => {
      const meta = require('../services/metaService')
      return await meta.sendMessage(params.conversationId, params.message)
    },
  },
  {
    name: 'meta_reply_comment',
    description: 'Reply to a comment on a Facebook/Instagram post.',
    tier: 'write',
    domain: 'meta',
    params: {
      commentId: { type: 'string', required: true, description: 'Comment ID' },
      pageId: { type: 'string', required: true, description: 'Page UUID' },
      message: { type: 'string', required: true, description: 'Reply text' },
    },
    handler: async (params) => {
      const meta = require('../services/metaService')
      await meta.replyToComment(params.commentId, params.pageId, params.message)
      return { replied: true }
    },
  },
  {
    name: 'meta_like_post',
    description: 'Like a post from a Page account.',
    tier: 'write',
    domain: 'meta',
    params: {
      postId: { type: 'string', required: true, description: 'Post UUID' },
      pageId: { type: 'string', required: true, description: 'Page UUID' },
    },
    handler: async (params) => {
      const meta = require('../services/metaService')
      return await meta.likePost(params.postId, params.pageId)
    },
  },
  {
    name: 'meta_delete_post',
    description: 'Delete a Meta post.',
    tier: 'write',
    domain: 'meta',
    params: {
      postId: { type: 'string', required: true, description: 'Post UUID' },
    },
    handler: async (params) => {
      const meta = require('../services/metaService')
      return await meta.deletePost(params.postId)
    },
  },
  {
    name: 'meta_triage',
    description: 'Run AI triage on pending Meta conversations — categorizes, drafts replies, enqueues actions.',
    tier: 'write',
    domain: 'meta',
    params: {},
    handler: async () => {
      const meta = require('../services/metaService')
      await meta.triagePendingConversations()
      return { triaged: true }
    },
  },
  {
    name: 'meta_sync',
    description: 'Trigger a full Meta sync — discover pages, sync posts, insights, and conversations.',
    tier: 'write',
    domain: 'meta',
    params: {},
    handler: async () => {
      const meta = require('../services/metaService')
      await meta.poll()
      return await meta.getStats()
    },
  },

  // ═══════════════════════════════════════════════════════════════════════
  // LINKEDIN — DMs, Posts, Connections, Profiles, Analytics
  // ═══════════════════════════════════════════════════════════════════════

  // ── DM Read ──
  {
    name: 'linkedin_dm_list',
    description: 'List LinkedIn DMs with filters — status, category, priority, search. Shows triage summary and lead scores.',
    tier: 'read',
    domain: 'linkedin',
    params: {
      status: { type: 'string', required: false, description: 'Filter: unread, drafting, replied, ignored' },
      category: { type: 'string', required: false, description: 'Filter: lead, networking, recruiter, spam, support, personal' },
      priority: { type: 'string', required: false, description: 'Filter: urgent, high, normal, low, spam' },
      search: { type: 'string', required: false, description: 'Search participant name/messages' },
      limit: { type: 'number', required: false, description: 'Max results (default 20)' },
    },
    handler: async (params) => {
      const db = require('../config/db')
      const conditions = [], values = []
      if (params.status) conditions.push(`status = $${values.push(params.status)}`)
      if (params.category) conditions.push(`category = $${values.push(params.category)}`)
      if (params.priority) conditions.push(`priority = $${values.push(params.priority)}`)
      if (params.search) conditions.push(`(participant_name ILIKE '%' || $${values.push(params.search)} || '%')`)
      const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : ''
      const limit = params.limit || 20
      const dms = await db.unsafe(
        `SELECT id, conversation_id, participant_name, participant_headline, participant_company, status, category, priority, triage_summary, lead_score, message_count, last_message_at
         FROM linkedin_dms ${where} ORDER BY last_message_at DESC LIMIT $${values.push(limit)}`, values)
      return { dms, count: dms.length }
    },
  },
  {
    name: 'linkedin_dm_stats',
    description: 'Get LinkedIn DM statistics — unread, leads, high priority, pending triage.',
    tier: 'read',
    domain: 'linkedin',
    params: {},
    handler: async () => {
      const db = require('../config/db')
      const [stats] = await db`
        SELECT
          count(*) FILTER (WHERE status = 'unread')::int AS unread,
          count(*) FILTER (WHERE category = 'lead')::int AS leads,
          count(*) FILTER (WHERE priority IN ('urgent', 'high'))::int AS high_priority,
          count(*) FILTER (WHERE triage_status = 'pending')::int AS pending_triage
        FROM linkedin_dms`
      return stats
    },
  },
  {
    name: 'linkedin_dm_get',
    description: 'Get full details of a LinkedIn DM — messages, profile, triage, lead analysis.',
    tier: 'read',
    domain: 'linkedin',
    params: {
      dmId: { type: 'string', required: true, description: 'DM UUID' },
    },
    handler: async (params) => {
      const dmId = params.dmId || params.dm_id || params.id
      if (!dmId) throw new Error('dmId is required')
      const db = require('../config/db')
      const [dm] = await db`
        SELECT id, conversation_id, participant_name, participant_headline, participant_company,
               status, category, priority, triage_summary, triage_action, lead_score,
               draft_reply, message_count, last_message_at, messages, client_id
        FROM linkedin_dms WHERE id = ${dmId}`
      if (!dm) throw new Error('DM not found')
      return dm
    },
  },

  // ── DM Write ──
  {
    name: 'linkedin_draft_reply',
    description: 'Generate an AI draft reply for a LinkedIn DM. Saves to the DM record for review.',
    tier: 'write',
    domain: 'linkedin',
    params: {
      dmId: { type: 'string', required: true, description: 'DM UUID' },
    },
    handler: async (params) => {
      const linkedin = require('../services/linkedinService')
      return await linkedin.draftDMReply(params.dmId)
    },
  },
  {
    name: 'linkedin_send_reply',
    description: 'Send the stored draft reply for a LinkedIn DM. Draft must be generated first.',
    tier: 'write',
    domain: 'linkedin',
    params: {
      dmId: { type: 'string', required: true, description: 'DM UUID' },
    },
    handler: async (params) => {
      const linkedin = require('../services/linkedinService')
      await linkedin.sendDMReply(params.dmId)
      return { sent: true, dmId: params.dmId }
    },
  },
  {
    name: 'linkedin_triage_dms',
    description: 'Run AI triage on pending LinkedIn DMs — categorizes, scores leads, drafts replies.',
    tier: 'write',
    domain: 'linkedin',
    params: {},
    handler: async () => {
      const linkedin = require('../services/linkedinService')
      await linkedin.triagePendingDMs()
      return { triaged: true }
    },
  },
  {
    name: 'linkedin_analyze_lead',
    description: 'Deep-analyze a LinkedIn DM for lead potential — buying signals, CRM suggestions, next steps.',
    tier: 'read',
    domain: 'linkedin',
    params: {
      dmId: { type: 'string', required: true, description: 'DM UUID' },
    },
    handler: async (params) => {
      const linkedin = require('../services/linkedinService')
      return await linkedin.analyzeLeadSignals(params.dmId)
    },
  },
  {
    name: 'linkedin_link_dm_client',
    description: 'Link a LinkedIn DM conversation to a CRM client.',
    tier: 'write',
    domain: 'linkedin',
    params: {
      dmId: { type: 'string', required: true, description: 'DM UUID' },
      clientId: { type: 'string', required: true, description: 'CRM client UUID' },
    },
    handler: async (params) => {
      const linkedin = require('../services/linkedinService')
      await linkedin.linkDMToClient(params.dmId, params.clientId)
      return { linked: true }
    },
  },

  // ── Posts ──
  {
    name: 'linkedin_list_posts',
    description: 'List LinkedIn posts — filter by status (draft, scheduled, posted). Shows engagement metrics.',
    tier: 'read',
    domain: 'linkedin',
    params: {
      status: { type: 'string', required: false, description: 'Filter: draft, scheduled, posted' },
      limit: { type: 'number', required: false, description: 'Max results (default 20)' },
    },
    handler: async (params) => {
      const db = require('../config/db')
      const conditions = [], values = []
      if (params.status) conditions.push(`status = $${values.push(params.status)}`)
      const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : ''
      const limit = params.limit || 20
      return { posts: await db.unsafe(
        `SELECT id, content, post_type, hashtags, status, impressions, reactions, comments_count, engagement_rate, posted_at, scheduled_at, created_at, theme
         FROM linkedin_posts ${where} ORDER BY COALESCE(posted_at, scheduled_at, created_at) DESC LIMIT $${values.push(limit)}`, values) }
    },
  },
  {
    name: 'linkedin_create_post',
    description: 'Create a LinkedIn post draft. Can be published immediately or scheduled.',
    tier: 'write',
    domain: 'linkedin',
    params: {
      content: { type: 'string', required: true, description: 'Post text (max 3000 chars)' },
      post_type: { type: 'string', required: false, description: 'text (default), image, poll' },
      hashtags: { type: 'string', required: false, description: 'Comma-separated hashtags' },
      schedule_at: { type: 'string', required: false, description: 'ISO date to schedule (omit for draft)' },
      theme: { type: 'string', required: false, description: 'Content theme name' },
    },
    handler: async (params) => {
      const db = require('../config/db')
      const status = params.schedule_at ? 'scheduled' : 'draft'
      const hashtags = params.hashtags ? params.hashtags.split(',').map(h => h.trim()) : []
      const [post] = await db`
        INSERT INTO linkedin_posts (content, post_type, hashtags, status, scheduled_at, theme)
        VALUES (${params.content}, ${params.post_type || 'text'}, ${hashtags}, ${status},
          ${params.schedule_at || null}, ${params.theme || null})
        RETURNING id, status`
      return { post_id: post.id, status: post.status }
    },
  },
  {
    name: 'linkedin_generate_post',
    description: 'AI-generate 3 LinkedIn post variations from a theme/topic. Returns content, hashtags, hooks.',
    tier: 'read',
    domain: 'linkedin',
    params: {
      theme: { type: 'string', required: true, description: 'Topic or theme (e.g. "tech sustainability", "startup life")' },
      post_type: { type: 'string', required: false, description: 'text, poll, carousel' },
    },
    handler: async (params) => {
      const linkedin = require('../services/linkedinService')
      return await linkedin.generatePostContent(params.theme, { postType: params.post_type || 'text' })
    },
  },
  {
    name: 'linkedin_post_analytics',
    description: 'Get LinkedIn post performance — impressions, reactions, comments, engagement rates.',
    tier: 'read',
    domain: 'linkedin',
    params: {},
    handler: async () => {
      const db = require('../config/db')
      const [stats] = await db`
        SELECT count(*)::int AS total_posts,
          COALESCE(SUM(impressions), 0)::int AS total_impressions,
          COALESCE(SUM(reactions), 0)::int AS total_reactions,
          COALESCE(SUM(comments_count), 0)::int AS total_comments,
          COALESCE(AVG(engagement_rate), 0)::float AS avg_engagement
        FROM linkedin_posts WHERE status = 'posted'`
      return stats
    },
  },

  // ── Connections ──
  {
    name: 'linkedin_connection_requests',
    description: 'List pending LinkedIn connection requests with relevance scores.',
    tier: 'read',
    domain: 'linkedin',
    params: {},
    handler: async () => {
      const db = require('../config/db')
      const requests = await db`
        SELECT id, requester_name, requester_headline, requester_company, requester_profile_url,
               relevance_score, note, status, direction, created_at
        FROM linkedin_connection_requests
        WHERE status = 'pending' AND direction = 'incoming'
        ORDER BY relevance_score DESC NULLS LAST LIMIT 30`
      return { requests, count: requests.length }
    },
  },
  {
    name: 'linkedin_accept_connection',
    description: 'Accept a LinkedIn connection request.',
    tier: 'write',
    domain: 'linkedin',
    params: {
      requestId: { type: 'string', required: true, description: 'Connection request UUID' },
    },
    handler: async (params) => {
      const linkedin = require('../services/linkedinService')
      await linkedin.acceptConnection(params.requestId)
      return { accepted: true }
    },
  },
  {
    name: 'linkedin_decline_connection',
    description: 'Decline a LinkedIn connection request.',
    tier: 'write',
    domain: 'linkedin',
    params: {
      requestId: { type: 'string', required: true, description: 'Connection request UUID' },
    },
    handler: async (params) => {
      const linkedin = require('../services/linkedinService')
      await linkedin.declineConnection(params.requestId)
      return { declined: true }
    },
  },

  // ── Analytics ──
  {
    name: 'linkedin_network_stats',
    description: 'Get LinkedIn network analytics — connections, followers, profile views, search appearances.',
    tier: 'read',
    domain: 'linkedin',
    params: {
      days: { type: 'number', required: false, description: 'Lookback days (default 30)' },
    },
    handler: async (params) => {
      const db = require('../config/db')
      const days = params.days || 30
      const snapshots = await db`
        SELECT id, connections, followers, profile_views, search_appearances, snapshot_date
        FROM linkedin_network_snapshots
        WHERE snapshot_date > now() - (${days} * interval '1 day')
        ORDER BY snapshot_date DESC`
      if (snapshots.length === 0) return { snapshots: [], latest: null, note: 'No snapshots found — LinkedIn network scraper may not have run recently. Use linkedin_check_connections to trigger a fresh snapshot.' }
      return { snapshots, latest: snapshots[0] }
    },
  },
  {
    name: 'linkedin_suggest_post_times',
    description: 'AI-analyze historical post performance and suggest optimal posting times.',
    tier: 'read',
    domain: 'linkedin',
    params: {},
    handler: async () => {
      const linkedin = require('../services/linkedinService')
      return await linkedin.suggestPostTimes()
    },
  },

  // ── Profiles ──
  {
    name: 'linkedin_scrape_profile',
    description: 'Scrape and save a LinkedIn profile — extracts name, headline, company, connections.',
    tier: 'write',
    domain: 'linkedin',
    params: {
      profileUrl: { type: 'string', required: true, description: 'LinkedIn profile URL' },
    },
    handler: async (params) => {
      const linkedin = require('../services/linkedinService')
      return await linkedin.scrapeAndSaveProfile(params.profileUrl)
    },
  },
  {
    name: 'linkedin_worker_status',
    description: 'Get LinkedIn worker/scraper status — session state, budget usage, suspension reason.',
    tier: 'read',
    domain: 'linkedin',
    params: {},
    handler: async () => {
      const linkedin = require('../services/linkedinService')
      return await linkedin.getWorkerStatus()
    },
  },

  {
    name: 'linkedin_set_cookie',
    description: 'Update the LinkedIn li_at session cookie. The user will paste a long string starting with AQ. Pass it as the li_at param.',
    tier: 'write',
    domain: 'linkedin',
    params: {
      li_at: { type: 'string', required: false, description: 'The li_at cookie value' },
      cookie: { type: 'string', required: false, description: 'Alias for li_at' },
      value: { type: 'string', required: false, description: 'Alias for li_at' },
    },
    handler: async (params, context) => {
      const browser = require('../services/linkedinBrowser')

      // Accept from any param name — AI often puts it in the wrong field
      let cookie = params.li_at || params.cookie || params.value || ''

      // If no param matched, try to find a long AQ string in any param value
      if (!cookie || cookie.length < 20) {
        for (const v of Object.values(params)) {
          if (typeof v === 'string' && v.length > 20 && v.startsWith('AQ')) {
            cookie = v
            break
          }
        }
      }

      // Last resort: check if the calling context has the original user message
      // (the AI sometimes puts the whole message as a param value)
      if (!cookie || cookie.length < 20) {
        for (const v of Object.values(params)) {
          if (typeof v === 'string') {
            const match = v.match(/AQ[A-Za-z0-9_-]{20,}/)
            if (match) { cookie = match[0]; break }
          }
        }
      }

      cookie = (cookie || '').trim()
      if (!cookie || cookie.length < 20) {
        return { error: 'Could not find the li_at cookie value. Please paste the cookie string starting with AQ directly.' }
      }

      try {
        await browser.setSessionCookie(cookie)
        return { message: `LinkedIn cookie updated (${cookie.slice(0, 10)}...${cookie.slice(-6)}). The worker will use this on its next run.` }
      } catch (err) {
        return { error: `Failed to update cookie: ${err.message}` }
      }
    },
  },

  // ── Sync ──
  {
    name: 'linkedin_sync_dms',
    description: 'Trigger LinkedIn DM sync — scrapes new messages, triages, fires delegation.',
    tier: 'write',
    domain: 'linkedin',
    params: {},
    handler: async () => {
      const linkedin = require('../services/linkedinService')
      return await linkedin.checkDMs()
    },
  },
  {
    name: 'linkedin_check_connections',
    description: 'Scrape and score new LinkedIn connection requests.',
    tier: 'write',
    domain: 'linkedin',
    params: {},
    handler: async () => {
      const linkedin = require('../services/linkedinService')
      return await linkedin.checkConnectionRequests()
    },
  },
])
