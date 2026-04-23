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
      pm2: _safeExec('pm2', ['jlist']).slice(0, 10000),
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

    // Last 20 app_errors rows (if DB reachable).
    try {
      const db = require('../config/db')
      const rows = await db`
        SELECT level, message, module, path, method, created_at
        FROM app_errors
        ORDER BY created_at DESC
        LIMIT 20
      `.catch(() => null)
      snapshot.appErrors = rows || { error: 'db_unreachable' }
    } catch (err) {
      snapshot.appErrors = { error: err.message }
    }

    // Rescue state, if rescue is up.
    try {
      const rescue = require('../services/rescueService')
      snapshot.rescue = rescue.getStatus()
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
