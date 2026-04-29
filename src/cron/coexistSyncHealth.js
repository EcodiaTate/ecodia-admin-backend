#!/usr/bin/env node
'use strict'

// =========================================================================
// COEXIST SYNC HEALTH MONITOR -- daily cron
//
// Probes Co-Exist Postgres `excel_sync_runs` table via Supabase REST and
// surfaces three health-failure conditions to status_board (P2):
//
//   (a) DARK      max(run_at) is more than 90min ago AND now is in the
//                 06-22 AEST active window (the sync schedule's window).
//   (b) WEAK-DEDUP   the last run had to_excel_weak_dedup_warning_count > 0.
//   (c) ERROR-SURGE  combined error_count of the last 3 runs exceeds 2x
//                    the rolling-7d average (per-run) by run-count factor 3.
//
// Status-board inserts are idempotent: a duplicate alert (same name) within
// the last 6h is suppressed.
//
// Doctrine references (applied):
//   ~/ecodiaos/patterns/re-probe-stale-health-check-readings-before-acting-on-cached-alerts.md
//   ~/ecodiaos/patterns/distributed-state-seam-failures-are-the-core-infrastructure-risk.md
//   ~/ecodiaos/patterns/verify-deployed-state-against-narrated-state.md
//
// Fork origin: fork_mok9nfhn_db5d7c (Meta-fork Brief 5).
//
// Schema reference: ~/workspaces/coexist/supabase/migrations/20260429000000_excel_sync_runs.sql
//
// Usage:
//   node src/cron/coexistSyncHealth.js              # live run, write alerts
//   node src/cron/coexistSyncHealth.js --once       # alias
//   node src/cron/coexistSyncHealth.js --dry-run    # probe + decide, no writes
//   node src/cron/coexistSyncHealth.js --fixture    # use synthetic dataset
// =========================================================================

require('../config/env')

// -- Constants --------------------------------------------------------------

const DARK_WINDOW_MIN = 90       // dark threshold: minutes since last run
const ACTIVE_HOUR_START_AEST = 6  // 06:00 AEST (inclusive)
const ACTIVE_HOUR_END_AEST = 22   // 22:00 AEST (inclusive)
const ERROR_SURGE_RECENT_N = 3
const ERROR_SURGE_FACTOR = 2      // recent_3 > 2x avg-per-run x 3 runs
const ALERT_DEDUP_HOURS = 6
const REST_TIMEOUT_MS = 15000

// -- kv_store helpers -------------------------------------------------------

async function loadCoexistCreds(db) {
  const rows = await db`SELECT value FROM kv_store WHERE key = 'creds.coexist_supabase'`
  if (!rows.length) throw new Error('creds.coexist_supabase missing from kv_store')
  const v = rows[0].value
  const obj = typeof v === 'string' ? JSON.parse(v) : v
  if (!obj || !obj.url || !obj.service_role_key) {
    throw new Error('creds.coexist_supabase missing url or service_role_key')
  }
  return { url: obj.url.replace(/\/+$/, ''), serviceRoleKey: obj.service_role_key }
}

// -- Co-Exist REST probes ---------------------------------------------------

async function restGet(creds, path) {
  const url = `${creds.url}/rest/v1/${path}`
  const ctl = new AbortController()
  const t = setTimeout(() => ctl.abort(), REST_TIMEOUT_MS)
  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: {
        apikey: creds.serviceRoleKey,
        Authorization: `Bearer ${creds.serviceRoleKey}`,
        Accept: 'application/json',
      },
      signal: ctl.signal,
    })
    if (!res.ok) {
      const body = await res.text().catch(() => '')
      throw new Error(`REST ${res.status} on ${path} - ${body.slice(0, 200)}`)
    }
    return await res.json()
  } finally {
    clearTimeout(t)
  }
}

// Returns an object with the inputs needed to evaluate the three triggers.
async function probeRuns(creds) {
  // Last run (any direction) - for DARK and WEAK-DEDUP
  const lastRows = await restGet(
    creds,
    'excel_sync_runs?select=run_at,direction,to_excel_weak_dedup_warning_count,from_excel_error_count,to_excel_error_count&order=run_at.desc&limit=1'
  )

  // Last 3 runs - for ERROR-SURGE numerator
  const recentRows = await restGet(
    creds,
    `excel_sync_runs?select=run_at,from_excel_error_count,to_excel_error_count&order=run_at.desc&limit=${ERROR_SURGE_RECENT_N}`
  )

  // Last 7d for ERROR-SURGE denominator (avg per-run error_count over 7d window)
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString()
  const sevenDayRows = await restGet(
    creds,
    `excel_sync_runs?select=from_excel_error_count,to_excel_error_count&run_at=gte.${encodeURIComponent(sevenDaysAgo)}`
  )

  return { lastRows, recentRows, sevenDayRows }
}

// -- Trigger evaluation -----------------------------------------------------

// Return the AEST hour [0-23] for a given Date instance.
// AEST is UTC+10, no DST observed for our purposes (Sunshine Coast, QLD).
function aestHour(d) {
  // toLocaleString is the supported way; QLD is fixed UTC+10.
  return parseInt(
    d.toLocaleString('en-AU', { hour: '2-digit', hour12: false, timeZone: 'Australia/Brisbane' }),
    10
  )
}

function evalDark({ lastRows }, now = new Date()) {
  if (!lastRows.length) {
    // No runs at all - definitionally dark, but only alert if we are in the
    // active window (else we don't expect a run anyway).
    const h = aestHour(now)
    if (h >= ACTIVE_HOUR_START_AEST && h <= ACTIVE_HOUR_END_AEST) {
      return {
        triggered: true,
        details: 'No runs in excel_sync_runs at all (ever).',
        last_run_at: null,
        minutes_dark: null,
      }
    }
    return { triggered: false, details: 'No runs but outside active window', last_run_at: null }
  }

  const lastAt = new Date(lastRows[0].run_at)
  const minutesSince = Math.floor((now.getTime() - lastAt.getTime()) / 60000)
  const h = aestHour(now)
  const inActive = h >= ACTIVE_HOUR_START_AEST && h <= ACTIVE_HOUR_END_AEST

  if (minutesSince > DARK_WINDOW_MIN && inActive) {
    return {
      triggered: true,
      details: `Last run ${minutesSince}min ago (${lastAt.toISOString()}); threshold ${DARK_WINDOW_MIN}min; current AEST hour ${h} in active window`,
      last_run_at: lastAt.toISOString(),
      minutes_dark: minutesSince,
    }
  }
  return {
    triggered: false,
    details: `Last run ${minutesSince}min ago; in_active_window=${inActive}`,
    last_run_at: lastAt.toISOString(),
    minutes_dark: minutesSince,
  }
}

function evalWeakDedup({ lastRows }) {
  if (!lastRows.length) {
    return { triggered: false, details: 'No runs to evaluate' }
  }
  const last = lastRows[0]
  const wd = last.to_excel_weak_dedup_warning_count
  if (typeof wd === 'number' && wd > 0) {
    return {
      triggered: true,
      details: `Last run (direction=${last.direction}, run_at=${last.run_at}) had to_excel_weak_dedup_warning_count=${wd}`,
      last_run_at: last.run_at,
      weak_dedup_count: wd,
    }
  }
  return {
    triggered: false,
    details: `Last run weak_dedup=${wd === null ? 'null' : wd}`,
    last_run_at: last.run_at,
  }
}

function sumErr(row) {
  const a = typeof row.from_excel_error_count === 'number' ? row.from_excel_error_count : 0
  const b = typeof row.to_excel_error_count === 'number' ? row.to_excel_error_count : 0
  return a + b
}

function evalErrorSurge({ recentRows, sevenDayRows }) {
  if (recentRows.length < ERROR_SURGE_RECENT_N) {
    return {
      triggered: false,
      details: `Only ${recentRows.length} recent runs (need ${ERROR_SURGE_RECENT_N})`,
    }
  }
  if (sevenDayRows.length === 0) {
    return { triggered: false, details: 'No 7d baseline rows' }
  }
  const recentSum = recentRows.reduce((s, r) => s + sumErr(r), 0)
  const sevenSum = sevenDayRows.reduce((s, r) => s + sumErr(r), 0)
  const sevenAvgPerRun = sevenSum / sevenDayRows.length
  const threshold = sevenAvgPerRun * ERROR_SURGE_FACTOR * ERROR_SURGE_RECENT_N

  // Guard against zero-baseline trivial trips: require recent_sum >= 3.
  const triggered = recentSum > threshold && recentSum >= 3
  return {
    triggered,
    details: `recent_${ERROR_SURGE_RECENT_N}_sum=${recentSum} vs threshold=${threshold.toFixed(2)} (7d_avg_per_run=${sevenAvgPerRun.toFixed(2)} x ${ERROR_SURGE_FACTOR} x ${ERROR_SURGE_RECENT_N})`,
    recent_sum: recentSum,
    seven_day_avg_per_run: sevenAvgPerRun,
    threshold,
  }
}

// -- Status-board write (idempotent 6h dedup) -------------------------------

async function maybeWriteAlert(db, name, status, nextAction) {
  // Dedup: if a row with this exact name was last_touched within the dedup
  // window AND is still active, skip.
  const existing = await db`
    SELECT id, last_touched
    FROM status_board
    WHERE name = ${name}
      AND archived_at IS NULL
      AND last_touched > NOW() - (${ALERT_DEDUP_HOURS} || ' hours')::interval
    ORDER BY last_touched DESC
    LIMIT 1
  `
  if (existing.length > 0) {
    return { wrote: false, reason: 'dedup', existing_id: existing[0].id }
  }

  const inserted = await db`
    INSERT INTO status_board (
      entity_type, name, status,
      next_action, next_action_by, priority,
      context, last_touched
    ) VALUES (
      'infrastructure', ${name}, ${status},
      ${nextAction}, 'ecodiaos', 2,
      ${'Auto-surfaced by coexist-sync-health cron'},
      NOW()
    )
    RETURNING id
  `
  return { wrote: true, id: inserted[0].id }
}

// -- Fixture (used only by --fixture flag, for trigger-path verification) ---

const FIXTURE = (() => {
  const recentTs = new Date(Date.now() - 30 * 60 * 1000).toISOString()
  return {
    lastRows: [
      {
        run_at: recentTs,
        direction: 'to-excel',
        to_excel_weak_dedup_warning_count: 5,
        from_excel_error_count: 2,
        to_excel_error_count: 3,
      },
    ],
    recentRows: [
      { run_at: recentTs, from_excel_error_count: 2, to_excel_error_count: 3 },
      { run_at: new Date(Date.now() - 90 * 60 * 1000).toISOString(), from_excel_error_count: 1, to_excel_error_count: 4 },
      { run_at: new Date(Date.now() - 150 * 60 * 1000).toISOString(), from_excel_error_count: 0, to_excel_error_count: 2 },
    ],
    sevenDayRows: [
      { from_excel_error_count: 0, to_excel_error_count: 0 },
      { from_excel_error_count: 0, to_excel_error_count: 1 },
      { from_excel_error_count: 0, to_excel_error_count: 0 },
      { from_excel_error_count: 0, to_excel_error_count: 0 },
      { from_excel_error_count: 1, to_excel_error_count: 0 },
    ],
  }
})()

// -- Main -------------------------------------------------------------------

async function runCoexistSyncHealth({ dryRun = false, fixture = false } = {}) {
  const db = require('../config/db')
  const logger = require('../config/logger')

  let probe
  if (fixture) {
    logger.info('coexistSyncHealth: --fixture mode (synthetic dataset)')
    probe = FIXTURE
  } else {
    const creds = await loadCoexistCreds(db)
    logger.info(`coexistSyncHealth: probing ${creds.url}/rest/v1/excel_sync_runs`)
    probe = await probeRuns(creds)
    logger.info(`coexistSyncHealth: probe ok (last=${probe.lastRows.length}, recent=${probe.recentRows.length}, 7d=${probe.sevenDayRows.length})`)
  }

  const dark = evalDark(probe)
  const weak = evalWeakDedup(probe)
  const surge = evalErrorSurge(probe)

  logger.info('coexistSyncHealth: trigger evaluation', {
    dark: dark.triggered,
    weak_dedup: weak.triggered,
    error_surge: surge.triggered,
  })

  const writes = []
  if (!dryRun) {
    if (dark.triggered) {
      const r = await maybeWriteAlert(
        db,
        'Co-Exist sync health alarm - DARK',
        `Sync dark for ${dark.minutes_dark}min in active window. ${dark.details}`,
        "Investigate Co-Exist sync: SELECT run_at, direction FROM excel_sync_runs ORDER BY run_at DESC LIMIT 5; check Edge Function logs (excel-sync) on Co-Exist Supabase project tjutlbzekfouwsiaplbr"
      )
      writes.push({ trigger: 'DARK', ...r })
    }
    if (weak.triggered) {
      const r = await maybeWriteAlert(
        db,
        'Co-Exist sync health alarm - WEAK-DEDUP',
        `Last run reported weak_dedup_warning_count=${weak.weak_dedup_count}. ${weak.details}`,
        "Investigate weak-dedup: SELECT run_at, summary FROM excel_sync_runs ORDER BY run_at DESC LIMIT 1; review the summary jsonb for the duplicate-row context"
      )
      writes.push({ trigger: 'WEAK-DEDUP', ...r })
    }
    if (surge.triggered) {
      const r = await maybeWriteAlert(
        db,
        'Co-Exist sync health alarm - ERROR-SURGE',
        `Recent-3 error sum=${surge.recent_sum}, threshold=${surge.threshold.toFixed(2)}. ${surge.details}`,
        "Investigate error surge: SELECT run_at, from_excel_error_count, to_excel_error_count, summary FROM excel_sync_runs ORDER BY run_at DESC LIMIT 5"
      )
      writes.push({ trigger: 'ERROR-SURGE', ...r })
    }
  }

  return {
    dryRun,
    fixture,
    triggers: { dark, weak_dedup: weak, error_surge: surge },
    writes,
  }
}

module.exports = { runCoexistSyncHealth, _internal: { evalDark, evalWeakDedup, evalErrorSurge, FIXTURE } }

// -- CLI --------------------------------------------------------------------

if (require.main === module) {
  const argv = process.argv.slice(2)
  const dryRun = argv.includes('--dry-run')
  const fixture = argv.includes('--fixture')
  // --once is a no-op alias accepted from the cron prompt convention
  // (it just means "run me once and exit," which is what running the script
  // bare already does). Listed for explicitness.

  runCoexistSyncHealth({ dryRun, fixture })
    .then(result => {
      console.log('\n-- COEXIST SYNC HEALTH REPORT --')
      console.log(JSON.stringify(result, null, 2))
      const anyTriggered =
        result.triggers.dark.triggered ||
        result.triggers.weak_dedup.triggered ||
        result.triggers.error_surge.triggered
      if (anyTriggered) {
        console.log(`\n[ALERT] ${result.writes.length} status_board write(s) made.`)
      } else {
        console.log('\n[OK] No triggers fired.')
      }
      process.exit(0)
    })
    .catch(err => {
      const logger = require('../config/logger')
      logger.error('coexistSyncHealth: fatal', { error: err.message, stack: err.stack })
      console.error(`coexistSyncHealth: fatal - ${err.message}`)
      process.exit(1)
    })
}
