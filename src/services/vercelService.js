const env = require('../config/env')
const db = require('../config/db')
const logger = require('../config/logger')
const kgHooks = require('./kgIngestionHooks')

// ═══════════════════════════════════════════════════════════════════════
// VERCEL SERVICE
//
// Polls Vercel API for projects, deployments, and build status.
// Tracks deployment history, surfaces build failures, feeds KG.
// ═══════════════════════════════════════════════════════════════════════

const VERCEL_API = 'https://api.vercel.com'

async function vercelFetch(path, opts = {}) {
  if (!env.VERCEL_API_TOKEN) throw new Error('VERCEL_API_TOKEN not configured')

  const url = `${VERCEL_API}${path}${env.VERCEL_TEAM_ID ? `${path.includes('?') ? '&' : '?'}teamId=${env.VERCEL_TEAM_ID}` : ''}`
  const res = await fetch(url, {
    ...opts,
    headers: {
      Authorization: `Bearer ${env.VERCEL_API_TOKEN}`,
      'Content-Type': 'application/json',
      ...opts.headers,
    },
  })

  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`Vercel API ${res.status}: ${text.slice(0, 200)}`)
  }

  return res.json()
}

// ─── Sync Projects ─────────────────────────────────────────────────────

async function syncProjects() {
  const data = await vercelFetch('/v9/projects?limit=100')
  const projects = data.projects || []

  for (const project of projects) {
    await db`
      INSERT INTO vercel_projects (vercel_project_id, name, framework, git_repo, production_url)
      VALUES (
        ${project.id},
        ${project.name},
        ${project.framework || null},
        ${project.link?.repo ? `${project.link.org}/${project.link.repo}` : null},
        ${project.targets?.production?.url ? `https://${project.targets.production.url}` : null}
      )
      ON CONFLICT (vercel_project_id) DO UPDATE SET
        name = EXCLUDED.name,
        framework = EXCLUDED.framework,
        git_repo = EXCLUDED.git_repo,
        production_url = EXCLUDED.production_url,
        updated_at = now()
    `
  }

  logger.info(`Vercel projects synced: ${projects.length}`)
  return projects.length
}

// ─── Sync Deployments ──────────────────────────────────────────────────

async function syncDeployments(limit = 50) {
  const data = await vercelFetch(`/v6/deployments?limit=${limit}`)
  const deployments = data.deployments || []

  let newCount = 0
  for (const dep of deployments) {
    // Find our project record
    const [project] = await db`
      SELECT id FROM vercel_projects WHERE vercel_project_id = ${dep.projectId || ''} LIMIT 1
    `

    const [existing] = await db`
      SELECT id FROM vercel_deployments WHERE vercel_deployment_id = ${dep.uid} LIMIT 1
    `

    const stateMap = { READY: 'READY', ERROR: 'ERROR', BUILDING: 'BUILDING', QUEUED: 'QUEUED', CANCELED: 'CANCELED' }

    await db`
      INSERT INTO vercel_deployments (
        vercel_deployment_id, project_id, vercel_project_id,
        url, state, target, git_branch, git_commit_sha, git_commit_message,
        creator_email, error_message, ready_at, created_at
      ) VALUES (
        ${dep.uid},
        ${project?.id || null},
        ${dep.projectId || null},
        ${dep.url ? `https://${dep.url}` : null},
        ${stateMap[dep.state] || dep.state || 'UNKNOWN'},
        ${dep.target || null},
        ${dep.meta?.githubCommitRef || dep.meta?.gitlabCommitRef || null},
        ${dep.meta?.githubCommitSha || dep.meta?.gitlabCommitSha || null},
        ${dep.meta?.githubCommitMessage || dep.meta?.gitlabCommitMessage || null},
        ${dep.creator?.email || null},
        ${dep.errorMessage || null},
        ${dep.ready ? new Date(dep.ready).toISOString() : null},
        ${dep.created ? new Date(dep.created).toISOString() : new Date().toISOString()}
      )
      ON CONFLICT (vercel_deployment_id) DO UPDATE SET
        state = EXCLUDED.state,
        error_message = EXCLUDED.error_message,
        ready_at = EXCLUDED.ready_at
    `

    if (!existing) {
      newCount++

      // KG hook for new deployments
      kgHooks.onVercelDeployment({
        deployment: dep,
        projectName: dep.name,
      }).catch(() => {})

      // Surface errors to action queue (not just notification)
      if (dep.state === 'ERROR') {
        const { createNotification } = require('../db/queries/transactions')
        await createNotification({
          type: 'vercel_error',
          message: `Vercel build failed: ${dep.name} (${dep.meta?.githubCommitRef || 'unknown branch'})`,
          metadata: {
            deploymentId: dep.uid,
            project: dep.name,
            error: dep.errorMessage,
            commitSha: dep.meta?.githubCommitSha,
          },
        }).catch(() => {})

        // Enqueue actionable item — human can trigger a CC fix session
        const actionQueue = require('./actionQueueService')
        actionQueue.enqueue({
          source: 'vercel',
          sourceRefId: dep.uid,
          actionType: 'create_task',
          title: `Build failed: ${dep.name} (${dep.meta?.githubCommitRef || 'unknown'})`,
          summary: `${dep.errorMessage || 'Unknown error'}. Commit: ${dep.meta?.githubCommitMessage || 'N/A'}`,
          preparedData: {
            title: `Fix Vercel build failure: ${dep.name}`,
            description: `Branch: ${dep.meta?.githubCommitRef || 'unknown'}\nCommit: ${dep.meta?.githubCommitMessage || 'N/A'}\nError: ${dep.errorMessage || 'Check build logs'}\nDeployment: ${dep.uid}`,
          },
          context: { deploymentId: dep.uid, project: dep.name, branch: dep.meta?.githubCommitRef },
          priority: dep.target === 'production' ? 'urgent' : 'high',
        }).catch(() => {})
      }
    }
  }

  if (newCount > 0) {
    logger.info(`Vercel deployments synced: ${newCount} new of ${deployments.length}`)
  }
  return newCount
}

// ─── Full Poll ─────────────────────────────────────────────────────────

async function poll() {
  if (!env.VERCEL_API_TOKEN) return
  await syncProjects()
  await syncDeployments()
}

// ─── Queries ───────────────────────────────────────────────────────────

async function getProjects() {
  return db`
    SELECT vp.*, count(vd.id)::int AS deployment_count,
           max(vd.created_at) AS last_deployed_at
    FROM vercel_projects vp
    LEFT JOIN vercel_deployments vd ON vd.project_id = vp.id
    GROUP BY vp.id
    ORDER BY last_deployed_at DESC NULLS LAST
  `
}

async function getDeployments({ projectId, state, limit = 30 } = {}) {
  return db`
    SELECT vd.*, vp.name AS project_name
    FROM vercel_deployments vd
    LEFT JOIN vercel_projects vp ON vd.project_id = vp.id
    WHERE 1=1
      ${projectId ? db`AND vd.project_id = ${projectId}` : db``}
      ${state ? db`AND vd.state = ${state}` : db``}
    ORDER BY vd.created_at DESC
    LIMIT ${limit}
  `
}

async function getStats() {
  const [stats] = await db`
    SELECT
      count(DISTINCT vp.id)::int AS total_projects,
      count(vd.id)::int AS total_deployments,
      count(vd.id) FILTER (WHERE vd.state = 'READY' AND vd.created_at > now() - interval '24 hours')::int AS deployed_24h,
      count(vd.id) FILTER (WHERE vd.state = 'ERROR' AND vd.created_at > now() - interval '24 hours')::int AS failed_24h,
      count(vd.id) FILTER (WHERE vd.state = 'BUILDING')::int AS building_now
    FROM vercel_projects vp
    LEFT JOIN vercel_deployments vd ON vd.project_id = vp.id
  `
  return stats
}

// ─── Build Logs ────────────────────────────────────────────────────────

async function getBuildLogs(deploymentId) {
  const data = await vercelFetch(`/v2/deployments/${deploymentId}/events`)
  return (data || []).map(e => ({
    timestamp: e.created,
    type: e.type,
    text: e.text || e.payload?.text || '',
  }))
}

module.exports = {
  poll,
  syncProjects,
  syncDeployments,
  getProjects,
  getDeployments,
  getStats,
  getBuildLogs,
}
