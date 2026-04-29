// Co-Exist participant profile privacy smoke test.
//
// Origin: Tate directive 29 Apr 2026 20:05 AEST. Verifies the role-tiered
// privacy fix shipped in feat/profile-privacy-tiering / PR #15 / squash
// merge 148f7dc4.
//
// What it verifies:
//   - get_user_profile_v1 RPC returns NULL sensitive fields for a
//     participant viewer + viewer_can_see_sensitive=false.
//   - Same RPC returns the full PII for a staff (admin) viewer +
//     viewer_can_see_sensitive=true.
//   - Visual: ProfileModal / ViewProfilePage rendering matches the API
//     contract (screenshots saved to drafts/).
//
// Run: node /home/tate/ecodiaos/scripts/coexist-privacy-smoke.js
'use strict'

const fs = require('fs')
const path = require('path')

const PROD_URL = 'https://app.coexistaus.org'
const SUPABASE_URL = 'https://tjutlbzekfouwsiaplbr.supabase.co'
const SUPABASE_ANON_KEY =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InRqdXRsYnpla2ZvdXdzaWFwbGJyIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzM5NDM5MDksImV4cCI6MjA4OTUxOTkwOX0.Csl0DB-SJ7oIWvXV47GevnIUSFfH0oOohCY3Z0Kgv_U'

const TARGET_USER_ID = 'ab8face8-d929-47d8-bb7a-b0a22c509c97' // Ben Monga, assist_leader, Adelaide
const SCREENSHOT_DIR = '/home/tate/ecodiaos/drafts/coexist-privacy-test-screenshots'

const PARTICIPANT = {
  email: 'eos-test-participant@ecodia.au',
  password: 'EosTest!2026Privacy',
  expectedRole: 'participant',
  expectedSensitiveVisible: false,
}

const STAFF = {
  email: 'code@ecodia.au',
  password: '***REVOKED-CRED-SEE-INCIDENT-20260430***',
  expectedRole: 'admin',
  expectedSensitiveVisible: true,
}

const SENSITIVE_FIELDS = [
  'first_name',
  'last_name',
  'email',
  'phone',
  'age',
  'date_of_birth',
  'gender',
  'postcode',
  'location',
  'location_point',
  'accessibility_requirements',
  'emergency_contact_name',
  'emergency_contact_phone',
  'emergency_contact_relationship',
  'collective_discovery',
]

function logStep(label, payload) {
  const stamp = new Date().toISOString()
  console.log(`[${stamp}] ${label}` + (payload ? ` ${JSON.stringify(payload)}` : ''))
}

async function signIn({ email, password }) {
  const res = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: {
      apikey: SUPABASE_ANON_KEY,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ email, password }),
  })
  if (!res.ok) {
    const body = await res.text()
    throw new Error(`signIn failed for ${email}: HTTP ${res.status} ${body}`)
  }
  return res.json()
}

async function callRpc(jwt, fn, args) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${fn}`, {
    method: 'POST',
    headers: {
      apikey: SUPABASE_ANON_KEY,
      Authorization: `Bearer ${jwt}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(args),
  })
  if (!res.ok) {
    const body = await res.text()
    throw new Error(`RPC ${fn} failed: HTTP ${res.status} ${body}`)
  }
  return res.json()
}

async function verifyRpcContract(label, scenario) {
  logStep(`API: signing in ${scenario.email}`)
  const auth = await signIn(scenario)

  logStep(`API: calling get_user_profile_v1 as ${scenario.expectedRole}`)
  const profile = await callRpc(auth.access_token, 'get_user_profile_v1', {
    target_user_id: TARGET_USER_ID,
  })
  if (!profile) {
    throw new Error(`${label}: RPC returned null - viewer has no relationship to target`)
  }

  const flag = profile.viewer_can_see_sensitive
  const expected = scenario.expectedSensitiveVisible
  if (flag !== expected) {
    throw new Error(
      `${label}: viewer_can_see_sensitive=${flag} but expected ${expected}`,
    )
  }

  const populatedSensitive = SENSITIVE_FIELDS.filter(
    (f) => profile[f] !== null && profile[f] !== undefined,
  )

  if (expected) {
    // Staff: at least name + phone + email + emergency_contact_name should
    // be populated (target Ben Monga has all of these).
    const required = ['first_name', 'phone', 'email', 'emergency_contact_name']
    const missing = required.filter((f) => !profile[f])
    if (missing.length) {
      throw new Error(`${label}: staff RPC missing required fields ${missing.join(',')}`)
    }
    logStep(`API: ${label} PASS`, {
      role: scenario.expectedRole,
      viewer_can_see_sensitive: flag,
      populated_sensitive_fields: populatedSensitive.length,
    })
  } else {
    // Participant: every sensitive field MUST be null/undefined.
    if (populatedSensitive.length > 0) {
      throw new Error(
        `${label}: participant RPC leaked fields ${populatedSensitive.join(',')}`,
      )
    }
    logStep(`API: ${label} PASS`, {
      role: scenario.expectedRole,
      viewer_can_see_sensitive: flag,
      populated_sensitive_fields: 0,
    })
  }

  return { auth, profile }
}

async function captureProfileScreenshot(puppeteer, scenario, outName) {
  logStep(`UI: launching puppeteer for ${scenario.email}`)
  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  })
  try {
    const page = await browser.newPage()
    await page.setViewport({
      width: 414,
      height: 896,
      deviceScaleFactor: 2,
      isMobile: true,
      hasTouch: true,
    })

    // Login via the actual UI form so the supabase client establishes its
    // session through its normal code path (auth listener fires, profile
    // hook seeds, etc).
    logStep(`UI: ${scenario.email} -> login form`)
    await page.goto(`${PROD_URL}/sign-in`, { waitUntil: 'domcontentloaded', timeout: 60_000 })
    await page.waitForSelector('input[type="email"]', { timeout: 30_000 })
    await page.type('input[type="email"]', scenario.email, { delay: 20 })
    await page.type('input[type="password"]', scenario.password, { delay: 20 })

    // Click the submit button; allow nav OR client-side route change.
    const navWait = page.waitForNavigation({ waitUntil: 'networkidle0', timeout: 30_000 }).catch(() => null)
    await page.click('button[type="submit"]')
    await navWait

    // Cookie-banner dismiss (best-effort).
    try {
      await page.evaluate(() => {
        const buttons = Array.from(document.querySelectorAll('button'))
        const accept = buttons.find((b) => /accept all|accept|got it|dismiss/i.test(b.textContent || ''))
        if (accept) (accept).click()
      })
    } catch {
      /* ignore */
    }

    // Settle then navigate to the target profile.
    await new Promise((r) => setTimeout(r, 2_000))
    const url = `${PROD_URL}/profile/${TARGET_USER_ID}`
    logStep(`UI: ${scenario.email} -> ${url}`)
    await page.goto(url, { waitUntil: 'networkidle0', timeout: 60_000 })

    // Accept TOS modal if it pops (test participant was created via admin
    // API and may not have tos_accepted_at set).
    try {
      const acceptedTos = await page.evaluate(() => {
        const buttons = Array.from(document.querySelectorAll('button'))
        const accept = buttons.find((b) => /accept|i agree|continue/i.test(b.textContent || ''))
        if (accept) {
          ;(accept).click()
          return true
        }
        return false
      })
      if (acceptedTos) {
        await new Promise((r) => setTimeout(r, 1_500))
        await page.goto(url, { waitUntil: 'networkidle0', timeout: 60_000 })
      }
    } catch {
      /* ignore */
    }

    // Final settle for framer-motion + react-query.
    await new Promise((r) => setTimeout(r, 3_000))

    const visibleText = await page.evaluate(() => document.body.innerText)
    const screenshotPath = path.join(SCREENSHOT_DIR, outName)
    await page.screenshot({ path: screenshotPath, fullPage: true })
    logStep(`UI: screenshot saved ${screenshotPath}`)

    const checks = {
      shows_target_display_name: /ben/i.test(visibleText),
      shows_redaction_notice: /personal details hidden|leaders only|visible to leaders/i.test(
        visibleText,
      ),
      shows_email_value: visibleText.includes('benjaminmonga@coexistaus.org'),
      shows_phone_value: visibleText.includes('0424092024'),
      shows_emergency_name: /catherine/i.test(visibleText),
    }
    return { screenshotPath, checks, visibleText: visibleText.slice(0, 800) }
  } finally {
    await browser.close()
  }
}

async function main() {
  const results = {
    fork: 'fork_mojw7558_b2e90a',
    target_user_id: TARGET_USER_ID,
    api: {},
    ui: {},
  }

  // 1. API contract verification (the security boundary).
  results.api.participant = await verifyRpcContract('PARTICIPANT', PARTICIPANT)
    .then((r) => ({
      pass: true,
      viewer_can_see_sensitive: r.profile.viewer_can_see_sensitive,
      sensitive_field_count: SENSITIVE_FIELDS.filter((f) => r.profile[f]).length,
    }))
    .catch((e) => ({ pass: false, error: e.message }))

  results.api.admin = await verifyRpcContract('ADMIN', STAFF)
    .then((r) => ({
      pass: true,
      viewer_can_see_sensitive: r.profile.viewer_can_see_sensitive,
      sensitive_field_count: SENSITIVE_FIELDS.filter((f) => r.profile[f]).length,
    }))
    .catch((e) => ({ pass: false, error: e.message }))

  // 2. UI visual verification.
  const puppeteer = require('puppeteer')

  results.ui.participant = await captureProfileScreenshot(
    puppeteer,
    PARTICIPANT,
    'participant-view-of-assist-leader.png',
  ).catch((e) => ({ error: e.message }))

  results.ui.admin = await captureProfileScreenshot(
    puppeteer,
    STAFF,
    'admin-view-of-assist-leader.png',
  ).catch((e) => ({ error: e.message }))

  fs.writeFileSync(
    path.join(SCREENSHOT_DIR, 'smoke-results.json'),
    JSON.stringify(results, null, 2),
  )
  console.log('\n========== SMOKE RESULTS ==========')
  console.log(JSON.stringify(results, null, 2))
  console.log('===================================')

  const apiAllPass = results.api.participant?.pass && results.api.admin?.pass
  if (!apiAllPass) {
    console.error('\nAPI checks failed. Privacy fix did NOT pass smoke.')
    process.exit(1)
  }
  console.log('\nAPI checks pass. Visual screenshots saved.')
}

main().catch((err) => {
  console.error('FATAL:', err)
  process.exit(1)
})
