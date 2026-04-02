const { callDeepSeek } = require('./deepseekService')
const logger = require('../config/logger')

// ═══════════════════════════════════════════════════════════════════════
// Shared Helpers
// ═══════════════════════════════════════════════════════════════════════

function parseJSON(content) {
  try {
    return JSON.parse(content)
  } catch {
    const match = content.match(/```(?:json)?\s*([\s\S]*?)```/)
    if (match) return JSON.parse(match[1].trim())
    throw new Error(`Failed to parse AI response as JSON: ${content.slice(0, 200)}`)
  }
}

const MODULE = 'linkedin'

// ═══════════════════════════════════════════════════════════════════════
// DM Triage
// ═══════════════════════════════════════════════════════════════════════

async function triageDM(dm, profileContext = null) {
  const messages = (dm.messages || []).slice(-10)
  const messageText = messages.map(m => `${m.sender}: ${m.text}`).join('\n')

  const profileInfo = profileContext
    ? `\nParticipant profile:\n- Name: ${profileContext.name}\n- Headline: ${profileContext.headline || 'Unknown'}\n- Company: ${profileContext.company || 'Unknown'}\n- Location: ${profileContext.location || 'Unknown'}\n- Connection degree: ${profileContext.connection_degree || 'Unknown'}\n- Mutual connections: ${profileContext.mutual_connections || 0}`
    : ''

  const prompt = `Triage this LinkedIn DM for Tate Donohoe (21, runs Ecodia Pty Ltd — custom software for impact orgs in Australia).${profileInfo}

Conversation with ${dm.participant_name}:
${messageText || '(no messages scraped)'}

What's happening in this conversation? Who is this person, what do they want, and what should Tate do about it? If they look like a potential client, flag it. If it's noise, say so.

If you suggest a reply, write it as Tate would — direct, friendly, conversational LinkedIn tone.

Respond as JSON:
{
  "category": "lead|networking|recruiter|spam|support|personal",
  "priority": "urgent|high|normal|low|spam",
  "summary": "what this conversation is about",
  "leadScore": 0.0-1.0,
  "leadSignals": [] or ["signal1", ...],
  "suggestedAction": "reply|archive|ignore|create_lead",
  "draftReply": "reply text or null",
  "reasoning": "why"
}`

  const result = await callDeepSeek([{ role: 'user', content: prompt }], { module: MODULE })
  return parseJSON(result)
}

// ═══════════════════════════════════════════════════════════════════════
// Connection Request Scoring
// ═══════════════════════════════════════════════════════════════════════

async function scoreConnectionRequest(request) {
  const prompt = `LinkedIn connection request for Tate Donohoe (Ecodia Pty Ltd — custom software for impact orgs, Australia).

From: ${request.name}
Headline: ${request.headline || 'Unknown'}
Message: ${request.message || '(no message)'}
Mutual connections: ${request.mutualConnections || 0}

Is this person worth connecting with? Tate builds software for nonprofits, conservation, government, and health orgs.

Respond as JSON:
{
  "relevanceScore": 0.0-1.0,
  "recommendation": "accept|decline|review",
  "category": "potential_client|industry_peer|recruiter|random|influencer|complementary_business",
  "reasoning": "why"
}`

  const result = await callDeepSeek([{ role: 'user', content: prompt }], { module: MODULE })
  return parseJSON(result)
}

// ═══════════════════════════════════════════════════════════════════════
// Post Content Generation
// ═══════════════════════════════════════════════════════════════════════

async function generatePostContent(theme, context = {}) {
  const { pastExamples, trendingTopics, postType } = context

  const examplesSection = pastExamples?.length
    ? `\nHere are some of Tate's past posts for tone reference:\n${pastExamples.map(p => `- ${p.content?.slice(0, 200)}`).join('\n')}`
    : ''

  const trendingSection = trendingTopics?.length
    ? `\nTrending topics in the space: ${trendingTopics.join(', ')}`
    : ''

  const typeInstruction = postType === 'poll'
    ? '\nFormat one variation as a LinkedIn poll with a question and 4 options.'
    : ''

  const prompt = `Write LinkedIn post variations for Tate Donohoe (21, founder of Ecodia Pty Ltd — builds custom software for impact orgs: nonprofits, conservation, government, health. Based in Australia).

Tate's voice: authentic, direct, no corporate jargon. He codes and genuinely cares about impact.

Theme: ${theme}${examplesSection}${trendingSection}${typeInstruction}

Write 3 variations — different angles, different energies. Surprise yourself. 800-1500 chars each for best engagement.

Respond as JSON:
{
  "variations": [
    {
      "angle": "what approach this takes",
      "content": "full post text",
      "hashtags": ["#tag1", "#tag2", "#tag3"],
      "characterCount": 1234,
      "hookLine": "the first line"
    }
  ]
}`

  const result = await callDeepSeek([{ role: 'user', content: prompt }], { module: MODULE })
  return parseJSON(result)
}

// ═══════════════════════════════════════════════════════════════════════
// Lead Signal Analysis
// ═══════════════════════════════════════════════════════════════════════

async function analyzeLeadSignals(dm, profileContext = null) {
  const messages = (dm.messages || []).slice(-15)
  const messageText = messages.map(m => `${m.sender}: ${m.text}`).join('\n')

  const profileInfo = profileContext
    ? `\nProfile: ${profileContext.name} — ${profileContext.headline || 'Unknown'} at ${profileContext.company || 'Unknown'}`
    : ''

  const prompt = `Analyse this LinkedIn DM for buying signals. Tate runs Ecodia Pty Ltd (custom software for impact orgs).${profileInfo}

Conversation with ${dm.participant_name}:
${messageText}

Is this person a potential client? What signals do you see — project needs, pain points, budget mentions, timeline pressure, referrals, decision-maker language? What should Tate do next?

Respond as JSON:
{
  "isLead": true/false,
  "leadScore": 0.0-1.0,
  "signals": [
    { "type": "project_need|budget|timeline|referral|pain_point|meeting_request", "evidence": "quote or paraphrase", "strength": "strong|moderate|weak" }
  ],
  "suggestedCRMAction": "create_lead|update_existing|none",
  "suggestedClientData": { "name": "...", "company": "...", "stage": "lead", "notes": "..." } or null,
  "nextStep": "what Tate should do next"
}`

  const result = await callDeepSeek([{ role: 'user', content: prompt }], { module: MODULE })
  return parseJSON(result)
}

// ═══════════════════════════════════════════════════════════════════════
// Optimal Post Timing
// ═══════════════════════════════════════════════════════════════════════

async function suggestOptimalPostTime(historicalData) {
  const postSummary = historicalData.map(p => ({
    day: new Date(p.posted_at).toLocaleDateString('en-AU', { weekday: 'long' }),
    time: new Date(p.posted_at).toLocaleTimeString('en-AU', { hour: '2-digit', minute: '2-digit' }),
    engagementRate: p.engagement_rate,
    impressions: p.impressions,
    reactions: p.reactions,
  }))

  const prompt = `When should Tate post on LinkedIn? He's in Australia (AEST/UTC+10), audience is mostly AU-based.

Historical post data:
${JSON.stringify(postSummary, null, 2)}

What patterns do you see? What's the data actually saying?

Respond as JSON:
{
  "suggestedSlots": [
    { "day": "Tuesday", "time": "09:00", "reason": "why" }
  ],
  "bestDay": "day with best engagement historically",
  "bestTimeRange": "e.g. 8:00-10:00 AEST",
  "insight": "what you noticed in the data"
}`

  const result = await callDeepSeek([{ role: 'user', content: prompt }], { module: MODULE })
  return parseJSON(result)
}

// ═══════════════════════════════════════════════════════════════════════
// Enhanced DM Reply Draft (replaces deepseekService.draftLinkedInReply)
// ═══════════════════════════════════════════════════════════════════════

async function draftDMReply(dm, profileContext = null) {
  const messages = (dm.messages || []).slice(-10)
  const messageText = messages.map(m => `${m.sender}: ${m.text}`).join('\n')

  const profileInfo = profileContext
    ? `\nAbout ${dm.participant_name}: ${profileContext.headline || 'Unknown role'} at ${profileContext.company || 'Unknown company'}. ${profileContext.connection_degree || ''} connection.`
    : ''

  const prompt = `Draft a LinkedIn DM reply for Tate Donohoe (Ecodia Pty Ltd, custom software for impact orgs, Australia).${profileInfo}

Conversation with ${dm.participant_name}:
${messageText}

${dm.category === 'lead' ? 'This looks like a potential client.' : ''}${dm.category === 'recruiter' ? 'Tate runs his own company — not looking for employment.' : ''}

Write as Tate would on LinkedIn — direct, genuine, conversational. Return only the reply text.`

  return callDeepSeek([{ role: 'user', content: prompt }], { module: MODULE })
}

// ═══════════════════════════════════════════════════════════════════════
// Engagement Comment Suggestion (Phase 3)
// ═══════════════════════════════════════════════════════════════════════

async function suggestEngagementComment(postSnippet, authorName, authorHeadline) {
  const prompt = `Write a LinkedIn comment from Tate Donohoe (Ecodia, software dev for impact orgs) on this post.

Post by ${authorName} (${authorHeadline || 'Unknown'}):
"${postSnippet}"

Add something real — a perspective, a question, a related experience. 1-3 sentences. Reference something specific from the post. Return only the comment text.`

  return callDeepSeek([{ role: 'user', content: prompt }], { module: MODULE })
}

module.exports = {
  triageDM,
  scoreConnectionRequest,
  generatePostContent,
  analyzeLeadSignals,
  suggestOptimalPostTime,
  draftDMReply,
  suggestEngagementComment,
}
