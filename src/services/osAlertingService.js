/**
 * OS Alerting — ONE way for the OS to reach Tate when he's in Africa.
 *
 * Fires email + SMS (for urgent alerts) when the OS hits states that need
 * human awareness but aren't crash-severe:
 *   - Bedrock fallback triggered (cost spike risk)
 *   - Weekly quota above 90% (heading into critical)
 *   - 3+ consecutive failed turns (systemic issue)
 *   - Process crash recovered (pm2 restarted us)
 *   - Daily digest — "I'm alive, here's what I did"
 *
 * Dedup-aware: each alert has a cooldown so we don't spam the inbox when a
 * state flaps. Cooldowns persist across pm2 restarts via kv_store.
 *
 * All alerts go FROM code@ecodia.au TO ALERT_EMAIL_TO (default: tate@ecodia.au).
 * If gmail is disabled or sending fails, we log loudly but never throw —
 * alerts must never break the caller's path.
 */

const logger = require('../config/logger')
const db = require('../config/db')

const ALERT_TO = process.env.ALERT_EMAIL_TO || 'tate@ecodia.au'

// Per-alert cooldowns in ms. After firing, same alert type blocked until elapsed.
const COOLDOWNS = {
  bedrock_fallback:    24 * 60 * 60 * 1000,  // once per day
  quota_high:          12 * 60 * 60 * 1000,  // twice per day max
  consecutive_failures: 4 * 60 * 60 * 1000,  // every 4h
  process_restart:     15 * 60 * 1000,       // every 15 min (flapping = crash loop, worth noisy)
  daily_digest:        20 * 60 * 60 * 1000,  // once per ~day
}

// kv_store.value is TEXT — we serialise JSON ourselves.
// New rows store JSON.stringify({ts: <ms>, type: <alertType>}).
// Legacy rows may contain a bare numeric string ("1776634957262").
// Broken rows contain "[object Object]" (old bug) — parse fails → Infinity → fires once, self-heals.
async function _getCooldownMs(alertType) {
  try {
    const row = await db`SELECT value FROM kv_store WHERE key = ${`alert_last:${alertType}`}`
    if (!row.length) return Infinity
    const v = row[0].value
    let lastAt = Infinity
    if (typeof v === 'string') {
      try {
        const parsed = JSON.parse(v)
        if (parsed && typeof parsed === 'object' && Number.isFinite(parsed.ts)) {
          lastAt = parsed.ts
        } else if (Number.isFinite(Number(parsed))) {
          lastAt = Number(parsed)
        }
      } catch {
        // Not JSON — try as bare number (legacy bedrock_fallback rows)
        const n = Number(v)
        if (Number.isFinite(n)) lastAt = n
      }
    } else if (typeof v === 'object' && v !== null && Number.isFinite(v.ts)) {
      // Driver returned parsed object despite TEXT column — handle gracefully
      lastAt = v.ts
    }
    if (!Number.isFinite(lastAt)) return Infinity
    return Date.now() - lastAt
  } catch {
    return Infinity  // err on side of letting the alert through
  }
}

async function _markFired(alertType) {
  try {
    // kv_store.value is TEXT — must JSON.stringify ourselves.
    const payload = JSON.stringify({ ts: Date.now(), type: alertType })
    await db`
      INSERT INTO kv_store (key, value)
      VALUES (${`alert_last:${alertType}`}, ${payload})
      ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()
    `
  } catch (err) {
    logger.warn('alerting: failed to record cooldown', { alertType, error: err.message })
  }
}

async function _sendSms(body) {
  const sid = process.env.TWILIO_ACCOUNT_SID
  const token = process.env.TWILIO_AUTH_TOKEN
  const from = (process.env.TWILIO_FROM_NUMBER || '').trim()
  const to = process.env.TATE_MOBILE
  if (!sid || !token || !from || !to) {
    logger.warn('alerting: SMS env not configured, skipping SMS')
    return false
  }
  try {
    const auth = Buffer.from(`${sid}:${token}`).toString('base64')
    const params = new URLSearchParams({ From: from, To: to, Body: body.slice(0, 1500) })
    const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
      method: 'POST',
      headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString(),
    })
    if (!res.ok) {
      const text = await res.text()
      logger.error('alerting: Twilio SMS failed', { status: res.status, body: text.slice(0, 200) })
      return false
    }
    return true
  } catch (err) {
    logger.error('alerting: SMS send threw', { error: err.message })
    return false
  }
}

const SMS_ALERT_TYPES = new Set(['consecutive_failures', 'process_restart', 'bedrock_fallback'])

async function _send(subject, body) {
  try {
    const gmail = require('./gmailService')
    // sendNewEmail signature: (inbox, to, subject, body). Send FROM code@ (OS inbox) TO tate@.
    await gmail.sendNewEmail('code@ecodia.au', ALERT_TO, `[EcodiaOS] ${subject}`, body)
    logger.info('Alert sent', { subject, to: ALERT_TO })
    return true
  } catch (err) {
    logger.error('Alert send FAILED', { subject, error: err.message })
    return false
  }
}

async function _fire(alertType, subject, body) {
  const cooldown = COOLDOWNS[alertType]
  if (!cooldown) {
    logger.warn('alerting: unknown alertType, firing anyway', { alertType })
  } else {
    const ago = await _getCooldownMs(alertType)
    if (ago < cooldown) {
      logger.debug('alerting: suppressed by cooldown', { alertType, agoMs: ago, cooldownMs: cooldown })
      return false
    }
  }
  // SMS first for urgent alert types — so Tate gets it even if email fails
  if (SMS_ALERT_TYPES.has(alertType)) {
    const smsBody = `[EcodiaOS] ${subject}\n${body.split('\n')[0]}`
    _sendSms(smsBody).catch(() => {})
  }
  const ok = await _send(subject, body)
  if (ok) {
    await _markFired(alertType)
    // Log the outgoing alert so the OS can see what Tate has been notified
    // about without scraping its own email inbox.
    try {
      require('./osIncidentService').log({
        kind: 'alert_fired',
        severity: 'info',
        component: alertType,
        message: subject,
        context: { alertType },
      })
    } catch {}
  }
  return ok
}

// ─── Public alert trigger functions ─────────────────────────────────────────

async function alertBedrockFallback(reason) {
  return _fire(
    'bedrock_fallback',
    'Bedrock fallback triggered',
    `The OS has switched to AWS Bedrock — both Claude Max accounts are exhausted or unavailable.

Reason: ${reason || '(unspecified)'}
Time: ${new Date().toISOString()}

Cost implication: Bedrock bills per-token against your AWS account, not Claude Max.
Action: check weekly quota reset timing. Auto-return to Max is enabled — should
switch back within 1h of reset. If it doesn't, investigate the quota-check path.`
  )
}

async function alertQuotaHigh(account, pctUsed, resetsAt) {
  const pctStr = `${Math.round(pctUsed * 100)}%`
  const resetStr = resetsAt ? new Date(resetsAt * 1000).toISOString() : 'unknown'
  return _fire(
    'quota_high',
    `Claude Max quota ${pctStr} (${account})`,
    `Account: ${account}
Weekly utilization: ${pctStr}
Resets at: ${resetStr}

Approaching critical. The system will auto-throttle schedules and may switch to
Bedrock if it goes over 99%. No action needed unless cadence of usage is abnormal.`
  )
}

async function alertConsecutiveFailures(count, lastError) {
  return _fire(
    'consecutive_failures',
    `${count} consecutive OS turn failures`,
    `The OS Session has failed ${count} turns in a row.

Last error: ${lastError || '(none captured)'}
Time: ${new Date().toISOString()}

This usually indicates: quota exhaustion, MCP server down, or a systemic SDK issue.
Check pm2 logs for the full error trace. If it clears within the next hour, no action.`
  )
}

async function alertProcessRestart(uptimeMs) {
  const minutes = Math.round(uptimeMs / 60000)
  return _fire(
    'process_restart',
    `ecodia-api restarted (uptime was ${minutes}m)`,
    `The ecodia-api process restarted — pm2 brought it back up.

Previous uptime: ${minutes} minutes
Time: ${new Date().toISOString()}

Short uptime (<10m) usually means a crash loop. Longer uptime is a normal
memory-restart or manual kick. Check pm2 logs 50 lines back for the exit reason.`
  )
}

async function sendDailyDigest({ turns24h, energyPct, provider, bedrockHours, crashCount, scheduledTasksFired }) {
  return _fire(
    'daily_digest',
    `Daily digest — ${new Date().toISOString().slice(0, 10)}`,
    `EcodiaOS 24h summary

Turns: ${turns24h || 0}
Energy: ${Math.round((energyPct || 0) * 100)}% used this week
Provider: ${provider || 'unknown'}
Bedrock hours: ${bedrockHours?.toFixed?.(1) || 0}
Crashes: ${crashCount || 0}
Scheduled tasks fired: ${scheduledTasksFired || 0}

System is alive. No action needed if numbers look sane.`
  )
}

module.exports = {
  alertBedrockFallback,
  alertQuotaHigh,
  alertConsecutiveFailures,
  alertProcessRestart,
  sendDailyDigest,
}
