/**
 * Crisis Brief — composes the context pack prepended to any rescue turn.
 *
 * Pulls from sources outside the live codebase state (DB, git, pm2, logs)
 * so that even if main OS is wedged the brief still composes.
 *
 * Used two ways:
 *   1. `GET /api/rescue/brief` — exposed so Tate's frontend can show what
 *      the rescue is seeing.
 *   2. Auto-prepended to the first message in any rescue session via
 *      POST /api/rescue/invoke (vs POST /api/rescue/message, which sends
 *      raw text with no brief).
 */
const { execFileSync } = require('child_process')
const path = require('path')
const fs = require('fs')
const logger = require('../config/logger')

const RESCUE_REPO_PATH = process.env.RESCUE_REPO_PATH || '/home/tate/ecodiaos'
const PM2_BIN = process.env.PM2_BIN || 'pm2'
const PM2_LOG_DIR = process.env.PM2_LOG_DIR || '/home/tate/.pm2/logs'
const MAX_LOG_LINES = parseInt(process.env.RESCUE_BRIEF_LOG_LINES || '500', 10)

function _safeExec(cmd, args, opts = {}) {
  try {
    return execFileSync(cmd, args, {
      encoding: 'utf-8', timeout: 10_000, maxBuffer: 10 * 1024 * 1024, ...opts,
    }).trim()
  } catch (err) {
    return `[exec failed: ${cmd} ${args.join(' ')} — ${err.message}]`
  }
}

function _tailFile(filepath, lines) {
  try {
    if (!fs.existsSync(filepath)) return `[log file not found: ${filepath}]`
    // tail via system tail rather than reading the whole file
    return _safeExec('tail', ['-n', String(lines), filepath])
  } catch (err) {
    return `[tail failed: ${err.message}]`
  }
}

async function _fetchRecentErrors(db, limitRows = 10) {
  try {
    const rows = await db`
      SELECT level, message, module, path, method, created_at
      FROM app_errors
      ORDER BY created_at DESC
      LIMIT ${limitRows}
    `
    if (!rows || rows.length === 0) return '(no recent app_errors rows)'
    return rows.map(r => {
      const ts = r.created_at?.toISOString?.() || String(r.created_at)
      const loc = [r.module, r.path, r.method].filter(Boolean).join(' ')
      return `[${ts}] ${r.level} ${loc ? `(${loc}) ` : ''}${(r.message || '').slice(0, 400)}`
    }).join('\n')
  } catch (err) {
    return `[app_errors read failed: ${err.message}]`
  }
}

async function _fetchHandoff(db) {
  try {
    const rows = await db`SELECT value FROM kv_store WHERE key = 'session.handoff_state'`
    if (!rows || rows.length === 0) return '(no handoff state)'
    const v = rows[0].value
    return typeof v === 'string' ? v : JSON.stringify(v, null, 2).slice(0, 2000)
  } catch (err) {
    return `[handoff read failed: ${err.message}]`
  }
}

async function composeBrief({ db, reason = 'manual_invocation', extraContext = null } = {}) {
  const sections = []

  sections.push(`# CRISIS BRIEF`)
  sections.push(`Generated: ${new Date().toISOString()}`)
  sections.push(`Trigger: ${reason}`)
  if (extraContext) sections.push(`Extra context: ${extraContext}`)
  sections.push('')

  // PM2 state
  sections.push(`## PM2 state`)
  sections.push('```')
  sections.push(_safeExec(PM2_BIN, ['jlist']).slice(0, 8000))
  sections.push('```')
  sections.push('')

  // Git state
  sections.push(`## Git (${RESCUE_REPO_PATH})`)
  sections.push('```')
  sections.push(_safeExec('git', ['-C', RESCUE_REPO_PATH, 'status', '--short']))
  sections.push(_safeExec('git', ['-C', RESCUE_REPO_PATH, 'log', '--oneline', '-10']))
  sections.push('```')
  sections.push('')

  // ecodia-api log tail
  sections.push(`## ecodia-api log tail (last ${MAX_LOG_LINES} lines)`)
  sections.push('```')
  sections.push(_tailFile(path.join(PM2_LOG_DIR, 'ecodia-api-out.log'), MAX_LOG_LINES))
  sections.push('```')
  sections.push('')

  sections.push(`## ecodia-api error log tail (last ${MAX_LOG_LINES} lines)`)
  sections.push('```')
  sections.push(_tailFile(path.join(PM2_LOG_DIR, 'ecodia-api-error.log'), MAX_LOG_LINES))
  sections.push('```')
  sections.push('')

  // app_errors table
  if (db) {
    sections.push(`## Last 10 app_errors DB rows`)
    sections.push('```')
    sections.push(await _fetchRecentErrors(db))
    sections.push('```')
    sections.push('')

    sections.push(`## Last session handoff state`)
    sections.push('```')
    sections.push(await _fetchHandoff(db))
    sections.push('```')
    sections.push('')
  }

  // Resource snapshot
  sections.push(`## Resource snapshot`)
  sections.push('```')
  sections.push(_safeExec('df', ['-h', '/home']).slice(0, 2000))
  sections.push('---')
  sections.push(_safeExec('free', ['-h']).slice(0, 2000))
  sections.push('```')

  return sections.join('\n')
}

module.exports = { composeBrief }
