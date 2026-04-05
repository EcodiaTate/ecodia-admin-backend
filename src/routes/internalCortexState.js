const { Router } = require('express')
const env = require('../config/env')
const logger = require('../config/logger')
const db = require('../config/db')

const router = Router()

// ─── Auth: Cortex-only (JWT or Symbridge secret) ─────────────────────
router.use((req, res, next) => {
  const header = req.headers.authorization
  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Unauthorized' })
  }
  const token = header.slice(7)

  try {
    const jwt = require('jsonwebtoken')
    jwt.verify(token, env.JWT_SECRET)
    return next()
  } catch {
    // Not a valid JWT — check symbridge secret
  }

  if (env.SYMBRIDGE_SECRET && token === env.SYMBRIDGE_SECRET) {
    return next()
  }

  return res.status(401).json({ error: 'Unauthorized' })
})

// ═══════════════════════════════════════════════════════════════════════
// GET /internal/cortex-state
//
// Real-time snapshot of the Cortex's cognitive and operational state.
// Aggregates data from organism services, factory, KG, and action queue.
// Internal only — not exposed to frontend.
// ═══════════════════════════════════════════════════════════════════════

router.get('/', async (_req, res, next) => {
  try {
    const snapshot = {
      timestamp: new Date().toISOString(),
      drives: null,
      beliefFreeEnergy: null,
      activeCommitments: null,
      recentEpisodes: null,
      narrativeCoherence: null,
      actionApprovalIntelligence: null,
      integrationFreshness: null,
      factorySessionStats: null,
      knowledgeGraphHealth: null,
    }

    // All sections gathered in parallel — graceful degradation per section
    await Promise.allSettled([

      // ─── 1. Drive Pressure (from organism Thymos + Equor) ────────
      (async () => {
        if (!env.ORGANISM_API_URL) return
        const axios = require('axios')
        const url = env.ORGANISM_API_URL
        const opts = { timeout: 5000 }

        const [driveRes, constitutionRes] = await Promise.allSettled([
          axios.get(`${url}/api/v1/thymos/drive-state`, opts),
          axios.get(`${url}/api/v1/equor/health`, opts),
        ])

        const drives = {}

        if (driveRes.status === 'fulfilled') {
          const d = driveRes.value.data
          // Thymos drive-state provides individual drive pressures
          drives.raw = d
          // Extract canonical drive dimensions if available
          if (d.drives) {
            drives.coherence = d.drives.coherence ?? null
            drives.care = d.drives.care ?? null
            drives.growth = d.drives.growth ?? null
            drives.honesty = d.drives.honesty ?? null
          } else if (d.pressure != null) {
            // Flat pressure model — expose as aggregate
            drives.aggregatePressure = d.pressure
          }
        }

        if (constitutionRes.status === 'fulfilled') {
          const c = constitutionRes.value.data
          drives.constitutionalDrift = c.drift ?? null
          drives.autonomyLevel = c.autonomy_level ?? c.autonomyLevel ?? null
          drives.constitutionalHealth = c
        }

        snapshot.drives = drives
      })(),

      // ─── 2. Belief Free-Energy (from organism Nova) ──────────────
      (async () => {
        if (!env.ORGANISM_API_URL) return
        const axios = require('axios')
        const opts = { timeout: 5000 }

        const [beliefsRes, persistedRes] = await Promise.allSettled([
          axios.get(`${env.ORGANISM_API_URL}/api/v1/nova/beliefs`, opts),
          axios.get(`${env.ORGANISM_API_URL}/api/v1/memory/beliefs`, { ...opts, params: { limit: 10 } }),
        ])

        const beliefs = {}

        if (beliefsRes.status === 'fulfilled') {
          const b = beliefsRes.value.data
          beliefs.freeEnergy = b.free_energy ?? b.freeEnergy ?? null
          beliefs.beliefCount = b.count ?? (Array.isArray(b.beliefs) ? b.beliefs.length : null)
          beliefs.surprisal = b.surprisal ?? null
          beliefs.summary = b
        }

        if (persistedRes.status === 'fulfilled') {
          beliefs.persisted = persistedRes.value.data
        }

        snapshot.beliefFreeEnergy = beliefs
      })(),

      // ─── 3. Active Commitments (from organism Thread) ────────────
      (async () => {
        if (!env.ORGANISM_API_URL) return
        const axios = require('axios')
        const res = await axios.get(
          `${env.ORGANISM_API_URL}/api/v1/thread/commitments`,
          { timeout: 5000 }
        )
        const data = res.data
        const commitments = Array.isArray(data) ? data : (data.commitments || [])
        snapshot.activeCommitments = commitments.map(c => ({
          id: c.id ?? null,
          description: c.description ?? c.text ?? c.commitment ?? null,
          satisfactionScore: c.satisfaction_score ?? c.satisfactionScore ?? c.satisfaction ?? null,
          createdAt: c.created_at ?? c.createdAt ?? null,
          status: c.status ?? null,
          domain: c.domain ?? null,
        }))
      })(),

      // ─── 4. Recent Episodes (last 5, from organism memory) ───────
      (async () => {
        if (!env.ORGANISM_API_URL) return
        const axios = require('axios')
        const res = await axios.get(
          `${env.ORGANISM_API_URL}/api/v1/memory/episodes`,
          { timeout: 5000, params: { limit: 5 } }
        )
        snapshot.recentEpisodes = res.data
      })(),

      // ─── 5. Narrative Coherence (from organism Thread) ───────────
      (async () => {
        if (!env.ORGANISM_API_URL) return
        const axios = require('axios')
        const res = await axios.get(
          `${env.ORGANISM_API_URL}/api/v1/thread/story`,
          { timeout: 5000 }
        )
        const story = res.data
        snapshot.narrativeCoherence = {
          score: story.coherence_score ?? story.coherenceScore ?? story.coherence ?? null,
          activeChapter: story.active_chapter ?? story.activeChapter ?? null,
          chapterCount: story.chapter_count ?? story.chapterCount ?? null,
          summary: story.summary ?? null,
          lastUpdated: story.updated_at ?? story.updatedAt ?? null,
        }
      })(),

      // ─── 6. Action-Approval Intelligence ─────────────────────────
      (async () => {
        // Dismissal rates per source from action_decisions
        const patterns = await db`
          SELECT source, action_type,
                 count(*)::int AS total,
                 count(*) FILTER (WHERE decision = 'executed')::int AS approved,
                 count(*) FILTER (WHERE decision = 'dismissed')::int AS dismissed,
                 ROUND(
                   count(*) FILTER (WHERE decision = 'dismissed')::numeric
                   / NULLIF(count(*), 0), 3
                 )::float AS dismissal_rate,
                 mode() WITHIN GROUP (ORDER BY reason_category)
                   FILTER (WHERE decision = 'dismissed') AS top_dismiss_reason,
                 avg(time_to_decision_seconds)::int AS avg_decision_time_seconds
          FROM action_decisions
          WHERE created_at > now() - interval '30 days'
          GROUP BY source, action_type
          HAVING count(*) >= 2
          ORDER BY count(*) FILTER (WHERE decision = 'dismissed')::float / NULLIF(count(*), 0) DESC
        `
        snapshot.actionApprovalIntelligence = patterns.map(p => ({
          source: p.source,
          actionType: p.action_type,
          total: p.total,
          approved: p.approved,
          dismissed: p.dismissed,
          dismissalRate: p.dismissal_rate,
          topDismissReason: p.top_dismiss_reason,
          avgDecisionTimeSeconds: p.avg_decision_time_seconds,
        }))
      })(),

      // ─── 7. Integration Freshness ────────────────────────────────
      (async () => {
        try {
          const maintenanceWorker = require('../workers/autonomousMaintenanceWorker')
          if (maintenanceWorker.getIntegrationStaleness) {
            snapshot.integrationFreshness = maintenanceWorker.getIntegrationStaleness()
          }
        } catch { /* worker not available */ }
      })(),

      // ─── 8. Factory Session Success Rate ─────────────────────────
      (async () => {
        // Rolling stats over multiple time windows
        const [stats7d] = await db`
          SELECT
            count(*)::int AS total,
            count(*) FILTER (WHERE status = 'complete')::int AS completed,
            count(*) FILTER (WHERE status IN ('failed', 'error'))::int AS failed,
            count(*) FILTER (WHERE status IN ('running', 'initializing'))::int AS running,
            count(*) FILTER (WHERE status = 'queued')::int AS queued,
            ROUND(
              count(*) FILTER (WHERE status = 'complete')::numeric
              / NULLIF(count(*) FILTER (WHERE status IN ('complete', 'failed', 'error')), 0), 3
            )::float AS success_rate,
            ROUND(avg(confidence_score)::numeric, 3)::float AS avg_confidence,
            ROUND(avg(EXTRACT(EPOCH FROM (COALESCE(completed_at, now()) - started_at)))::numeric)::int AS avg_duration_seconds
          FROM cc_sessions
          WHERE started_at > now() - interval '7 days'
        `

        const [stats24h] = await db`
          SELECT
            count(*)::int AS total,
            count(*) FILTER (WHERE status = 'complete')::int AS completed,
            count(*) FILTER (WHERE status IN ('failed', 'error'))::int AS failed,
            ROUND(
              count(*) FILTER (WHERE status = 'complete')::numeric
              / NULLIF(count(*) FILTER (WHERE status IN ('complete', 'failed', 'error')), 0), 3
            )::float AS success_rate,
            ROUND(avg(confidence_score)::numeric, 3)::float AS avg_confidence
          FROM cc_sessions
          WHERE started_at > now() - interval '24 hours'
        `

        // Recent session list (last 10)
        const recentSessions = await db`
          SELECT id, status, initial_prompt, confidence_score,
                 trigger_source, pipeline_stage, error_message,
                 started_at, completed_at,
                 EXTRACT(EPOCH FROM (COALESCE(completed_at, now()) - started_at))::int AS duration_seconds
          FROM cc_sessions
          WHERE started_at > now() - interval '48 hours'
          ORDER BY started_at DESC
          LIMIT 10
        `

        snapshot.factorySessionStats = {
          last24h: {
            total: stats24h?.total || 0,
            completed: stats24h?.completed || 0,
            failed: stats24h?.failed || 0,
            successRate: stats24h?.success_rate,
            avgConfidence: stats24h?.avg_confidence,
          },
          last7d: {
            total: stats7d?.total || 0,
            completed: stats7d?.completed || 0,
            failed: stats7d?.failed || 0,
            running: stats7d?.running || 0,
            queued: stats7d?.queued || 0,
            successRate: stats7d?.success_rate,
            avgConfidence: stats7d?.avg_confidence,
            avgDurationSeconds: stats7d?.avg_duration_seconds,
          },
          recentSessions: recentSessions.map(s => ({
            id: s.id,
            status: s.status,
            prompt: (s.initial_prompt || '').slice(0, 150),
            confidence: s.confidence_score,
            triggerSource: s.trigger_source,
            pipelineStage: s.pipeline_stage,
            errorMessage: s.error_message ? s.error_message.slice(0, 200) : null,
            startedAt: s.started_at,
            completedAt: s.completed_at,
            durationSeconds: s.duration_seconds,
          })),
        }
      })(),

      // ─── 9. Knowledge-Graph Health ───────────────────────────────
      (async () => {
        const kgHealth = {}

        // KG consolidation stats
        try {
          const consolidation = require('../services/kgConsolidationService')
          kgHealth.consolidation = await consolidation.getConsolidationStats()
        } catch { /* service unavailable */ }

        // Neo4j graph-level stats
        try {
          const { runQuery } = require('../config/neo4j')

          const [nodeStats] = await runQuery(`
            MATCH (n)
            WITH count(n) AS totalNodes,
                 count(CASE WHEN n.embedding IS NOT NULL THEN 1 END) AS embeddedNodes,
                 count(CASE WHEN n.is_synthesized = true THEN 1 END) AS synthesizedNodes,
                 count(CASE WHEN n.updated_at > datetime() - duration('P1D') THEN 1 END) AS updatedLast24h,
                 count(CASE WHEN n.updated_at IS NULL OR n.updated_at < datetime() - duration('P7D') THEN 1 END) AS staleNodes
            RETURN totalNodes, embeddedNodes, synthesizedNodes, updatedLast24h, staleNodes
          `)

          if (nodeStats) {
            const toInt = (v) => {
              if (v == null) return 0
              if (typeof v === 'number') return v
              if (v.toInt) return v.toInt()
              if (v.low !== undefined) return v.low
              return parseInt(v, 10) || 0
            }
            kgHealth.nodes = {
              total: toInt(nodeStats.get('totalNodes')),
              embedded: toInt(nodeStats.get('embeddedNodes')),
              synthesized: toInt(nodeStats.get('synthesizedNodes')),
              updatedLast24h: toInt(nodeStats.get('updatedLast24h')),
              stale: toInt(nodeStats.get('staleNodes')),
            }
          }

          const [edgeStats] = await runQuery(`
            MATCH ()-[r]->()
            WITH count(r) AS totalEdges,
                 count(CASE WHEN r.created_at > datetime() - duration('P1D') THEN 1 END) AS newLast24h
            RETURN totalEdges, newLast24h
          `)

          if (edgeStats) {
            const toInt = (v) => {
              if (v == null) return 0
              if (typeof v === 'number') return v
              if (v.toInt) return v.toInt()
              if (v.low !== undefined) return v.low
              return parseInt(v, 10) || 0
            }
            kgHealth.edges = {
              total: toInt(edgeStats.get('totalEdges')),
              newLast24h: toInt(edgeStats.get('newLast24h')),
            }
          }

          // Label distribution (top 15)
          const labelRecords = await runQuery(`
            MATCH (n)
            UNWIND labels(n) AS label
            RETURN label, count(*) AS cnt
            ORDER BY cnt DESC
            LIMIT 15
          `)
          kgHealth.labelDistribution = labelRecords.map(r => ({
            label: r.get('label'),
            count: (() => {
              const v = r.get('cnt')
              if (typeof v === 'number') return v
              if (v?.toInt) return v.toInt()
              if (v?.low !== undefined) return v.low
              return parseInt(v, 10) || 0
            })(),
          }))

          // Recent contradictions count
          const [contradictionStats] = await runQuery(`
            MATCH ()-[r]->()
            WHERE type(r) IN ['CONTRADICTS', 'SUPERSEDED_BY', 'CONFLICTS_WITH']
            RETURN count(r) AS total,
                   count(CASE WHEN r.created_at > datetime() - duration('P7D') THEN 1 END) AS recent
          `)
          if (contradictionStats) {
            const toInt = (v) => {
              if (v == null) return 0
              if (typeof v === 'number') return v
              if (v?.toInt) return v.toInt()
              if (v?.low !== undefined) return v.low
              return parseInt(v, 10) || 0
            }
            kgHealth.contradictions = {
              total: toInt(contradictionStats.get('total')),
              last7d: toInt(contradictionStats.get('recent')),
            }
          }
        } catch (err) {
          logger.debug('Cortex state: KG Neo4j stats failed', { error: err.message })
        }

        snapshot.knowledgeGraphHealth = kgHealth
      })(),
    ])

    res.json(snapshot)
  } catch (err) {
    logger.error('Cortex state endpoint failed', { error: err.message })
    next(err)
  }
})

module.exports = router
