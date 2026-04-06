const logger = require('../config/logger')
const browser = require('./linkedinBrowser')
const scraper = require('./linkedinScraper')
const ai = require('./linkedinAI')
const queries = require('../db/queries/linkedin')
const { findClientByLinkedIn } = require('../db/queries/clients')
const kgHooks = require('./kgIngestionHooks')

// ═══════════════════════════════════════════════════════════════════════
// DM Operations
// ═══════════════════════════════════════════════════════════════════════

async function checkDMs() {
  if (!await browser.checkDailyBudget('dm_reads')) return { scraped: 0 }

  const log = await queries.createScrapeLog('dms')
  const start = Date.now()

  try {
    const conversations = await browser.withBrowser(async (tools) => {
      return scraper.scrapeDMs(tools)
    })

    let upserted = 0
    for (const conv of conversations) {
      const dm = await queries.upsertDM({
        conversationId: conv.id,
        participantName: conv.name,
        messages: conv.messages,
        messageCount: conv.messageCount,
      })

      // Try to link to CRM client by profile URL if available
      if (conv.participantProfileUrl) {
        const existingClient = await findClientByLinkedIn(conv.participantProfileUrl)
        if (existingClient && !dm.client_id) {
          await queries.updateDM(dm.id, { client_id: existingClient.id })
        }
      }

      // Fire-and-forget KG ingestion for new DMs
      kgHooks.onLinkedInDMProcessed({ dm }).catch(() => {})

      upserted++
    }

    await queries.completeScrapeLog(log.id, {
      status: 'complete',
      itemsFound: upserted,
      durationMs: Date.now() - start,
    })

    // Triage pending DMs
    await triagePendingDMs()

    logger.info(`LinkedIn DM check complete: ${upserted} conversations processed`)
    return { scraped: upserted }
  } catch (err) {
    await queries.completeScrapeLog(log.id, {
      status: err.name === 'LinkedInChallengeError' ? 'captcha' : 'failed',
      errorMessage: err.message,
      durationMs: Date.now() - start,
    })
    throw err
  }
}

async function triagePendingDMs() {
  const pendingDMs = await queries.getPendingTriageDMs(10)

  for (const dm of pendingDMs) {
    try {
      let profileContext = null
      if (dm.profile_id) {
        profileContext = await queries.getProfileById(dm.profile_id)
      }

      const triage = await ai.triageDM(dm, profileContext)

      await queries.updateDM(dm.id, {
        category: triage.category,
        priority: triage.priority,
        triage_summary: triage.summary,
        triage_status: 'complete',
        triage_attempts: (dm.triage_attempts || 0) + 1,
        lead_score: triage.leadScore || null,
        lead_signals: triage.leadSignals?.length ? JSON.stringify(triage.leadSignals) : '[]',
        draft_reply: triage.draftReply || dm.draft_reply,
      })

      if (dm.status === 'unread' && triage.draftReply) {
        await queries.updateDM(dm.id, { status: 'drafting' })
      }

      // Enqueue to action queue — AI decides what surfaces
      const actionQueue = require('./actionQueueService')

      // Surface reply if draft exists and it's not spam/ignore
      if (triage.draftReply && triage.priority !== 'spam' && triage.suggestedAction !== 'ignore') {
        await actionQueue.enqueue({
          source: 'linkedin',
          sourceRefId: dm.id,
          actionType: 'send_linkedin_reply',
          title: `Reply to ${dm.participant_name}`,
          summary: triage.summary,
          preparedData: { draft: triage.draftReply },
          context: { from: dm.participant_name, email: dm.participant_email || null, participantName: dm.participant_name, company: dm.participant_company, headline: dm.participant_headline, leadScore: triage.leadScore },
          priority: triage.priority === 'spam' ? 'low' : triage.priority,
        }).catch(() => {})
      }

      // Surface lead creation if it's a lead
      if (triage.category === 'lead' && triage.suggestedAction === 'create_lead') {
        await actionQueue.enqueue({
          source: 'linkedin',
          sourceRefId: dm.id,
          actionType: 'create_lead',
          title: `New lead: ${dm.participant_name}${dm.participant_company ? ` (${dm.participant_company})` : ''}`,
          summary: triage.summary,
          preparedData: { name: dm.participant_name, company: dm.participant_company, linkedinUrl: dm.participant_linkedin_url, leadScore: triage.leadScore, notes: triage.summary },
          context: { from: dm.participant_name, email: dm.participant_email || null, leadScore: triage.leadScore, signals: triage.leadSignals },
          priority: triage.priority,
        }).catch(() => {})
      }

      // Code work detection — if the DM contains a code/feature request, bridge to Factory
      const hasCodeWork = triage.isCodeWorkRequest === true
        && typeof triage.factoryPrompt === 'string'
        && triage.factoryPrompt.trim().length >= 10
      if (hasCodeWork) {
        const codeRequestService = require('./codeRequestService')
        await codeRequestService.createFromSocial({
          source: 'linkedin',
          sourceRefId: dm.id,
          clientId: dm.client_id || null,
          summary: triage.summary || triage.factoryPrompt.slice(0, 200),
          factoryPrompt: triage.factoryPrompt.trim(),
          codeWorkType: triage.codeWorkType,
          suggestedCodebase: (typeof triage.suggestedCodebase === 'string' && triage.suggestedCodebase.trim()) || null,
          confidence: typeof triage.leadScore === 'number' ? triage.leadScore : 0.5,
          surfaceToHuman: true,
          replyContext: {
            platform: 'linkedin',
            dmId: dm.id,
            conversationId: dm.conversation_id,
            participantName: dm.participant_name,
          },
        }).catch(err => logger.warn(`Code request creation failed for LinkedIn DM ${dm.id}`, { error: err.message }))
      }

      logger.debug(`Triaged DM ${dm.id}: ${triage.category}/${triage.priority}`)
    } catch (err) {
      logger.warn(`Failed to triage DM ${dm.id}: ${err.message}`)
      await queries.updateDM(dm.id, {
        triage_status: 'pending_retry',
        triage_attempts: (dm.triage_attempts || 0) + 1,
      })
    }
  }
}

async function sendDMReply(dmId) {
  const dm = await queries.getDMById(dmId)
  if (!dm) throw new Error('DM not found')
  if (!dm.draft_reply) throw new Error('No draft reply to send')

  if (!await browser.checkDailyBudget('messages_sent')) {
    throw new Error('Daily message send budget exhausted')
  }

  await browser.withBrowser(async (tools) => {
    await scraper.sendDMReply(tools, dm.conversation_id, dm.draft_reply)
  })

  return queries.updateDM(dmId, { status: 'replied' })
}

async function draftDMReply(dmId) {
  const dm = await queries.getDMById(dmId)
  if (!dm) throw new Error('DM not found')

  let profileContext = null
  if (dm.profile_id) {
    profileContext = await queries.getProfileById(dm.profile_id)
  }

  const draft = await ai.draftDMReply(dm, profileContext)
  return queries.updateDM(dmId, { draft_reply: draft, status: 'drafting' })
}

async function triageDM(dmId) {
  const dm = await queries.getDMById(dmId)
  if (!dm) throw new Error('DM not found')

  let profileContext = null
  if (dm.profile_id) {
    profileContext = await queries.getProfileById(dm.profile_id)
  }

  const triage = await ai.triageDM(dm, profileContext)

  return queries.updateDM(dmId, {
    category: triage.category,
    priority: triage.priority,
    triage_summary: triage.summary,
    triage_status: 'complete',
    triage_attempts: (dm.triage_attempts || 0) + 1,
    lead_score: triage.leadScore || null,
    lead_signals: triage.leadSignals?.length ? JSON.stringify(triage.leadSignals) : '[]',
    draft_reply: triage.draftReply || dm.draft_reply,
  })
}

async function analyzeLeadSignals(dmId) {
  const dm = await queries.getDMById(dmId)
  if (!dm) throw new Error('DM not found')

  let profileContext = null
  if (dm.profile_id) {
    profileContext = await queries.getProfileById(dm.profile_id)
  }

  return ai.analyzeLeadSignals(dm, profileContext)
}

async function linkDMToClient(dmId, clientId) {
  return queries.updateDM(dmId, { client_id: clientId })
}

// ═══════════════════════════════════════════════════════════════════════
// Profile Operations
// ═══════════════════════════════════════════════════════════════════════

async function scrapeAndSaveProfile(profileUrl) {
  if (!await browser.checkDailyBudget('profile_views')) {
    throw new Error('Daily profile view budget exhausted')
  }

  const data = await browser.withBrowser(async (tools) => {
    return scraper.scrapeProfile(tools, profileUrl)
  })

  const profile = await queries.upsertProfile(data)

  // Fire-and-forget KG ingestion
  kgHooks.onLinkedInProfileProcessed({ profile: { ...data, id: profile?.id } }).catch(() => {})

  return profile
}

async function linkProfileToClient(profileId, clientId) {
  const db = require('../config/db')
  const [updated] = await db`
    UPDATE linkedin_profiles SET client_id = ${clientId}, updated_at = now()
    WHERE id = ${profileId}
    RETURNING *
  `
  return updated
}

// ═══════════════════════════════════════════════════════════════════════
// Connection Request Operations
// ═══════════════════════════════════════════════════════════════════════

async function checkConnectionRequests() {
  const log = await queries.createScrapeLog('connections')
  const start = Date.now()

  try {
    const requests = await browser.withBrowser(async (tools) => {
      return scraper.scrapeConnectionRequests(tools)
    })

    let saved = 0
    for (const req of requests) {
      let profileId = null
      if (req.linkedinUrl) {
        const profile = await queries.upsertProfile({
          linkedin_url: `https://www.linkedin.com${req.linkedinUrl}`,
          name: req.name,
          headline: req.headline,
          mutual_connections: req.mutualConnections,
        })
        profileId = profile?.id
      }

      let scoring = null
      try {
        scoring = await ai.scoreConnectionRequest(req)
      } catch (err) {
        logger.warn(`Failed to score connection request from ${req.name}: ${err.message}`)
      }

      await queries.upsertConnectionRequest({
        ...req,
        direction: 'incoming',
        profile_id: profileId,
        relevance_score: scoring?.relevanceScore || null,
        relevance_reason: scoring?.reasoning || null,
      })
      saved++
    }

    await queries.completeScrapeLog(log.id, {
      status: 'complete',
      itemsFound: saved,
      durationMs: Date.now() - start,
    })

    logger.info(`Connection request check complete: ${saved} requests processed`)
    return { scraped: saved }
  } catch (err) {
    await queries.completeScrapeLog(log.id, {
      status: err.name === 'LinkedInChallengeError' ? 'captcha' : 'failed',
      errorMessage: err.message,
      durationMs: Date.now() - start,
    })
    throw err
  }
}

async function acceptConnection(requestId) {
  if (!await browser.checkDailyBudget('connection_accepts')) {
    throw new Error('Daily connection accept budget exhausted')
  }

  const allReqs = await queries.getConnectionRequests({ status: 'pending' })
  const target = allReqs.find(r => r.id === requestId)
  if (!target) throw new Error('Connection request not found or already acted on')

  await browser.withBrowser(async (tools) => {
    await tools.navigate('https://www.linkedin.com/mynetwork/invitation-manager/')
    await tools.humanDelay(2000, 3000)

    const cards = await tools.page.$$(scraper.SEL.invitationCard)
    for (let i = 0; i < cards.length; i++) {
      const name = await cards[i].$(scraper.SEL.invitationName)
      const nameText = name ? await name.textContent() : ''
      if (nameText.trim() === target.name) {
        await scraper.acceptConnectionRequest(tools, i)
        break
      }
    }
  })

  return queries.updateConnectionRequest(requestId, { status: 'accepted' })
}

async function declineConnection(requestId) {
  const allReqs = await queries.getConnectionRequests({ status: 'pending' })
  const target = allReqs.find(r => r.id === requestId)
  if (!target) throw new Error('Connection request not found or already acted on')

  await browser.withBrowser(async (tools) => {
    await tools.navigate('https://www.linkedin.com/mynetwork/invitation-manager/')
    await tools.humanDelay(2000, 3000)

    const cards = await tools.page.$$(scraper.SEL.invitationCard)
    for (let i = 0; i < cards.length; i++) {
      const name = await cards[i].$(scraper.SEL.invitationName)
      const nameText = name ? await name.textContent() : ''
      if (nameText.trim() === target.name) {
        await scraper.declineConnectionRequest(tools, i)
        break
      }
    }
  })

  return queries.updateConnectionRequest(requestId, { status: 'declined' })
}

// ═══════════════════════════════════════════════════════════════════════
// Post Operations
// ═══════════════════════════════════════════════════════════════════════

async function publishDuePosts() {
  if (!await browser.checkDailyBudget('posts_published')) return { published: 0 }

  const duePosts = await queries.getDueScheduledPosts()
  if (duePosts.length === 0) return { published: 0 }

  const log = await queries.createScrapeLog('posts')
  const start = Date.now()
  let published = 0

  try {
    await browser.withBrowser(async (tools) => {
      for (const post of duePosts) {
        try {
          await scraper.publishPost(tools, post.content)
          await queries.updatePost(post.id, { status: 'posted', posted_at: new Date().toISOString() })
          published++
          await tools.humanDelay(5000, 10000)
        } catch (err) {
          logger.error(`Failed to publish post ${post.id}: ${err.message}`)
          await queries.updatePost(post.id, { status: 'failed' })
        }
      }
    })

    await queries.completeScrapeLog(log.id, {
      status: 'complete',
      itemsFound: published,
      durationMs: Date.now() - start,
    })

    return { published }
  } catch (err) {
    await queries.completeScrapeLog(log.id, {
      status: err.name === 'LinkedInChallengeError' ? 'captcha' : 'failed',
      errorMessage: err.message,
      durationMs: Date.now() - start,
    })
    throw err
  }
}

async function generatePostContent(theme, context = {}) {
  return ai.generatePostContent(theme, context)
}

async function suggestPostTimes() {
  const db = require('../config/db')
  const historicalPosts = await db`
    SELECT posted_at, engagement_rate, impressions, reactions
    FROM linkedin_posts
    WHERE status = 'posted' AND posted_at IS NOT NULL
    ORDER BY posted_at DESC
    LIMIT 30
  `
  if (historicalPosts.length < 3) {
    return {
      suggestedSlots: [
        { day: 'Tuesday', time: '09:00', reason: 'Default — not enough data yet' },
        { day: 'Thursday', time: '12:00', reason: 'Default — not enough data yet' },
      ],
      bestDay: 'Tuesday',
      bestTimeRange: '08:00-10:00 AEST',
      insight: 'Not enough historical data yet. Defaults based on LinkedIn best practices.',
    }
  }
  return ai.suggestOptimalPostTime(historicalPosts)
}

// ═══════════════════════════════════════════════════════════════════════
// Network Analytics
// ═══════════════════════════════════════════════════════════════════════

async function scrapeNetworkStats() {
  const log = await queries.createScrapeLog('network_stats')
  const start = Date.now()

  try {
    const stats = await browser.withBrowser(async (tools) => {
      return scraper.scrapeNetworkStats(tools)
    })

    await queries.saveNetworkSnapshot(stats)

    await queries.completeScrapeLog(log.id, {
      status: 'complete',
      itemsFound: 1,
      durationMs: Date.now() - start,
    })

    logger.info('Network stats scraped', stats)
    return stats
  } catch (err) {
    await queries.completeScrapeLog(log.id, {
      status: err.name === 'LinkedInChallengeError' ? 'captcha' : 'failed',
      errorMessage: err.message,
      durationMs: Date.now() - start,
    })
    throw err
  }
}

async function scrapePostPerformance() {
  const posts = await queries.getPostedPostsForPerformanceScrape()
  if (posts.length === 0) return { scraped: 0 }

  const log = await queries.createScrapeLog('post_performance')
  const start = Date.now()
  let scraped = 0

  try {
    await browser.withBrowser(async (tools) => {
      for (const post of posts) {
        try {
          const perf = await scraper.scrapePostPerformance(tools, post.linkedin_post_url)
          await queries.updatePost(post.id, {
            impressions: perf.impressions,
            reactions: perf.reactions,
            comments_count: perf.commentsCount,
            reposts: perf.reposts,
            engagement_rate: perf.engagementRate,
            performance_scraped_at: new Date().toISOString(),
          })
          scraped++
          await tools.humanDelay(3000, 6000)
        } catch (err) {
          logger.warn(`Failed to scrape performance for post ${post.id}: ${err.message}`)
        }
      }
    })

    await queries.completeScrapeLog(log.id, {
      status: 'complete',
      itemsFound: scraped,
      durationMs: Date.now() - start,
    })

    return { scraped }
  } catch (err) {
    await queries.completeScrapeLog(log.id, {
      status: err.name === 'LinkedInChallengeError' ? 'captcha' : 'failed',
      errorMessage: err.message,
      durationMs: Date.now() - start,
    })
    throw err
  }
}

// ═══════════════════════════════════════════════════════════════════════
// Worker Status (delegates to browser module)
// ═══════════════════════════════════════════════════════════════════════

const getWorkerStatus = browser.getSessionStatus
const resumeWorker = browser.resumeSession
const suspendWorker = browser.suspendSession
const setSessionCookie = browser.setSessionCookie

module.exports = {
  checkDMs, triagePendingDMs, sendDMReply, draftDMReply, triageDM, analyzeLeadSignals, linkDMToClient,
  scrapeAndSaveProfile, linkProfileToClient,
  checkConnectionRequests, acceptConnection, declineConnection,
  publishDuePosts, generatePostContent, suggestPostTimes,
  scrapeNetworkStats, scrapePostPerformance,
  getWorkerStatus, resumeWorker, suspendWorker, setSessionCookie,
}
