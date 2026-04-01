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

  const prompt = `You are Tate Donohoe's LinkedIn DM assistant. Tate is a 21-year-old software developer running Ecodia Pty Ltd in Australia. He builds custom software for impact-focused organisations (nonprofits, conservation, government, health).

Analyse this LinkedIn DM conversation and classify it.${profileInfo}

Conversation with ${dm.participant_name}:
${messageText || '(no messages scraped)'}

Be aggressive about identifying business opportunities. Tate wants to know immediately if someone might become a client. Filter noise (recruiters, generic networking, spam) efficiently.

Respond with JSON only:
{
  "category": "lead|networking|recruiter|spam|support|personal",
  "priority": "urgent|high|normal|low|spam",
  "summary": "one concise sentence about what this conversation is about and what they want",
  "leadScore": 0.0 to 1.0 (how likely this person is a potential client, 0 = definitely not, 1 = definitely yes),
  "leadSignals": ["signal1", "signal2"] or [] if no lead signals detected,
  "suggestedAction": "reply|archive|ignore|create_lead",
  "draftReply": "if suggestedAction is reply, write a natural DM reply in Tate's voice (direct, friendly, conversational LinkedIn tone, no corporate fluff). null if no reply needed",
  "reasoning": "brief explanation of classification"
}

Category guide:
- lead: mentions project needs, software development, wants to build something, asks about pricing/availability
- networking: industry peer, fellow founder, genuine professional connection
- recruiter: recruiting, hiring, job opportunity
- spam: sales pitch, mass outreach, irrelevant marketing
- support: existing client or project-related follow-up
- personal: friend, casual, non-business

Priority guide:
- urgent: active buying signal, mentions budget/timeline, warm referral
- high: potential lead, interesting connection in target industry
- normal: general networking, informational
- low: recruiter, vague connection
- spam: obvious spam/sales pitch`

  const result = await callDeepSeek([{ role: 'user', content: prompt }], { module: MODULE })
  return parseJSON(result)
}

// ═══════════════════════════════════════════════════════════════════════
// Connection Request Scoring
// ═══════════════════════════════════════════════════════════════════════

async function scoreConnectionRequest(request) {
  const prompt = `You are evaluating a LinkedIn connection request for Tate Donohoe, founder of Ecodia Pty Ltd (custom software development for impact organisations in Australia).

Connection request from:
- Name: ${request.name}
- Headline: ${request.headline || 'Unknown'}
- Message: ${request.message || '(no message)'}
- Mutual connections: ${request.mutualConnections || 0}

Score this connection request's relevance to Tate's business. Tate's ideal connections are:
- Decision-makers at nonprofits, conservation orgs, government, health orgs
- Founders/CTOs of complementary businesses
- People in the Australian tech/impact ecosystem
- Potential clients who might need custom software

Respond with JSON only:
{
  "relevanceScore": 0.0 to 1.0,
  "recommendation": "accept|decline|review",
  "category": "potential_client|industry_peer|recruiter|random|influencer|complementary_business",
  "reasoning": "brief explanation"
}

Recommendation guide:
- accept: clearly relevant (score > 0.6), potential client, strong industry peer
- review: ambiguous, could be useful but not obviously so (score 0.3-0.6)
- decline: irrelevant, recruiter, random (score < 0.3)`

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

  const prompt = `You are a LinkedIn content strategist for Tate Donohoe, a 21-year-old Australian software developer who runs Ecodia Pty Ltd. Ecodia builds custom software for impact-focused organisations (nonprofits, conservation, government, health).

Tate's LinkedIn voice: authentic, direct, occasionally technical, always approachable. He shares real experiences building software for good causes. No corporate jargon, no "I'm pleased to announce" energy. Think founder who codes and genuinely cares about impact.

Theme/topic: ${theme}${examplesSection}${trendingSection}${typeInstruction}

Generate 3 LinkedIn post variations. Each should be different in angle/tone:
1. Story/experience-driven (personal, relatable)
2. Insight/educational (teaches something)
3. Conversation-starter (asks a question, invites engagement)

Respond with JSON only:
{
  "variations": [
    {
      "angle": "story|insight|conversation",
      "content": "the full post text (aim for 800-1500 characters for best engagement)",
      "hashtags": ["#tag1", "#tag2", "#tag3"],
      "characterCount": 1234,
      "hookLine": "the first line (most important for engagement)"
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

  const prompt = `Analyse this LinkedIn DM conversation for buying signals. Tate Donohoe runs Ecodia Pty Ltd, building custom software for impact organisations.${profileInfo}

Conversation with ${dm.participant_name}:
${messageText}

Look for:
- Explicit mentions of needing software/website/app built
- Pain points that custom software could solve
- Budget/funding mentions
- Timeline or deadline references
- Requests for proposals, quotes, or meetings
- Referrals from existing clients
- Decision-maker language ("we need", "our team wants")

Respond with JSON only:
{
  "isLead": true/false,
  "leadScore": 0.0 to 1.0,
  "signals": [
    { "type": "project_need|budget|timeline|referral|pain_point|meeting_request", "evidence": "exact quote or paraphrase from conversation", "strength": "strong|moderate|weak" }
  ],
  "suggestedCRMAction": "create_lead|update_existing|none",
  "suggestedClientData": {
    "name": "contact name",
    "company": "company name or null",
    "stage": "lead",
    "notes": "summary of opportunity"
  } or null,
  "nextStep": "what Tate should do next (specific, actionable)"
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

  const prompt = `Analyse these LinkedIn post performance metrics for Tate Donohoe (Australian timezone, AEST/UTC+10) and suggest the best times to post.

Historical post data:
${JSON.stringify(postSummary, null, 2)}

Consider:
- LinkedIn's general best practices (Tuesday-Thursday, 8-10am, 12pm, 5-6pm)
- Tate's actual data — which days/times got the best engagement
- Australian business hours (most of his audience is AU-based)
- Avoid weekends and late nights

Respond with JSON only:
{
  "suggestedSlots": [
    { "day": "Tuesday", "time": "09:00", "reason": "brief reason" },
    { "day": "Thursday", "time": "12:00", "reason": "brief reason" }
  ],
  "bestDay": "day of week with historically best engagement",
  "bestTimeRange": "e.g. 8:00-10:00 AEST",
  "insight": "one sentence about the data pattern"
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

  const prompt = `Draft a LinkedIn DM reply for Tate Donohoe, founder of Ecodia Pty Ltd (custom software for impact organisations, based in Australia).${profileInfo}

Conversation with ${dm.participant_name}:
${messageText}

Write a brief, friendly, professional reply. Keep it conversational for LinkedIn — not too formal, not too casual. Tate's style: direct, genuine, no fluff.

${dm.category === 'lead' ? 'This is a potential lead — be warm, show interest, ask clarifying questions about their needs.' : ''}
${dm.category === 'recruiter' ? 'Politely decline — Tate runs his own company and is not looking for employment.' : ''}

Return ONLY the reply text, no JSON wrapping.`

  return callDeepSeek([{ role: 'user', content: prompt }], { module: MODULE })
}

// ═══════════════════════════════════════════════════════════════════════
// Engagement Comment Suggestion (Phase 3)
// ═══════════════════════════════════════════════════════════════════════

async function suggestEngagementComment(postSnippet, authorName, authorHeadline) {
  const prompt = `Write a thoughtful LinkedIn comment for Tate Donohoe (founder of Ecodia, software dev for impact orgs) to post on someone else's content.

Post by ${authorName} (${authorHeadline || 'Unknown'}):
"${postSnippet}"

The comment should:
- Add genuine value (share a related experience, ask a smart question, or add a perspective)
- Sound authentically human (not AI-generated)
- Be 1-3 sentences max
- Reference something specific from the post
- NOT be generic ("Great post!", "Thanks for sharing!")

Return ONLY the comment text.`

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
