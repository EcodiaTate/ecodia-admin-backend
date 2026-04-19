/**
 * OS Heartbeat — keeps the OS Session alive and autonomous while Tate is away.
 *
 * The scheduler poller fires known cron tasks at their scheduled times. This
 * service is different: it wakes the OS periodically with an OPEN-ENDED prompt
 * so it can proactively check state, respond to events, and act on its own
 * judgement — which is what makes it a CEO-class intelligence instead of a
 * cron runner.
 *
 * Cadence is energy-adjusted: full/healthy every 30 min, conserve every 1h,
 * low every 2h, critical every 4h. On Bedrock fallback, pauses entirely to
 * avoid burning AWS $ on speculative wakes.
 *
 * A heartbeat skips if:
 *   - An OS Session turn is currently active (don't interrupt)
 *   - Tate messaged in the last HEARTBEAT_INTERVAL (user activity is signal enough)
 *   - Energy level is critical AND no essential tasks are due (pure conservation)
 *   - Provider is Bedrock (heartbeats cost $$$ on Bedrock, not Max)
 */

const logger = require('../config/logger')
const usageEnergy = require('./usageEnergyService')
const db = require('../config/db')

// ─── Grounded context gathering ─────────────────────────────────────────────
// Pulls concrete signals the OS can act on instead of a pure open prompt.
// Each query is wrapped so one failure never blocks the heartbeat — we return
// whatever succeeded and the prompt notes the rest as "(unavailable)".
async function _gatherHeartbeatContext() {
  const now = Date.now()
  const fourHoursAgo = new Date(now - 4 * 60 * 60 * 1000)
  const twoHoursAgo  = new Date(now - 2 * 60 * 60 * 1000)

  const results = await Promise.allSettled([
    // Pending / urgent emails (triage not complete, recent)
    db`
      SELECT COUNT(*)::int AS n
      FROM email_threads
      WHERE triage_status IN ('pending', 'pending_retry')
        AND triage_priority IN ('urgent', 'high')
    `,
    // All unread / untriaged emails
    db`
      SELECT COUNT(*)::int AS n
      FROM email_threads
      WHERE triage_status = 'pending'
    `,
    // Actions awaiting approval in the queue
    db`
      SELECT COUNT(*)::int AS n, COUNT(*) FILTER (WHERE priority IN ('high','urgent'))::int AS urgent
      FROM action_queue
      WHERE status = 'pending'
    `,
    // Scheduled tasks that failed or are overdue
    db`
      SELECT COUNT(*)::int AS n
      FROM os_scheduled_tasks
      WHERE status = 'active'
        AND next_run_at IS NOT NULL
        AND next_run_at < ${new Date(now - 60 * 60 * 1000)}
    `,
    // Factory sessions still running (spawned but not completed)
    db`
      SELECT COUNT(*)::int AS n
      FROM cc_sessions
      WHERE status = 'running'
        AND started_at > ${new Date(now - 6 * 60 * 60 * 1000)}
    `,
    // Last heartbeat tick — how long since last proactive wake
    db`
      SELECT MAX(created_at) AS last_heartbeat
      FROM cc_session_logs
      WHERE content LIKE '[USER] [HEARTBEAT]%'
    `,
    // Last user (non-heartbeat) message
    db`
      SELECT MAX(created_at) AS last_user
      FROM cc_session_logs
      WHERE content LIKE '[USER]%'
        AND content NOT LIKE '[USER] [HEARTBEAT]%'
        AND content NOT LIKE '[USER] [SCHEDULED:%'
    `,
    // Last-turn breadcrumb — auto-written continuity snapshot
    db`SELECT value FROM kv_store WHERE key = 'session.last_breadcrumb'`,
  ])

  const pick = (idx, fallback = null) => {
    const r = results[idx]
    return r.status === 'fulfilled' ? r.value : fallback
  }

  const urgentEmails  = pick(0)?.[0]?.n ?? null
  const pendingEmails = pick(1)?.[0]?.n ?? null
  const queueRow      = pick(2)?.[0] ?? null
  const overdueCrons  = pick(3)?.[0]?.n ?? null
  const runningFactory = pick(4)?.[0]?.n ?? null
  const lastHeartbeat = pick(5)?.[0]?.last_heartbeat ?? null
  const lastUser      = pick(6)?.[0]?.last_user ?? null
  const breadcrumb    = pick(7)?.[0]?.value ?? null

  return {
    urgentEmails,
    pendingEmails,
    pendingActions: queueRow?.n ?? null,
    urgentActions: queueRow?.urgent ?? null,
    overdueCrons,
    runningFactory,
    lastHeartbeatAgoH: lastHeartbeat ? ((now - new Date(lastHeartbeat).getTime()) / 3_600_000) : null,
    lastUserAgoH:      lastUser      ? ((now - new Date(lastUser).getTime())      / 3_600_000) : null,
    breadcrumb: (breadcrumb && typeof breadcrumb === 'object' && breadcrumb.ts) ? breadcrumb : null,
    timestamp: new Date(now).toISOString(),
    timestampLocal: new Date(now).toLocaleString('en-AU', { timeZone: 'Australia/Brisbane' }),
  }
}

const API_PORT = process.env.PORT || 3001

// Base interval — 30 minutes on healthy energy.
const BASE_INTERVAL_MS = 30 * 60 * 1000

// Minimum gap between heartbeats no matter how high the multiplier goes.
const MIN_INTERVAL_MS = 15 * 60 * 1000

// Maximum gap — critical energy can stretch to 4h but never further.
const MAX_INTERVAL_MS = 4 * 60 * 60 * 1000

let _timeout = null
let _stopped = false
let _lastHeartbeatAt = 0

async function isSessionBusy() {
  try {
    const res = await fetch(`http://127.0.0.1:${API_PORT}/api/os-session/status`, {
      signal: AbortSignal.timeout(5_000),
    })
    const body = await res.json().catch(() => ({}))
    return body.active === true || body.status === 'streaming'
  } catch {
    return false
  }
}

async function lastUserMessageAgoMs() {
  // Look for the most recent [USER] log entry in the current session.
  try {
    const row = await db`
      SELECT created_at FROM cc_session_logs
      WHERE content LIKE '[USER]%'
      ORDER BY created_at DESC
      LIMIT 1
    `
    if (!row.length) return Infinity
    return Date.now() - new Date(row[0].created_at).getTime()
  } catch {
    return Infinity
  }
}

function _fmtNum(v)  { return v == null ? 'unavailable' : String(v) }
function _fmtHours(v) { return v == null ? 'unavailable' : `${v.toFixed(1)}h ago` }

// Build a grounded heartbeat prompt. Data beats asking "what changed?" blind —
// if we pass the OS concrete counters it acts on signal, not hallucination.
function _heartbeatPrompt(ctx) {
  const lines = [
    '[HEARTBEAT] Autonomous check-in — the timer fired, Tate did not send this.',
    '',
    `Local time: ${ctx.timestampLocal}`,
    `Last user message: ${_fmtHours(ctx.lastUserAgoH)}`,
    `Last heartbeat:    ${_fmtHours(ctx.lastHeartbeatAgoH)}`,
    '',
  ]

  // Where-I-left-off breadcrumb. Only included when it carries NEW info:
  //   - reasonably fresh (<12h old), AND
  //   - newer than the last heartbeat (so we're not re-injecting the same
  //     ~300 tokens of context the model already saw on a prior heartbeat).
  // This is the efficiency guardrail — every heartbeat that re-stitches
  // the same breadcrumb is pure waste.
  if (ctx.breadcrumb) {
    const b = ctx.breadcrumb
    const ageMs = Date.now() - b.ts
    const ageMin = Math.round(ageMs / 60000)
    const lastHbMs = ctx.lastHeartbeatAgoH != null ? ctx.lastHeartbeatAgoH * 3_600_000 : Infinity
    const breadcrumbIsNewerThanLastHb = ageMs < lastHbMs
    if (ageMin < 12 * 60 && breadcrumbIsNewerThanLastHb) {
      lines.push(`Where you left off (${ageMin} min ago):`)
      if (b.user_tail)       lines.push(`  Tate last said: ${b.user_tail}`)
      if (b.assistant_tail)  lines.push(`  You last replied: ${b.assistant_tail}`)
      lines.push('')
    }
  }

  lines.push(
    'Current signal:',
    `  • Urgent/high emails pending triage: ${_fmtNum(ctx.urgentEmails)}`,
    `  • All untriaged emails:              ${_fmtNum(ctx.pendingEmails)}`,
    `  • Action queue pending:              ${_fmtNum(ctx.pendingActions)} (${_fmtNum(ctx.urgentActions)} urgent/high)`,
    `  • Overdue scheduled tasks (>1h):     ${_fmtNum(ctx.overdueCrons)}`,
    `  • Factory sessions still running:    ${_fmtNum(ctx.runningFactory)}`,
    '',
    'Decision framework:',
    '  1. If "where you left off" shows mid-task work, CONTINUE that work before starting anything new.',
    '  2. If any counter above is non-zero and actionable — do the highest-leverage item now. No approval needed.',
    '  3. If everything is zero or already handled, reply with a ONE-LINE "nothing pressing" and end. Do NOT invent work — conserving quota is a valid outcome.',
    '  4. If Tate last messaged >24h ago, briefly (one line) scan Gmail / Calendar / Actions MCP for anything new that the counters above might not reflect.',
    '',
    'You are the CEO. Act.',
  )
  return lines.join('\n')
}

async function _tick() {
  if (_stopped) return
  try {
    // 1. Skip if a turn is already in flight.
    if (await isSessionBusy()) {
      logger.debug('Heartbeat: session busy, skipping tick')
      return
    }

    // 2. Skip if Tate just messaged recently — his messages are the wake signal.
    const ago = await lastUserMessageAgoMs()
    if (ago < BASE_INTERVAL_MS) {
      logger.debug('Heartbeat: recent user activity, skipping', { agoMs: ago })
      return
    }

    // 3. Energy gate — skip entirely on Bedrock (cost) or critical (pure conservation).
    let energy = null
    try { energy = await usageEnergy.getEnergy() } catch {}
    if (energy?.isBedrockFallback) {
      logger.info('Heartbeat: on Bedrock fallback, skipping to avoid AWS burn')
      return
    }
    if (energy?.level === 'critical') {
      logger.info('Heartbeat: critical energy, skipping speculative wake')
      return
    }

    // 4. Gather grounded context BEFORE firing — concrete counters, not
    //    open-ended "what changed?". Costs 7 fast parallel DB queries.
    const ctx = await _gatherHeartbeatContext()

    // 5. Smart skip: if every actionable counter is zero AND user messaged
    //    within the last hour, the heartbeat is noise. Don't burn a turn
    //    just to have the model say "nothing pressing". When things are
    //    quiet let them stay quiet.
    const totalSignal = (ctx.urgentEmails || 0) + (ctx.pendingActions || 0) +
                        (ctx.overdueCrons || 0) + (ctx.runningFactory || 0)
    const recentUserH = ctx.lastUserAgoH ?? Infinity
    if (totalSignal === 0 && recentUserH < 1) {
      logger.info('Heartbeat: no signal + recent user activity, skipping quota burn', { recentUserH })
      return
    }

    // 6. Fire the heartbeat. Use suppressOutput=false so the frontend sees it too
    //    (lets Tate verify the system is alive when he checks in from Africa).
    logger.info('Heartbeat: firing OS wake', {
      energyLevel: energy?.level,
      provider: energy?.currentProvider,
      signal: { urgentEmails: ctx.urgentEmails, pendingActions: ctx.pendingActions, overdueCrons: ctx.overdueCrons, runningFactory: ctx.runningFactory },
    })
    _lastHeartbeatAt = Date.now()
    const res = await fetch(`http://127.0.0.1:${API_PORT}/api/os-session/message`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: _heartbeatPrompt(ctx) }),
      signal: AbortSignal.timeout(30 * 60 * 1000),  // 30 min cap per heartbeat
    })
    const body = await res.json().catch(() => ({}))
    logger.info('Heartbeat: complete', { code: body.code, textLen: body.text?.length || 0 })
  } catch (err) {
    logger.warn('Heartbeat: tick failed', { error: err.message })
  }
}

async function _scheduleNext() {
  if (_stopped) return
  let multiplier = 1.0
  try {
    const energy = await usageEnergy.getEnergy()
    multiplier = energy?.scheduleMultiplier || 1.0
  } catch {}
  const raw = Math.round(BASE_INTERVAL_MS / multiplier)
  const delay = Math.max(MIN_INTERVAL_MS, Math.min(MAX_INTERVAL_MS, raw))
  _timeout = setTimeout(async () => {
    try { await _tick() } catch (err) { logger.warn('Heartbeat: _tick crashed', { error: err.message }) }
    _scheduleNext()
  }, delay)
  if (typeof _timeout.unref === 'function') _timeout.unref()
}

function start() {
  if (_timeout) return
  _stopped = false
  // First heartbeat 2 min after boot — long enough for the API + MCP servers
  // to settle, short enough that restart-during-outage recovers quickly.
  _timeout = setTimeout(async () => {
    try { await _tick() } catch (err) { logger.warn('Heartbeat: initial tick crashed', { error: err.message }) }
    _scheduleNext()
  }, 2 * 60 * 1000)
  if (typeof _timeout.unref === 'function') _timeout.unref()
  logger.info('OS Heartbeat service started (first tick in 2min, cadence is energy-adjusted)')
}

function stop() {
  _stopped = true
  if (_timeout) {
    clearTimeout(_timeout)
    _timeout = null
    logger.info('OS Heartbeat service stopped')
  }
}

function getStatus() {
  return {
    running: !!_timeout && !_stopped,
    lastHeartbeatAt: _lastHeartbeatAt || null,
    ageMs: _lastHeartbeatAt ? Date.now() - _lastHeartbeatAt : null,
  }
}

module.exports = { start, stop, getStatus }
