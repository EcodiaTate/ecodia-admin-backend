const crypto = require('crypto')
const logger = require('../config/logger')
const { getRedisClient } = require('../config/redis')

// ═══════════════════════════════════════════════════════════════════════
// HANDS BRIDGE — talks to laptop-hands over Tailscale.
//
// Hands is the laptop-resident sibling of the factory: a Claude Agent SDK
// service that listens on the user's tailnet IP and runs agentic work with
// full local tool access (shell, files, apps, browser, computer-use).
//
// Direction:
//   ecodia-api → hands : POST  /run                        (HMAC outbound)
//   hands → ecodia-api : POST  /api/hands/events           (HMAC inbound)
//
// Inbound hands events get republished onto the existing factory:ws:broadcast
// channel so they surface in the admin.ecodia.au cortex chat the same way
// factory events do — single narration surface for the user.
// ═══════════════════════════════════════════════════════════════════════

const HANDS_URL = process.env.HANDS_URL                 // e.g. http://100.114.219.69:7800
const HANDS_SECRET = process.env.HANDS_SHARED_SECRET    // matches HANDS_SHARED_SECRET on the laptop
const HANDS_DEFAULT_TIMEOUT_MS = Number(process.env.HANDS_DEFAULT_TIMEOUT_MS || 30 * 60 * 1000)

function _signOutbound(body) {
  const ts = String(Date.now())
  const sig = crypto.createHmac('sha256', HANDS_SECRET).update(`${ts}.${body}`).digest('hex')
  return { ts, sig }
}

function verifyInbound(rawBody, headerTs, headerSig) {
  if (!headerTs || !headerSig) return false
  const tsNum = Number(headerTs)
  if (!Number.isFinite(tsNum) || Math.abs(Date.now() - tsNum) > 60_000) return false
  const expected = crypto.createHmac('sha256', HANDS_SECRET).update(`${headerTs}.${rawBody}`).digest()
  let got
  try { got = Buffer.from(headerSig, 'hex') } catch { return false }
  if (expected.length !== got.length) return false
  return crypto.timingSafeEqual(expected, got)
}

// ─── Outbound: dispatch a run to hands ────────────────────────────────

async function dispatchRun({ sessionId, prompt, systemPrompt, workingDir, maxTurns, tools }) {
  if (!HANDS_URL || !HANDS_SECRET) {
    throw new Error('handsBridge: HANDS_URL and HANDS_SHARED_SECRET must be set')
  }
  const body = JSON.stringify({ sessionId, prompt, systemPrompt, workingDir, maxTurns, tools })
  const { ts, sig } = _signOutbound(body)

  const res = await fetch(`${HANDS_URL}/run`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-hands-timestamp': ts,
      'x-hands-auth': sig,
    },
    body,
    signal: AbortSignal.timeout(15_000),
  })

  const text = await res.text()
  if (!res.ok) {
    logger.warn('handsBridge.dispatchRun: hands rejected', { status: res.status, text })
    throw new Error(`hands /run failed: ${res.status} ${text}`)
  }
  let json
  try { json = JSON.parse(text) } catch { json = { raw: text } }
  return json   // { ok, sessionId, streamUrl }
}

// ─── Inbound: hands posts events back here ────────────────────────────

function handleHandsEvent(event) {
  const { sessionId, kind, message, data, ts } = event
  logger.info('hands_event', { sessionId, kind, message: (message || '').slice(0, 200), ts })

  const redis = getRedisClient()
  if (redis) {
    redis.publish('factory:ws:broadcast', JSON.stringify({
      kind: 'hands_event',
      sessionId,
      payload: { kind, message, data: data || {} },
    }))
  }
}

// ─── Health ───────────────────────────────────────────────────────────

async function ping() {
  if (!HANDS_URL) return { ok: false, error: 'HANDS_URL unset' }
  try {
    const res = await fetch(`${HANDS_URL}/healthz`, { signal: AbortSignal.timeout(3000) })
    return { ok: res.ok, status: res.status }
  } catch (err) {
    return { ok: false, error: err.message }
  }
}

module.exports = {
  dispatchRun,
  verifyInbound,
  handleHandsEvent,
  ping,
  _internal: { HANDS_DEFAULT_TIMEOUT_MS },
}
