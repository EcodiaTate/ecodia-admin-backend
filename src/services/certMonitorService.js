/**
 * TLS Certificate Monitor — alerts before the production cert expires.
 *
 * Reason it exists: the VPS uses Let's Encrypt with certbot autorenew.
 * When that renewal fails (rate limits, DNS issues, certbot bug), the
 * cert silently expires 90 days later — the frontend gets an opaque
 * network error with no in-app signal. Tate in Africa would never know
 * until he tried to log in.
 *
 * How it works: once per hour, open a TLS connection to API_BASE_URL
 * and read the peer certificate's validTo. If <14 days remain, email
 * Tate. If <3 days remain, the alert cooldown is bypassed so every
 * check fires (that's "you have 72h to SSH in and fix this").
 */

const tls = require('tls')
const { URL } = require('url')
const logger = require('../config/logger')
const db = require('../config/db')

const CHECK_INTERVAL_MS = 60 * 60 * 1000  // 1h
const WARN_DAYS = 14
const URGENT_DAYS = 3

let _timeout = null
let _stopped = false
let _lastCheckedAt = null
let _lastDaysRemaining = null

function _parseHost(rawUrl) {
  try {
    const u = new URL(rawUrl)
    if (u.protocol !== 'https:') return null
    return { host: u.hostname, port: Number(u.port) || 443 }
  } catch { return null }
}

function _getCertExpiry({ host, port }) {
  return new Promise((resolve, reject) => {
    const socket = tls.connect({ host, port, servername: host, rejectUnauthorized: false }, () => {
      const cert = socket.getPeerCertificate()
      socket.end()
      if (!cert || !cert.valid_to) return reject(new Error('no peer cert returned'))
      resolve(new Date(cert.valid_to))
    })
    socket.setTimeout(10_000, () => {
      socket.destroy()
      reject(new Error('tls handshake timeout'))
    })
    socket.on('error', reject)
  })
}

async function _firedRecently(key, cooldownMs) {
  try {
    const rows = await db`SELECT value FROM kv_store WHERE key = ${key}`
    const v = rows?.[0]?.value
    const ts = (v && typeof v === 'object' && Number.isFinite(v.ts)) ? v.ts : 0
    return (Date.now() - ts) < cooldownMs
  } catch { return false }
}

async function _recordFired(key) {
  try {
    await db`
      INSERT INTO kv_store (key, value) VALUES (${key}, ${{ ts: Date.now() }})
      ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()
    `
  } catch (err) {
    logger.warn('cert monitor: failed to record alert', { error: err.message })
  }
}

async function checkOnce() {
  const target = _parseHost(process.env.API_BASE_URL || 'https://api.admin.ecodia.au')
  if (!target) {
    logger.debug('cert monitor: API_BASE_URL is not https, skipping check')
    return
  }
  try {
    const validTo = await _getCertExpiry(target)
    const daysRemaining = Math.max(0, Math.round((validTo.getTime() - Date.now()) / 86_400_000))
    _lastCheckedAt = Date.now()
    _lastDaysRemaining = daysRemaining
    logger.info('cert monitor check', { host: target.host, daysRemaining, validTo: validTo.toISOString() })

    if (daysRemaining <= URGENT_DAYS) {
      // Urgent — bypass cooldown and alert every tick. Tate needs to know NOW.
      await _alert({
        subject: `URGENT: TLS cert expires in ${daysRemaining} day(s) — ${target.host}`,
        body: `The Let's Encrypt certificate for ${target.host} expires in ${daysRemaining} day(s) (${validTo.toISOString()}).

certbot autorenew may be failing. SSH into the VPS and run:
  sudo certbot renew --dry-run

If that fails, the cert will expire and the frontend will go dark with no in-app error.`,
      })
    } else if (daysRemaining <= WARN_DAYS) {
      // Warn once per 3 days to avoid nagging while still being loud enough.
      const cooldown = 3 * 24 * 60 * 60 * 1000
      if (!(await _firedRecently('cert_monitor:warn', cooldown))) {
        await _alert({
          subject: `TLS cert renews in ${daysRemaining} day(s) — ${target.host}`,
          body: `Heads-up: ${target.host} cert expires in ${daysRemaining} days (${validTo.toISOString()}). Confirm certbot autorenew is healthy:
  ssh tate@170.64.170.191 "sudo systemctl list-timers certbot"
  ssh tate@170.64.170.191 "sudo certbot renew --dry-run"`,
        })
        await _recordFired('cert_monitor:warn')
      }
    }
  } catch (err) {
    // Can't read cert at all — alert, but with a longer cooldown since this
    // could also just be a transient network blip.
    logger.warn('cert monitor: check failed', { host: target.host, error: err.message })
    const cooldown = 6 * 60 * 60 * 1000
    if (!(await _firedRecently('cert_monitor:unreachable', cooldown))) {
      await _alert({
        subject: `TLS cert check unreachable — ${target.host}`,
        body: `Couldn't read the TLS certificate for ${target.host}: ${err.message}\n\nLikely transient but worth a glance if it repeats.`,
      }).catch(() => {})
      await _recordFired('cert_monitor:unreachable')
    }
  }
}

async function _alert({ subject, body }) {
  try {
    const gmail = require('./gmailService')
    const to = process.env.ALERT_EMAIL_TO || 'code@ecodia.au'
    await gmail.sendNewEmail(null, to, `[EcodiaOS] ${subject}`, body)
    logger.info('cert monitor: alert sent', { subject, to })
  } catch (err) {
    logger.error('cert monitor: alert send failed', { error: err.message })
  }
}

function _scheduleNext() {
  if (_stopped) return
  _timeout = setTimeout(async () => {
    try { await checkOnce() } catch (err) { logger.warn('cert monitor: tick crashed', { error: err.message }) }
    _scheduleNext()
  }, CHECK_INTERVAL_MS)
  if (typeof _timeout.unref === 'function') _timeout.unref()
}

function start() {
  if (_timeout) return
  _stopped = false
  // First check 30s after boot (not immediately — let the rest of the
  // system stabilize first). Then hourly.
  _timeout = setTimeout(async () => {
    try { await checkOnce() } catch (err) { logger.warn('cert monitor: initial tick crashed', { error: err.message }) }
    _scheduleNext()
  }, 30_000)
  if (typeof _timeout.unref === 'function') _timeout.unref()
  logger.info('TLS cert monitor started (hourly)')
}

function stop() {
  _stopped = true
  if (_timeout) { clearTimeout(_timeout); _timeout = null }
}

function getStatus() {
  return {
    running: !!_timeout && !_stopped,
    lastCheckedAt: _lastCheckedAt,
    lastDaysRemaining: _lastDaysRemaining,
  }
}

module.exports = { start, stop, checkOnce, getStatus }
