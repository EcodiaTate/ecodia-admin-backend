const { Router } = require('express')
const auth = require('../middleware/auth')
const db = require('../config/db')
const logger = require('../config/logger')

const router = Router()
router.use(auth)

// GET /api/momentum — aggregated momentum data for the frontend dashboard
router.get('/', async (_req, res, next) => {
  try {
    const results = {}

    await Promise.allSettled([
      // Factory sessions (7d) — summary stats
      db`
        SELECT
          count(*)::int AS sessions_7d,
          count(*) FILTER (WHERE status = 'complete')::int AS complete,
          count(*) FILTER (WHERE pipeline_stage = 'deploying' OR pipeline_stage = 'deployed')::int AS deployed,
          CASE WHEN count(*) > 0
            THEN round((count(*) FILTER (WHERE status = 'complete')::numeric / count(*)) * 100)
            ELSE null
          END AS success_rate,
          coalesce(sum(array_length(files_changed, 1)), 0)::int AS files_changed
        FROM cc_sessions
        WHERE started_at > now() - interval '7 days'
      `.then(([r]) => { results.summary = r }),

      // Git commits (7d) — from codebases
      (async () => {
        const codebases = await db`SELECT name, repo_path FROM codebases`
        const { execFileSync } = require('child_process')
        const fs = require('fs')
        let totalCommits = 0
        const gitActivity = []
        for (const cb of codebases) {
          if (!cb.repo_path || !fs.existsSync(cb.repo_path)) continue
          try {
            const out = execFileSync('git', ['log', '--oneline', '--since=7 days ago'], {
              cwd: cb.repo_path, encoding: 'utf-8', timeout: 10_000, maxBuffer: 2 * 1024 * 1024,
            }).trim()
            const commits = out ? out.split('\n').length : 0
            if (commits > 0) {
              totalCommits += commits
              gitActivity.push({ name: cb.name, commits })
            }
          } catch {}
        }
        results.commits7d = totalCommits
        results.gitActivity = gitActivity
      })(),

      // Actions (7d)
      db`
        SELECT
          count(*) FILTER (WHERE status = 'pending')::int AS pending,
          count(*) FILTER (WHERE status = 'pending' AND priority = 'urgent')::int AS urgent,
          count(*) FILTER (WHERE status = 'executed' AND updated_at > now() - interval '24 hours')::int AS executed_24h,
          count(*) FILTER (WHERE status = 'dismissed' AND updated_at > now() - interval '24 hours')::int AS dismissed_24h,
          count(*) FILTER (WHERE status = 'executed' AND updated_at > now() - interval '7 days')::int AS executed_7d
        FROM action_queue
      `.then(([r]) => { results.actions = r }),

      // Recent sessions (detail)
      db`
        SELECT id, status, initial_prompt, confidence_score, stream_source,
               pipeline_stage, triggered_by,
               coalesce(array_length(files_changed, 1), 0) AS files_changed,
               EXTRACT(EPOCH FROM (coalesce(completed_at, now()) - started_at))::int AS duration_seconds,
               started_at, completed_at
        FROM cc_sessions
        WHERE started_at > now() - interval '7 days'
        ORDER BY started_at DESC
        LIMIT 30
      `.then(rows => { results.sessions = rows }),

      // Timeline (48h, hourly buckets)
      db`
        SELECT date_trunc('hour', started_at) AS hour,
               count(*)::int AS sessions,
               count(*) FILTER (WHERE status = 'complete')::int AS complete,
               count(*) FILTER (WHERE status = 'error')::int AS errors
        FROM cc_sessions
        WHERE started_at > now() - interval '48 hours'
        GROUP BY 1 ORDER BY 1
      `.then(rows => { results.timeline = rows }),

      // Stream stats (7d)
      db`
        SELECT coalesce(stream_source, 'manual') AS stream,
               count(*)::int AS total,
               count(*) FILTER (WHERE status = 'complete')::int AS complete,
               count(*) FILTER (WHERE status = 'error')::int AS errors,
               count(*) FILTER (WHERE pipeline_stage IN ('deploying', 'deployed'))::int AS deployed,
               round(avg(confidence_score)::numeric, 2) AS avg_confidence
        FROM cc_sessions
        WHERE started_at > now() - interval '7 days'
        GROUP BY 1 ORDER BY total DESC
      `.then(rows => { results.streams = rows }),

      // Inner monologue (percepts)
      db`
        SELECT message, metadata->>'stream_name' AS stream, created_at
        FROM notifications
        WHERE type = 'inner_monologue'
        ORDER BY created_at DESC LIMIT 10
      `.then(rows => { results.percepts = rows }),

      // System health (PM2 + memory + CPU)
      (async () => {
        try {
          const vitals = require('../services/vitalSignsService')
          results.health = await vitals.getVitals()
        } catch { results.health = null }
      })(),
    ])

    // Assemble response matching the frontend MomentumData type
    const summary = results.summary || {}
    res.json({
      summary: {
        sessions7d: summary.sessions_7d || 0,
        complete: summary.complete || 0,
        deployed: summary.deployed || 0,
        successRate: summary.success_rate != null ? Number(summary.success_rate) : null,
        filesChanged: summary.files_changed || 0,
        commits7d: results.commits7d || 0,
        actionsExecuted7d: results.actions?.executed_7d || 0,
      },
      sessions: (results.sessions || []).map(s => ({
        id: s.id,
        status: s.status,
        prompt: (s.initial_prompt || '').slice(0, 200),
        confidence: s.confidence_score,
        stream: s.stream_source,
        deployStatus: s.pipeline_stage,
        trigger: s.triggered_by,
        filesChanged: s.files_changed || 0,
        durationSeconds: s.duration_seconds || 0,
        startedAt: s.started_at,
        completedAt: s.completed_at,
      })),
      timeline: (results.timeline || []).map(t => ({
        hour: t.hour,
        sessions: t.sessions,
        complete: t.complete,
        errors: t.errors,
      })),
      streams: results.streams || [],
      actions: results.actions || {},
      goals: [],
      gitActivity: results.gitActivity || [],
      percepts: (results.percepts || []).map(p => ({
        message: p.message,
        stream: p.stream,
        createdAt: p.created_at,
      })),
      health: results.health ? {
        ecodiaos: {
          db: results.health.ecodiaos?.db ?? false,
          neo4j: results.health.ecodiaos?.neo4j ?? false,
          memory: results.health.ecodiaos?.memory || null,
          cpu: results.health.ecodiaos?.cpu ?? null,
          eventLoopLagMs: results.health.ecodiaos?.eventLoopLagMs ?? null,
          activeCCSessions: results.health.ecodiaos?.activeCCSessions || 0,
          pm2Processes: (results.health.ecodiaos?.pm2Processes || []).map(p => ({
            name: p.name,
            status: p.status,
            cpu: p.cpu,
            memory: p.memory,
            restarts: p.restarts,
            uptime: p.uptime,
          })),
        },
      } : null,
    })
  } catch (err) {
    next(err)
  }
})

module.exports = router
