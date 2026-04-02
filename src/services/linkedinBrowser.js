let chromium
try {
  chromium = require('playwright').chromium
} catch {
  chromium = null
}
const logger = require('../config/logger')
const db = require('../config/db')
const { encrypt, decrypt } = require('../utils/encryption')

// ─── Constants ─────────────────────────────────────────────────────────

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
const VIEWPORT = { width: 1920, height: 1080 }
const TIMEZONE = 'Australia/Brisbane'
const LOCALE = 'en-AU'

// Rate limiting
const MAX_SESSIONS_PER_DAY = 5
const MAX_SESSION_DURATION_MS = 15 * 60 * 1000 // 15 minutes
const MIN_COOLDOWN_MS = 30 * 60 * 1000 // 30 minutes between sessions
const MAX_NAVIGATIONS_PER_SESSION = 30

const DAILY_BUDGETS = {
  navigations: 80,
  profile_views: 15,
  dm_reads: 30,
  messages_sent: 10,
  connection_accepts: 20,
  posts_published: 3,
}

// CAPTCHA/challenge URL patterns
const CHALLENGE_PATTERNS = ['/checkpoint', '/challenge', '/authwall', '/security/']

// ─── In-Memory State ───────────────────────────────────────────────────

let sessionNavigations = 0
let sessionStartedAt = null
let lastSessionEndedAt = null
let sessionsToday = 0
let sessionsDayKey = null // tracks which day the count is for

function resetDailyCountIfNeeded() {
  const today = new Date().toISOString().slice(0, 10)
  if (sessionsDayKey !== today) {
    sessionsToday = 0
    sessionsDayKey = today
  }
}

// ─── Human-Like Helpers ────────────────────────────────────────────────

function humanDelay(minMs = 500, maxMs = 2000) {
  const delay = Math.floor(Math.random() * (maxMs - minMs)) + minMs
  return new Promise(resolve => setTimeout(resolve, delay))
}

async function humanType(page, selector, text) {
  await page.focus(selector)
  await humanDelay(200, 500)
  for (const char of text) {
    await page.keyboard.type(char, { delay: Math.floor(Math.random() * 100) + 80 })
    // Occasional micro-pause (like a human thinking)
    if (Math.random() < 0.05) await humanDelay(300, 800)
  }
}

async function humanClick(page, selector) {
  const element = page.locator(selector).first()
  await element.waitFor({ timeout: 5000 })
  const box = await element.boundingBox()
  if (box) {
    // Click at a random position within the element
    const x = box.x + Math.random() * box.width
    const y = box.y + Math.random() * box.height
    await page.mouse.move(x, y, { steps: Math.floor(Math.random() * 5) + 3 })
    await humanDelay(100, 300)
    await page.mouse.click(x, y)
  } else {
    await element.click()
  }
}

async function humanScroll(page, distance = 500) {
  const steps = Math.floor(Math.random() * 3) + 3
  const stepDistance = Math.floor(distance / steps)
  for (let i = 0; i < steps; i++) {
    await page.mouse.wheel(0, stepDistance + Math.floor(Math.random() * 50) - 25)
    await humanDelay(200, 600)
  }
}

// ─── CAPTCHA Detection ─────────────────────────────────────────────────

function isChallengeUrl(url) {
  return CHALLENGE_PATTERNS.some(p => url.includes(p))
}

async function checkForChallenge(page) {
  const url = page.url()
  if (isChallengeUrl(url)) {
    throw new LinkedInChallengeError(`Challenge detected at: ${url}`)
  }
}

class LinkedInChallengeError extends Error {
  constructor(msg) { super(msg); this.name = 'LinkedInChallengeError' }
}

// ─── Rate Limit Checks ────────────────────────────────────────────────

async function getDailyBudgetUsed(actionType) {
  const today = new Date().toISOString().slice(0, 10)
  const [row] = await db`
    SELECT COALESCE(SUM(items_found), 0)::int AS used
    FROM linkedin_scrape_log
    WHERE job_type = ${actionType}
      AND created_at::date = ${today}::date
      AND status = 'complete'
  `
  return row?.used || 0
}

async function checkDailyBudget(actionType) {
  const budget = DAILY_BUDGETS[actionType]
  if (!budget) return true
  const used = await getDailyBudgetUsed(actionType)
  if (used >= budget) {
    logger.warn(`Daily budget exhausted for ${actionType}: ${used}/${budget}`)
    return false
  }
  return true
}

function checkSessionLimits() {
  if (sessionNavigations >= MAX_NAVIGATIONS_PER_SESSION) {
    throw new Error(`Session navigation limit reached: ${sessionNavigations}/${MAX_NAVIGATIONS_PER_SESSION}`)
  }
  if (sessionStartedAt && (Date.now() - sessionStartedAt) > MAX_SESSION_DURATION_MS) {
    throw new Error('Session duration limit exceeded')
  }
}

// ─── Cookie Persistence ────────────────────────────────────────────────

async function loadCookies() {
  const [session] = await db`SELECT cookies, status, suspend_reason FROM linkedin_session WHERE id = 'default'`
  if (!session) return null
  if (session.status === 'suspended' || session.status === 'captcha') {
    throw new Error(`Session is ${session.status}: ${session.suspend_reason || 'unknown'}`)
  }
  if (!session.cookies) return null
  try {
    return JSON.parse(decrypt(session.cookies))
  } catch (err) {
    logger.warn('Failed to decrypt LinkedIn cookies', { error: err.message })
    return null
  }
}

async function saveCookies(cookies) {
  const encrypted = encrypt(JSON.stringify(cookies))
  await db`
    UPDATE linkedin_session
    SET cookies = ${encrypted}, last_active_at = now(), status = 'active', updated_at = now()
    WHERE id = 'default'
  `
}

async function getSessionStatus() {
  const [session] = await db`SELECT status, suspend_reason, last_active_at, updated_at FROM linkedin_session WHERE id = 'default'`
  if (!session) return { status: 'inactive', reason: null, lastActive: null }

  // Compute budget usage
  const budgetUsage = {}
  for (const [key, limit] of Object.entries(DAILY_BUDGETS)) {
    const used = await getDailyBudgetUsed(key)
    budgetUsage[key] = { used, limit, remaining: Math.max(0, limit - used) }
  }

  return {
    status: session.status,
    reason: session.suspend_reason,
    lastActive: session.last_active_at,
    budgetUsage,
    sessionsToday,
    maxSessionsPerDay: MAX_SESSIONS_PER_DAY,
  }
}

async function setSessionCookie(liAtCookie) {
  const cookies = [{
    name: 'li_at',
    value: liAtCookie,
    domain: '.linkedin.com',
    path: '/',
    httpOnly: true,
    secure: true,
    sameSite: 'None',
  }]
  await saveCookies(cookies)
  logger.info('LinkedIn li_at cookie set manually')
}

async function suspendSession(reason) {
  await db`
    UPDATE linkedin_session
    SET status = 'suspended', suspend_reason = ${reason}, updated_at = now()
    WHERE id = 'default'
  `
  logger.error(`LinkedIn session suspended: ${reason}`)

  // Create notification
  await db`
    INSERT INTO notifications (type, message, link, metadata)
    VALUES ('system', ${'LinkedIn suspended: ' + reason}, '/linkedin', ${JSON.stringify({ reason, action: 'linkedin_suspended' })})
  `.catch(err => logger.error('Failed to create suspension notification', { error: err.message }))
}

async function resumeSession() {
  await db`
    UPDATE linkedin_session
    SET status = 'inactive', suspend_reason = NULL, updated_at = now()
    WHERE id = 'default'
  `
  logger.info('LinkedIn session resumed')
}

// ─── Browser Lifecycle ─────────────────────────────────────────────────

async function withBrowser(callback) {
  resetDailyCountIfNeeded()

  // Check session limits
  if (sessionsToday >= MAX_SESSIONS_PER_DAY) {
    throw new Error(`Daily session limit reached: ${sessionsToday}/${MAX_SESSIONS_PER_DAY}`)
  }
  if (lastSessionEndedAt && (Date.now() - lastSessionEndedAt) < MIN_COOLDOWN_MS) {
    const remaining = Math.ceil((MIN_COOLDOWN_MS - (Date.now() - lastSessionEndedAt)) / 60000)
    throw new Error(`Session cooldown: ${remaining} minutes remaining`)
  }

  // Load cookies
  const cookies = await loadCookies()
  if (!cookies || cookies.length === 0) {
    throw new Error('No LinkedIn cookies configured. Set li_at cookie from Settings.')
  }

  sessionNavigations = 0
  sessionStartedAt = Date.now()
  sessionsToday++

  let browser = null
  let context = null

  try {
    if (!chromium) throw new Error('Playwright not installed — run npm install playwright')
    browser = await chromium.launch({
      headless: true,
      args: ['--disable-gpu', '--no-sandbox', '--disable-dev-shm-usage', '--disable-blink-features=AutomationControlled'],
    })

    context = await browser.newContext({
      userAgent: USER_AGENT,
      viewport: VIEWPORT,
      locale: LOCALE,
      timezoneId: TIMEZONE,
      permissions: [],
      javaScriptEnabled: true,
    })

    // Inject anti-detection
    await context.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => false })
      Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] })
      window.chrome = { runtime: {} }
    })

    // Load cookies
    await context.addCookies(cookies)

    const page = await context.newPage()

    // Wrap navigation to track + check for challenges
    const navigate = async (url) => {
      checkSessionLimits()
      sessionNavigations++
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 })
      await humanDelay(2000, 5000) // reading pause
      await checkForChallenge(page)
    }

    // Verify session is valid
    await navigate('https://www.linkedin.com/feed/')
    const currentUrl = page.url()
    if (currentUrl.includes('/login') || currentUrl.includes('/authwall')) {
      throw new Error('LinkedIn cookies expired — session not authenticated')
    }

    // Run callback with tools
    const result = await callback({ page, navigate, humanClick, humanType, humanScroll, humanDelay })

    // Save updated cookies
    const updatedCookies = await context.cookies()
    await saveCookies(updatedCookies)

    return result
  } catch (err) {
    if (err instanceof LinkedInChallengeError) {
      await suspendSession(err.message)
    }
    throw err
  } finally {
    sessionStartedAt = null
    lastSessionEndedAt = Date.now()
    if (context) await context.close().catch(() => {})
    if (browser) await browser.close().catch(() => {})
  }
}

// ─── Navigate Helper (for use inside withBrowser callbacks) ────────────

async function navigateTo(page, url) {
  checkSessionLimits()
  sessionNavigations++
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 })
  await humanDelay(2000, 5000)
  await checkForChallenge(page)
}

// ─── Exports ───────────────────────────────────────────────────────────

module.exports = {
  withBrowser,
  navigateTo,
  humanDelay,
  humanType,
  humanClick,
  humanScroll,
  checkDailyBudget,
  getDailyBudgetUsed,
  getSessionStatus,
  setSessionCookie,
  suspendSession,
  resumeSession,
  LinkedInChallengeError,
  DAILY_BUDGETS,
}
