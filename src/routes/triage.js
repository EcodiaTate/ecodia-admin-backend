/**
 * Triage routes — /api/triage/*
 *
 * One-call diagnostic surfaces designed to answer "what's actually happening
 * right now?" without requiring SSH + shell familiarity. Consumable by:
 *   - Tate's manual curl in a pinch
 *   - The rescue process (it reads these instead of shelling out)
 *   - External uptime monitors
 *
 * Everything here is READ-ONLY. No action endpoints. Triage never modifies.
 */
const express = require('express')
const router = express.Router()
const { execFileSync } = require('child_process')
const logger = require('../config/logger')

function _safeExec(cmd, args, opts = {}) {
  try {
    return execFileSync(cmd, args, {
      encoding: 'utf-8', timeout: 5_000, maxBuffer: 5 * 1024 * 1024, ...opts,
    }).trim()
  } catch (err) {
    return `[exec failed: ${cmd} ${args.join(' ')} — ${err.message}]`
  }
}

// In-memory ring buffer dump — the most useful triage endpoint when the
// OS is wedged. Gives you the last N log entries including debug-level
// ones that would otherwise be filtered. Query by level or limit.
router.get('/logs', (req, res) => {
  const limit = Math.min(parseInt(req.query.limit || '200', 10), 1000)
  const minLevel = (req.query.level || '').toLowerCase()
  const levelOrder = { error: 0, warn: 1, info: 2, http: 3, verbose: 4, debug: 5, silly: 6 }
  const levelThreshold = levelOrder[minLevel] ?? null

  const entries = (logger.getRecentLogs ? logger.getRecentLogs(limit) : []).filter(e => {
    if (levelThreshold === null) return true
    const entryLevel = levelOrder[e.level] ?? 2
    return entryLevel <= levelThreshold
  })
  res.json({ count: entries.length, entries })
})

// Trim pm2 jlist down to the fields a diagnostician actually reads.
// Raw `pm2 jlist` dumps every env var and every pm2 axm metric for each
// process — easily 10KB of noise per proc that obscures the signal
// (status, restart count, memory, uptime).
function _pm2Summary() {
  const raw = _safeExec('pm2', ['jlist'])
  if (raw.startsWith('[exec failed')) return raw
  let parsed
  try { parsed = JSON.parse(raw) } catch { return '[pm2 jlist parse failed]' }
  if (!Array.isArray(parsed)) return '[pm2 jlist not an array]'
  return parsed.map(p => ({
    name: p.name,
    pid: p.pid,
    status: p.pm2_env?.status,
    restarts: p.pm2_env?.restart_time,
    unstable_restarts: p.pm2_env?.unstable_restarts,
    uptime_ms: p.pm2_env?.pm_uptime ? Date.now() - p.pm2_env.pm_uptime : null,
    memory_mb: p.monit?.memory ? Math.round(p.monit.memory / 1024 / 1024) : null,
    cpu_pct: p.monit?.cpu,
    exec_mode: p.pm2_env?.exec_mode,
    node_version: p.pm2_env?.node_version,
  }))
}

// One-shot snapshot of everything a diagnostician would want.
router.get('/dump', async (_req, res, next) => {
  try {
    const snapshot = {
      ts: new Date().toISOString(),
      process: {
        pid: process.pid,
        uptime: process.uptime(),
        memory: process.memoryUsage(),
        version: process.version,
      },
      logs: logger.getRecentLogs ? logger.getRecentLogs(300) : [],
      pm2: _pm2Summary(),
      disk: _safeExec('df', ['-h', '/home']),
      memFree: _safeExec('free', ['-h']),
    }

    // OS session snapshot — active, last session row.
    try {
      const osSession = require('../services/osSessionService')
      snapshot.osSession = osSession.getStatus ? await osSession.getStatus().catch(() => ({ error: 'getStatus_failed' })) : null
    } catch (err) {
      snapshot.osSession = { error: err.message }
    }

    // Last 20 actual problems from app_errors (warn+ only).
    // The table stores every level — migrations, neo4j-init, debug breadcrumbs
    // — because it's the "session sees its own failures" surface for the OS.
    // For human triage we only care about warn+ so real errors aren't buried
    // in migration chatter.
    try {
      const db = require('../config/db')
      const rows = await db`
        SELECT level, message, module, path, method, created_at
        FROM app_errors
        WHERE level IN ('error', 'warn')
        ORDER BY created_at DESC
        LIMIT 20
      `.catch(() => null)
      snapshot.appErrors = rows || { error: 'db_unreachable' }
    } catch (err) {
      snapshot.appErrors = { error: err.message }
    }

    // Rescue state — use the probing variant so a fresh api process that
    // booted after rescue's initial `ready` broadcast still reports rescue
    // as alive. Falls back to plain getStatus if probing isn't available.
    try {
      const rescue = require('../services/rescueService')
      snapshot.rescue = rescue.getStatusWithProbe
        ? await rescue.getStatusWithProbe()
        : rescue.getStatus()
    } catch (err) {
      snapshot.rescue = { error: err.message }
    }

    res.json(snapshot)
  } catch (err) {
    logger.error('triage/dump failed', { error: err.message })
    next(err)
  }
})

// Health of each subsystem in one call. Useful for a UI dashboard later.
router.get('/health', async (_req, res) => {
  const out = {
    process: { ok: true, uptime: process.uptime() },
    db: { ok: null, error: null },
    redis: { ok: null, error: null },
    neo4j: { ok: null, error: null },
    osSession: { ok: null, error: null },
  }

  try {
    const db = require('../config/db')
    await db`SELECT 1`
    out.db.ok = true
  } catch (err) {
    out.db.ok = false; out.db.error = err.message
  }

  try {
    const { getRedisClient } = require('../config/redis')
    const redis = getRedisClient()
    if (redis) {
      await redis.ping()
      out.redis.ok = true
    } else {
      out.redis.ok = false; out.redis.error = 'no client'
    }
  } catch (err) {
    out.redis.ok = false; out.redis.error = err.message
  }

  try {
    const osSession = require('../services/osSessionService')
    const status = osSession.getStatus ? await osSession.getStatus() : null
    out.osSession.ok = !!status
    out.osSession.status = status
  } catch (err) {
    out.osSession.ok = false; out.osSession.error = err.message
  }

  // Neo4j intentionally skipped — many subsystems make it optional.

  res.json(out)
})

module.exports = router
