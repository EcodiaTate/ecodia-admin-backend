const logger = require('../config/logger')

// ═══════════════════════════════════════════════════════════════════════
// LinkedIn DOM Selectors
// Centralised here so LinkedIn DOM changes only require updating one file.
// Prefer aria-label and data-* attributes over BEM class names.
// ═══════════════════════════════════════════════════════════════════════

const SEL = {
  // Messaging page
  conversationList: '.msg-conversations-container__conversations-list li.msg-conversation-listitem',
  conversationName: '.msg-conversation-listitem__participant-names',
  conversationPreview: '.msg-conversation-listitem__message-snippet',
  conversationUnread: '.msg-conversation-listitem--unread',
  conversationDataId: '[data-id]',
  conversationTime: '.msg-conversation-listitem__time-stamp',
  messageList: '.msg-s-event-listitem',
  messageSender: '.msg-s-message-group__name',
  messageBody: '.msg-s-event__content',
  messageTime: 'time[datetime]',
  messageForm: '.msg-form__contenteditable',
  sendButton: 'button[aria-label="Send"], button.msg-form__send-button',

  // Profile page
  profileName: 'h1.text-heading-xlarge',
  profileHeadline: '.text-body-medium.break-words',
  profileLocation: '.text-body-small.inline.t-black--light',
  profileAbout: '#about ~ div .inline-show-more-text',
  profileCompany: '.pv-text-details__right-panel .inline-show-more-text',
  profileConnectionDegree: '.dist-value',
  profileMutualConnections: '.ember-view [href*="facetNetwork"] span',
  profileImage: '.pv-top-card-profile-picture__image--show',

  // Connection requests
  invitationCard: '.invitation-card',
  invitationName: '.invitation-card__title',
  invitationHeadline: '.invitation-card__subtitle',
  invitationMessage: '.invitation-card__custom-message',
  invitationMutual: '.invitation-card__mutual-connections',
  invitationAccept: 'button[aria-label*="Accept"]',
  invitationDecline: 'button[aria-label*="Ignore"]',
  invitationProfileLink: '.invitation-card__link',

  // Post composer
  postComposerButton: 'button.share-box-feed-entry__trigger',
  postTextArea: '.ql-editor[data-placeholder]',
  postSubmitButton: 'button.share-actions__primary-action',

  // Post performance (own posts)
  postImpressions: '.social-details-social-counts__social-proof-text',
  postReactions: '.social-details-social-counts__reactions-count',
  postComments: 'button[aria-label*="comment"]',
  postReposts: 'button[aria-label*="repost"]',
}

// ═══════════════════════════════════════════════════════════════════════
// DM Scraping
// ═══════════════════════════════════════════════════════════════════════

async function scrapeDMs({ page, navigate, humanDelay, humanClick }) {
  logger.info('Scraping LinkedIn DMs')
  await navigate('https://www.linkedin.com/messaging/')
  await humanDelay(2000, 4000)

  // Wait for conversation list to load
  await page.waitForSelector(SEL.conversationList, { timeout: 10000 }).catch(() => {
    logger.warn('Conversation list not found — may be empty or selectors changed')
  })

  // Scrape conversation list (top 15)
  const conversations = await page.$$eval(SEL.conversationList, (items, sel) => {
    return items.map(item => {
      const dataIdEl = item.querySelector(sel.conversationDataId)
      return {
        id: dataIdEl?.getAttribute('data-id') || item.getAttribute('data-id') || null,
        name: item.querySelector(sel.conversationName)?.textContent?.trim() || 'Unknown',
        preview: item.querySelector(sel.conversationPreview)?.textContent?.trim() || '',
        isUnread: item.classList.contains('msg-conversation-listitem--unread'),
        timestamp: item.querySelector(sel.conversationTime)?.textContent?.trim() || null,
      }
    }).filter(c => c.id)
  }, {
    conversationDataId: SEL.conversationDataId,
    conversationName: SEL.conversationName,
    conversationPreview: SEL.conversationPreview,
    conversationTime: SEL.conversationTime,
  })

  logger.info(`Found ${conversations.length} conversations, ${conversations.filter(c => c.isUnread).length} unread`)

  // Scrape full messages for unread conversations (plus first few read ones for context)
  const toScrape = [
    ...conversations.filter(c => c.isUnread),
    ...conversations.filter(c => !c.isUnread),
  ]

  const results = []
  for (const conv of toScrape) {
    try {
      await humanDelay(1500, 3000)
      const messages = await scrapeConversation({ page, humanDelay }, conv)
      results.push({
        ...conv,
        messages,
        messageCount: messages.length,
      })
    } catch (err) {
      logger.warn(`Failed to scrape conversation ${conv.id}: ${err.message}`)
      results.push({ ...conv, messages: [], messageCount: 0 })
    }
  }

  return results
}

async function scrapeConversation({ page, humanDelay }, conv) {
  // Click into conversation
  const convSelector = `[data-id="${conv.id}"]`
  try {
    await page.click(convSelector)
  } catch {
    // Fallback: click by matching name in the list
    const items = await page.$$(SEL.conversationList)
    for (const item of items) {
      const name = await item.$eval(SEL.conversationName, el => el.textContent.trim()).catch(() => '')
      if (name === conv.name) {
        await item.click()
        break
      }
    }
  }

  await page.waitForSelector(SEL.messageList, { timeout: 8000 }).catch(() => null)
  await humanDelay(800, 1500)

  // Get last 20 messages
  const messages = await page.$$eval(SEL.messageList, (items, sel) => {
    return items.slice(-20).map(item => ({
      sender: item.querySelector(sel.messageSender)?.textContent?.trim() || 'them',
      text: item.querySelector(sel.messageBody)?.textContent?.trim() || '',
      timestamp: item.querySelector(sel.messageTime)?.getAttribute('datetime') || null,
    })).filter(m => m.text)
  }, {
    messageSender: SEL.messageSender,
    messageBody: SEL.messageBody,
    messageTime: SEL.messageTime,
  })

  return messages
}

// ═══════════════════════════════════════════════════════════════════════
// Profile Scraping
// ═══════════════════════════════════════════════════════════════════════

async function scrapeProfile({ page, navigate, humanDelay }, profileUrl) {
  logger.info(`Scraping profile: ${profileUrl}`)
  await navigate(profileUrl)
  await humanDelay(2000, 4000)

  // Extract profile data using individual selectors for resilience
  const getText = async (selector) => {
    return page.$eval(selector, el => el.textContent.trim()).catch(() => null)
  }
  const getAttr = async (selector, attr) => {
    return page.$eval(selector, (el, a) => el.getAttribute(a), attr).catch(() => null)
  }

  const name = await getText(SEL.profileName) || 'Unknown'
  const headline = await getText(SEL.profileHeadline)
  const location = await getText(SEL.profileLocation)
  const company = await getText(SEL.profileCompany)
  const aboutSnippet = await getText(SEL.profileAbout).then(t => t?.slice(0, 500) || null)
  const connectionDegree = await getText(SEL.profileConnectionDegree)
  const profileImageUrl = await getAttr(SEL.profileImage, 'src')

  // Mutual connections
  const mutualText = await getText(SEL.profileMutualConnections)
  const mutualMatch = mutualText?.match(/(\d+)/)
  const mutualConnections = mutualMatch ? parseInt(mutualMatch[1]) : null

  // Check if connected (has Message button, no Connect button)
  const connectButton = await page.$('button[aria-label*="Connect"]')
  const messageButton = await page.$('button[aria-label*="Message"]')
  const isConnection = !connectButton && !!messageButton

  return {
    linkedin_url: profileUrl,
    name,
    headline,
    location,
    company,
    about_snippet: aboutSnippet,
    connection_degree: connectionDegree,
    mutual_connections: mutualConnections,
    is_connection: isConnection,
    profile_image_url: profileImageUrl,
  }
}

// ═══════════════════════════════════════════════════════════════════════
// Connection Requests
// ═══════════════════════════════════════════════════════════════════════

async function scrapeConnectionRequests({ page, navigate, humanDelay }) {
  logger.info('Scraping connection requests')
  await navigate('https://www.linkedin.com/mynetwork/invitation-manager/')
  await humanDelay(2000, 4000)

  await page.waitForSelector(SEL.invitationCard, { timeout: 10000 }).catch(() => {
    logger.info('No pending connection requests or selectors changed')
  })

  const requests = await page.$$eval(SEL.invitationCard, (cards, sel) => {
    return cards.map(card => {
      const profileLink = card.querySelector(sel.invitationProfileLink)
      return {
        name: card.querySelector(sel.invitationName)?.textContent?.trim() || 'Unknown',
        headline: card.querySelector(sel.invitationHeadline)?.textContent?.trim() || null,
        message: card.querySelector(sel.invitationMessage)?.textContent?.trim() || null,
        mutualText: card.querySelector(sel.invitationMutual)?.textContent?.trim() || null,
        linkedinUrl: profileLink?.getAttribute('href') || null,
      }
    })
  }, {
    invitationName: SEL.invitationName,
    invitationHeadline: SEL.invitationHeadline,
    invitationMessage: SEL.invitationMessage,
    invitationMutual: SEL.invitationMutual,
    invitationProfileLink: SEL.invitationProfileLink,
  })

  // Normalize linkedin URLs and extract mutual connection count
  return requests.map(r => ({
    ...r,
    linkedinUrl: r.linkedinUrl
      ? new URL(r.linkedinUrl, 'https://www.linkedin.com').pathname.replace(/\/$/, '')
      : null,
    mutualConnections: r.mutualText ? parseInt(r.mutualText.match(/(\d+)/)?.[1] || '0') : 0,
  }))
}

async function acceptConnectionRequest({ page, humanDelay }, cardIndex) {
  const cards = await page.$$(SEL.invitationCard)
  if (!cards[cardIndex]) throw new Error(`No invitation card at index ${cardIndex}`)

  const acceptBtn = await cards[cardIndex].$(SEL.invitationAccept)
  if (!acceptBtn) throw new Error('Accept button not found')

  await humanDelay(500, 1500)
  await acceptBtn.click()
  await humanDelay(1000, 2000)
  logger.info(`Accepted connection request at index ${cardIndex}`)
}

async function declineConnectionRequest({ page, humanDelay }, cardIndex) {
  const cards = await page.$$(SEL.invitationCard)
  if (!cards[cardIndex]) throw new Error(`No invitation card at index ${cardIndex}`)

  const declineBtn = await cards[cardIndex].$(SEL.invitationDecline)
  if (!declineBtn) throw new Error('Decline button not found')

  await humanDelay(500, 1500)
  await declineBtn.click()
  await humanDelay(1000, 2000)
  logger.info(`Declined connection request at index ${cardIndex}`)
}

// ═══════════════════════════════════════════════════════════════════════
// Network Stats
// ═══════════════════════════════════════════════════════════════════════

async function scrapeNetworkStats({ page, navigate, humanDelay }) {
  logger.info('Scraping network stats')

  // Go to own profile for connection count
  await navigate('https://www.linkedin.com/in/me/')
  await humanDelay(2000, 3000)

  const parseNum = (text) => {
    if (!text) return null
    const match = text.match(/([\d,]+)/)
    return match ? parseInt(match[1].replace(/,/g, '')) : null
  }

  // Connection count
  const connectionCount = await page.$eval(
    'a[href*="/connections/"] span, li.text-body-small a[href*="connections"]',
    el => el.textContent.trim()
  ).then(parseNum).catch(() => null)

  // Follower count
  const followerCount = await page.$eval(
    'a[href*="/followers/"] span, [class*="follower"] span',
    el => el.textContent.trim()
  ).then(parseNum).catch(() => null)

  // Dashboard stats (profile views, search appearances)
  let profileViews = null
  let searchAppearances = null

  try {
    const dashboardItems = await page.$$('.pv-dashboard-section .artdeco-card')
    for (const item of dashboardItems) {
      const text = await item.textContent()
      const num = parseNum(text)
      if (text.toLowerCase().includes('viewed your profile')) profileViews = num
      if (text.toLowerCase().includes('search appearance')) searchAppearances = num
    }
  } catch {
    logger.debug('Could not scrape dashboard stats')
  }

  return { connectionCount, followerCount, profileViews, searchAppearances }
}

// ═══════════════════════════════════════════════════════════════════════
// Post Performance
// ═══════════════════════════════════════════════════════════════════════

async function scrapePostPerformance({ page, navigate, humanDelay }, postUrl) {
  logger.info(`Scraping post performance: ${postUrl}`)
  await navigate(postUrl)
  await humanDelay(2000, 4000)

  const parseCount = (text) => {
    if (!text) return 0
    const match = text.match(/([\d,]+)/)
    return match ? parseInt(match[1].replace(/,/g, '')) : 0
  }

  const getText = async (selector) => page.$eval(selector, el => el.textContent.trim()).catch(() => null)

  const impressions = parseCount(await getText(SEL.postImpressions))
  const reactions = parseCount(await getText(SEL.postReactions))
  const commentsCount = parseCount(await getText(SEL.postComments))
  const reposts = parseCount(await getText(SEL.postReposts))

  return {
    impressions,
    reactions,
    commentsCount,
    reposts,
    engagementRate: impressions > 0 ? (reactions + commentsCount + reposts) / impressions : 0,
  }
}

// ═══════════════════════════════════════════════════════════════════════
// Send DM Reply
// ═══════════════════════════════════════════════════════════════════════

async function sendDMReply({ page, navigate, humanDelay }, conversationId, replyText) {
  logger.info(`Sending DM reply to conversation ${conversationId}`)
  await navigate('https://www.linkedin.com/messaging/')
  await humanDelay(1500, 3000)

  // Click into conversation
  await page.click(`[data-id="${conversationId}"]`)
  await page.waitForSelector(SEL.messageForm, { timeout: 5000 })
  await humanDelay(1500, 2500)

  // Type reply with human-like speed
  await page.focus(SEL.messageForm)
  for (const char of replyText) {
    await page.keyboard.type(char, { delay: Math.floor(Math.random() * 80) + 40 })
  }

  await humanDelay(1000, 2000)

  // Click send button (not Enter — LinkedIn uses Enter for newline)
  const sendButton = page.locator(SEL.sendButton).first()
  await sendButton.click()
  await humanDelay(500, 1000)

  logger.info(`DM reply sent to conversation ${conversationId}`)
}

// ═══════════════════════════════════════════════════════════════════════
// Publish Post
// ═══════════════════════════════════════════════════════════════════════

async function publishPost({ page, navigate, humanDelay }, content) {
  logger.info('Publishing LinkedIn post')
  await navigate('https://www.linkedin.com/feed/')
  await humanDelay(2000, 4000)

  // Click "Start a post" button
  await page.click(SEL.postComposerButton)
  await page.waitForSelector(SEL.postTextArea, { timeout: 8000 })
  await humanDelay(1000, 2000)

  // Type post content in chunks (char-by-char is too slow for long content)
  await page.focus(SEL.postTextArea)
  const chunks = content.match(/.{1,20}/g) || [content]
  for (const chunk of chunks) {
    await page.keyboard.type(chunk, { delay: Math.floor(Math.random() * 30) + 10 })
    if (Math.random() < 0.1) await humanDelay(500, 1500)
  }

  await humanDelay(2000, 4000)

  // Click post button
  const postButton = page.locator(SEL.postSubmitButton).first()
  await postButton.click()
  await humanDelay(2000, 3000)

  logger.info('LinkedIn post published')
}

// ═══════════════════════════════════════════════════════════════════════
// Selector Health Check
// ═══════════════════════════════════════════════════════════════════════

async function checkSelectorHealth({ page, navigate, humanDelay }) {
  const issues = []

  // Check messaging page selectors
  await navigate('https://www.linkedin.com/messaging/')
  await humanDelay(2000, 3000)
  const hasConversations = await page.$(SEL.conversationList)
  if (!hasConversations) issues.push('conversationList selector not found on /messaging/')

  if (issues.length > 0) {
    logger.warn('Selector health check found issues:', { issues })
  } else {
    logger.info('Selector health check passed')
  }

  return { healthy: issues.length === 0, issues }
}

module.exports = {
  scrapeDMs,
  scrapeConversation,
  scrapeProfile,
  scrapeConnectionRequests,
  acceptConnectionRequest,
  declineConnectionRequest,
  scrapeNetworkStats,
  scrapePostPerformance,
  sendDMReply,
  publishPost,
  checkSelectorHealth,
  SEL,
}
