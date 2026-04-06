const db = require('../../config/db')

// ─── DMs ────────────────────────────────────────────────────────────────

async function upsertDM({ conversationId, participantName, messages, messageCount, participantHeadline, participantCompany, profileId }) {
  const [dm] = await db`
    INSERT INTO linkedin_dms (conversation_id, participant_name, messages, message_count, last_message_at, participant_headline, participant_company, profile_id, status)
    VALUES (${conversationId}, ${participantName}, ${JSON.stringify(messages)}, ${messageCount || messages.length}, now(), ${participantHeadline || null}, ${participantCompany || null}, ${profileId || null}, 'unread')
    ON CONFLICT (conversation_id) DO UPDATE SET
      participant_name = EXCLUDED.participant_name,
      messages = EXCLUDED.messages,
      message_count = EXCLUDED.message_count,
      last_message_at = now(),
      participant_headline = COALESCE(EXCLUDED.participant_headline, linkedin_dms.participant_headline),
      participant_company = COALESCE(EXCLUDED.participant_company, linkedin_dms.participant_company),
      profile_id = COALESCE(EXCLUDED.profile_id, linkedin_dms.profile_id),
      updated_at = now()
    RETURNING *
  `
  return dm
}

async function getDMs({ limit = 15, offset = 0, status, category, priority, search } = {}) {
  const dms = await db`
    SELECT d.*, p.headline as profile_headline, p.company as profile_company, p.relevance_score as profile_relevance
    FROM linkedin_dms d
    LEFT JOIN linkedin_profiles p ON d.profile_id = p.id
    WHERE 1=1
      ${status ? db`AND d.status = ${status}` : db``}
      ${category ? db`AND d.category = ${category}` : db``}
      ${priority ? db`AND d.priority = ${priority}` : db``}
      ${search ? db`AND (d.participant_name ILIKE ${'%' + search + '%'} OR d.triage_summary ILIKE ${'%' + search + '%'})` : db``}
    ORDER BY d.last_message_at DESC NULLS LAST
    LIMIT ${limit} OFFSET ${offset}
  `

  const [{ count }] = await db`
    SELECT count(*)::int FROM linkedin_dms
    WHERE 1=1
      ${status ? db`AND status = ${status}` : db``}
      ${category ? db`AND category = ${category}` : db``}
      ${priority ? db`AND priority = ${priority}` : db``}
      ${search ? db`AND (participant_name ILIKE ${'%' + search + '%'} OR triage_summary ILIKE ${'%' + search + '%'})` : db``}
  `

  return { dms, total: count }
}

async function getDMById(id) {
  const [dm] = await db`
    SELECT d.*, p.headline as profile_headline, p.company as profile_company, p.location as profile_location,
           p.about_snippet as profile_about, p.relevance_score as profile_relevance, p.connection_degree as profile_connection_degree,
           p.mutual_connections as profile_mutual_connections, p.profile_image_url as profile_image,
           c.name as client_name, c.status as client_stage
    FROM linkedin_dms d
    LEFT JOIN linkedin_profiles p ON d.profile_id = p.id
    LEFT JOIN clients c ON d.client_id = c.id
    WHERE d.id = ${id}
  `
  return dm || null
}

async function getDMStats() {
  const [stats] = await db`
    SELECT
      count(*) FILTER (WHERE status = 'unread')::int as unread,
      count(*) FILTER (WHERE category = 'lead')::int as leads,
      count(*) FILTER (WHERE priority IN ('urgent','high'))::int as high_priority,
      count(*) FILTER (WHERE triage_status = 'pending')::int as pending_triage,
      count(*)::int as total
    FROM linkedin_dms
  `
  return stats
}

async function updateDM(id, fields) {
  const allowed = ['status', 'category', 'priority', 'draft_reply', 'triage_summary', 'triage_status',
                    'triage_attempts', 'lead_score', 'lead_signals', 'client_id', 'profile_id']
  const updates = {}
  for (const key of allowed) {
    if (fields[key] !== undefined) updates[key] = fields[key]
  }
  if (Object.keys(updates).length === 0) return null

  const [updated] = await db`
    UPDATE linkedin_dms SET ${db(updates, ...Object.keys(updates))}, updated_at = now()
    WHERE id = ${id}
    RETURNING *
  `
  return updated
}

async function getPendingTriageDMs(limit = 10) {
  return db`
    SELECT * FROM linkedin_dms
    WHERE triage_status = 'pending' AND triage_attempts < 5
    ORDER BY last_message_at DESC
    LIMIT ${limit}
  `
}

// ─── Profiles ──────────────────────────────────────────────────────────

async function upsertProfile(data) {
  const [profile] = await db`
    INSERT INTO linkedin_profiles (linkedin_url, name, headline, location, company, company_url, about_snippet,
      connection_degree, mutual_connections, is_connection, profile_image_url, relevance_score, relevance_reason, raw_scraped, last_scraped_at)
    VALUES (${data.linkedin_url}, ${data.name}, ${data.headline || null}, ${data.location || null},
      ${data.company || null}, ${data.company_url || null}, ${data.about_snippet || null},
      ${data.connection_degree || null}, ${data.mutual_connections || null}, ${data.is_connection || false},
      ${data.profile_image_url || null}, ${data.relevance_score || null}, ${data.relevance_reason || null},
      ${JSON.stringify(data.raw_scraped || {})}, now())
    ON CONFLICT (linkedin_url) DO UPDATE SET
      name = EXCLUDED.name,
      headline = COALESCE(EXCLUDED.headline, linkedin_profiles.headline),
      location = COALESCE(EXCLUDED.location, linkedin_profiles.location),
      company = COALESCE(EXCLUDED.company, linkedin_profiles.company),
      about_snippet = COALESCE(EXCLUDED.about_snippet, linkedin_profiles.about_snippet),
      connection_degree = COALESCE(EXCLUDED.connection_degree, linkedin_profiles.connection_degree),
      mutual_connections = COALESCE(EXCLUDED.mutual_connections, linkedin_profiles.mutual_connections),
      is_connection = COALESCE(EXCLUDED.is_connection, linkedin_profiles.is_connection),
      profile_image_url = COALESCE(EXCLUDED.profile_image_url, linkedin_profiles.profile_image_url),
      relevance_score = COALESCE(EXCLUDED.relevance_score, linkedin_profiles.relevance_score),
      relevance_reason = COALESCE(EXCLUDED.relevance_reason, linkedin_profiles.relevance_reason),
      raw_scraped = EXCLUDED.raw_scraped,
      last_scraped_at = now(),
      updated_at = now()
    RETURNING *
  `
  return profile
}

async function getProfiles({ limit = 20, offset = 0, search } = {}) {
  return db`
    SELECT * FROM linkedin_profiles
    WHERE 1=1
      ${search ? db`AND (name ILIKE ${'%' + search + '%'} OR headline ILIKE ${'%' + search + '%'} OR company ILIKE ${'%' + search + '%'})` : db``}
    ORDER BY updated_at DESC
    LIMIT ${limit} OFFSET ${offset}
  `
}

async function getProfileByUrl(linkedinUrl) {
  const [p] = await db`SELECT * FROM linkedin_profiles WHERE linkedin_url = ${linkedinUrl}`
  return p || null
}

async function getProfileById(id) {
  const [p] = await db`SELECT * FROM linkedin_profiles WHERE id = ${id}`
  return p || null
}

// ─── Connection Requests ───────────────────────────────────────────────

async function upsertConnectionRequest(data) {
  const [req] = await db`
    INSERT INTO linkedin_connection_requests (linkedin_url, name, headline, message, direction, relevance_score, relevance_reason, profile_id)
    VALUES (${data.linkedinUrl || ''}, ${data.name}, ${data.headline || null}, ${data.message || null},
      ${data.direction || 'incoming'}, ${data.relevance_score || null}, ${data.relevance_reason || null}, ${data.profile_id || null})
    ON CONFLICT DO NOTHING
    RETURNING *
  `
  return req
}

async function getConnectionRequests({ status = 'pending', limit = 30 } = {}) {
  return db`
    SELECT cr.*, p.headline as profile_headline, p.company as profile_company, p.about_snippet as profile_about,
           p.mutual_connections as profile_mutual, p.profile_image_url as profile_image
    FROM linkedin_connection_requests cr
    LEFT JOIN linkedin_profiles p ON cr.profile_id = p.id
    WHERE cr.status = ${status}
    ORDER BY cr.relevance_score DESC NULLS LAST, cr.created_at DESC
    LIMIT ${limit}
  `
}

async function updateConnectionRequest(id, fields) {
  const [updated] = await db`
    UPDATE linkedin_connection_requests SET ${db(fields, ...Object.keys(fields))}, acted_on_at = now()
    WHERE id = ${id}
    RETURNING *
  `
  return updated
}

// ─── Posts ──────────────────────────────────────────────────────────────

async function createPost(data) {
  const [post] = await db`
    INSERT INTO linkedin_posts (content, post_type, hashtags, media_paths, scheduled_at, status, ai_generated, ai_prompt, theme, recurring_id)
    VALUES (${data.content}, ${data.postType || 'text'}, ${data.hashtags || []}, ${data.mediaPaths || []},
      ${data.scheduledAt || null}, ${data.scheduledAt ? 'scheduled' : 'draft'},
      ${data.aiGenerated || false}, ${data.aiPrompt || null}, ${data.theme || null}, ${data.recurringId || null})
    RETURNING *
  `
  return post
}

async function getPosts({ status, type, theme, limit = 20, offset = 0 } = {}) {
  return db`
    SELECT * FROM linkedin_posts
    WHERE 1=1
      ${status ? db`AND status = ${status}` : db``}
      ${type ? db`AND post_type = ${type}` : db``}
      ${theme ? db`AND theme = ${theme}` : db``}
    ORDER BY COALESCE(scheduled_at, created_at) DESC
    LIMIT ${limit} OFFSET ${offset}
  `
}

async function getPostById(id) {
  const [post] = await db`SELECT * FROM linkedin_posts WHERE id = ${id}`
  return post || null
}

async function updatePost(id, fields) {
  const allowed = ['content', 'post_type', 'hashtags', 'scheduled_at', 'status', 'theme',
                    'linkedin_post_url', 'impressions', 'reactions', 'comments_count', 'reposts',
                    'engagement_rate', 'performance_scraped_at', 'posted_at']
  const updates = {}
  for (const key of allowed) {
    if (fields[key] !== undefined) updates[key] = fields[key]
  }
  if (Object.keys(updates).length === 0) return null

  const [updated] = await db`
    UPDATE linkedin_posts SET ${db(updates, ...Object.keys(updates))}, updated_at = now()
    WHERE id = ${id}
    RETURNING *
  `
  return updated
}

async function deletePost(id) {
  const [deleted] = await db`DELETE FROM linkedin_posts WHERE id = ${id} AND status IN ('draft','scheduled') RETURNING *`
  return deleted
}

async function getDueScheduledPosts() {
  return db`
    SELECT * FROM linkedin_posts
    WHERE status = 'scheduled' AND scheduled_at <= now()
    ORDER BY scheduled_at ASC
    LIMIT 5
  `
}

async function getPostsCalendar(startDate, endDate) {
  return db`
    SELECT id, content, post_type, theme, hashtags, scheduled_at, posted_at, status,
           impressions, reactions, comments_count, engagement_rate
    FROM linkedin_posts
    WHERE (scheduled_at BETWEEN ${startDate} AND ${endDate})
       OR (posted_at BETWEEN ${startDate} AND ${endDate})
    ORDER BY COALESCE(scheduled_at, posted_at) ASC
  `
}

async function getPostAnalytics() {
  const [totals] = await db`
    SELECT
      count(*)::int as total_posts,
      count(*) FILTER (WHERE status = 'posted')::int as posted,
      count(*) FILTER (WHERE status = 'scheduled')::int as scheduled,
      count(*) FILTER (WHERE status = 'draft')::int as drafts,
      COALESCE(AVG(engagement_rate) FILTER (WHERE engagement_rate IS NOT NULL), 0)::numeric(5,4) as avg_engagement,
      COALESCE(SUM(impressions) FILTER (WHERE impressions IS NOT NULL), 0)::int as total_impressions,
      COALESCE(SUM(reactions) FILTER (WHERE reactions IS NOT NULL), 0)::int as total_reactions,
      COALESCE(SUM(comments_count) FILTER (WHERE comments_count IS NOT NULL), 0)::int as total_comments
    FROM linkedin_posts
  `
  return totals
}

async function getPostedPostsForPerformanceScrape() {
  return db`
    SELECT * FROM linkedin_posts
    WHERE status = 'posted' AND linkedin_post_url IS NOT NULL
      AND (performance_scraped_at IS NULL OR performance_scraped_at < now() - interval '20 hours')
    ORDER BY posted_at DESC
    LIMIT 10
  `
}

// ─── Network Snapshots ─────────────────────────────────────────────────

async function saveNetworkSnapshot(data) {
  const today = new Date().toISOString().slice(0, 10)
  const [snap] = await db`
    INSERT INTO linkedin_network_snapshots (snapshot_date, connection_count, follower_count, pending_invitations, profile_views_week, search_appearances_week, raw_data)
    VALUES (${today}, ${data.connectionCount || null}, ${data.followerCount || null}, ${data.pendingInvitations || null},
      ${data.profileViews || null}, ${data.searchAppearances || null}, ${JSON.stringify(data)})
    ON CONFLICT (snapshot_date) DO UPDATE SET
      connection_count = COALESCE(EXCLUDED.connection_count, linkedin_network_snapshots.connection_count),
      follower_count = COALESCE(EXCLUDED.follower_count, linkedin_network_snapshots.follower_count),
      pending_invitations = COALESCE(EXCLUDED.pending_invitations, linkedin_network_snapshots.pending_invitations),
      profile_views_week = COALESCE(EXCLUDED.profile_views_week, linkedin_network_snapshots.profile_views_week),
      search_appearances_week = COALESCE(EXCLUDED.search_appearances_week, linkedin_network_snapshots.search_appearances_week),
      raw_data = EXCLUDED.raw_data
    RETURNING *
  `
  return snap
}

async function getNetworkSnapshots(days = 30) {
  return db`
    SELECT * FROM linkedin_network_snapshots
    WHERE snapshot_date >= now() - ${days + ' days'}::interval
    ORDER BY snapshot_date ASC
  `
}

async function getAnalyticsSummary() {
  // This week vs last week
  const [thisWeek] = await db`
    SELECT
      MAX(connection_count) as connections,
      MAX(follower_count) as followers,
      MAX(profile_views_week) as profile_views,
      MAX(search_appearances_week) as search_appearances
    FROM linkedin_network_snapshots
    WHERE snapshot_date >= date_trunc('week', now())
  `
  const [lastWeek] = await db`
    SELECT
      MAX(connection_count) as connections,
      MAX(follower_count) as followers,
      MAX(profile_views_week) as profile_views,
      MAX(search_appearances_week) as search_appearances
    FROM linkedin_network_snapshots
    WHERE snapshot_date >= date_trunc('week', now()) - interval '7 days'
      AND snapshot_date < date_trunc('week', now())
  `

  // Post performance this week
  const [postStats] = await db`
    SELECT
      count(*)::int as posts_count,
      COALESCE(SUM(impressions), 0)::int as total_impressions,
      COALESCE(AVG(engagement_rate), 0)::numeric(5,4) as avg_engagement
    FROM linkedin_posts
    WHERE posted_at >= date_trunc('week', now())
  `

  return { thisWeek: thisWeek || {}, lastWeek: lastWeek || {}, postStats: postStats || {} }
}

// ─── Content Themes ────────────────────────────────────────────────────

async function getContentThemes() {
  return db`SELECT * FROM linkedin_content_themes ORDER BY day_of_week ASC NULLS LAST, name ASC`
}

async function createContentTheme(data) {
  const [theme] = await db`
    INSERT INTO linkedin_content_themes (name, description, day_of_week, time_of_day, prompt_template, active)
    VALUES (${data.name}, ${data.description || null}, ${data.dayOfWeek ?? null}, ${data.timeOfDay || null}, ${data.promptTemplate || null}, ${data.active !== false})
    RETURNING *
  `
  return theme
}

async function updateContentTheme(id, data) {
  const [theme] = await db`
    UPDATE linkedin_content_themes
    SET name = COALESCE(${data.name || null}, name),
        description = COALESCE(${data.description || null}, description),
        day_of_week = COALESCE(${data.dayOfWeek ?? null}, day_of_week),
        time_of_day = COALESCE(${data.timeOfDay || null}, time_of_day),
        prompt_template = COALESCE(${data.promptTemplate || null}, prompt_template),
        active = COALESCE(${data.active ?? null}, active),
        updated_at = now()
    WHERE id = ${id}
    RETURNING *
  `
  return theme
}

async function deleteContentTheme(id) {
  const [deleted] = await db`DELETE FROM linkedin_content_themes WHERE id = ${id} RETURNING *`
  return deleted
}

// ─── Scrape Log ────────────────────────────────────────────────────────

async function createScrapeLog(jobType) {
  const [log] = await db`
    INSERT INTO linkedin_scrape_log (job_type, status) VALUES (${jobType}, 'running') RETURNING *
  `
  return log
}

async function completeScrapeLog(id, { status = 'complete', pagesScraped = 0, itemsFound = 0, errorMessage = null, durationMs = 0 } = {}) {
  const [log] = await db`
    UPDATE linkedin_scrape_log
    SET status = ${status}, pages_scraped = ${pagesScraped}, items_found = ${itemsFound},
        error_message = ${errorMessage}, duration_ms = ${durationMs}
    WHERE id = ${id}
    RETURNING *
  `
  return log
}

async function getRecentScrapeLogs(limit = 20) {
  return db`
    SELECT * FROM linkedin_scrape_log
    ORDER BY created_at DESC
    LIMIT ${limit}
  `
}

module.exports = {
  // DMs
  upsertDM, getDMs, getDMById, getDMStats, updateDM, getPendingTriageDMs,
  // Profiles
  upsertProfile, getProfiles, getProfileByUrl, getProfileById,
  // Connection Requests
  upsertConnectionRequest, getConnectionRequests, updateConnectionRequest,
  // Posts
  createPost, getPosts, getPostById, updatePost, deletePost, getDueScheduledPosts, getPostsCalendar, getPostAnalytics, getPostedPostsForPerformanceScrape,
  // Network
  saveNetworkSnapshot, getNetworkSnapshots, getAnalyticsSummary,
  // Content Themes
  getContentThemes, createContentTheme, updateContentTheme, deleteContentTheme,
  // Scrape Log
  createScrapeLog, completeScrapeLog, getRecentScrapeLogs,
}
