const { execFileSync } = require('child_process')
const axios = require('axios')
const db = require('../config/db')
const logger = require('../config/logger')
const { broadcastToSession } = require('../websocket/wsManager')
const kgHooks = require('./kgIngestionHooks')

// ═══════════════════════════════════════════════════════════════════════
// DEPLOYMENT SERVICE
//
// Git commit → push → deploy → health check → auto-revert on failure.
// Full audit trail in KG and notifications table.
// ═══════════════════════════════════════════════════════════════════════

const HEALTH_CHECK_TIMEOUT = 60_000 // 60s
const HEALTH_CHECK_RETRIES = 3
const HEALTH_CHECK_INTERVAL = 10_000 // 10s between retries

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf-8', maxBuffer: 5 * 1024 * 1024 }).trim()
}

async function deploySession(sessionId) {
  const startTime = Date.now()

  const [session] = await db`
    SELECT cs.*, cb.repo_path, cb.name AS codebase_name, cb.meta, cb.language AS codebase_language
    FROM cc_sessions cs
    LEFT JOIN codebases cb ON cs.codebase_id = cb.id
    WHERE cs.id = ${sessionId}
  `
  if (!session) throw new Error(`Session ${sessionId} not found`)

  const repoPath = session.repo_path || session.working_dir
  if (!repoPath) throw new Error('No repo path for deployment')

  await db`UPDATE cc_sessions SET pipeline_stage = 'deploying' WHERE id = ${sessionId}`
  broadcastToSession(sessionId, 'cc:stage', { stage: 'deploying', progress: 0.8 })

  // Determine deploy target from codebase metadata
  const meta = session.meta || {}
  const deployTarget = meta.deploy_target || 'git_push' // 'vercel', 'pm2', 'git_push'
  const healthCheckUrl = meta.health_check_url || null
  const pm2Name = meta.pm2_name || null
  const branch = meta.branch || 'main'

  let commitSha
  let deploymentId

  try {
    // 1. Git commit
    const hasChanges = git(['status', '--porcelain'], repoPath)
    if (!hasChanges) {
      logger.info(`No changes to deploy for session ${sessionId}`)
      await db`UPDATE cc_sessions SET pipeline_stage = 'complete', deploy_status = 'deployed' WHERE id = ${sessionId}`
      return { status: 'no_changes' }
    }

    git(['add', '-A'], repoPath)
    const commitMsg = [
      `Factory: ${session.initial_prompt.slice(0, 100)}`,
      '',
      `CC Session: ${sessionId}`,
      `Confidence: ${session.confidence_score || 'N/A'}`,
      `Trigger: ${session.trigger_source || session.triggered_by}`,
      '',
      'Co-Authored-By: Claude Code <noreply@anthropic.com>',
    ].join('\n')

    git(['commit', '-m', commitMsg], repoPath)
    commitSha = git(['rev-parse', 'HEAD'], repoPath)

    await db`UPDATE cc_sessions SET commit_sha = ${commitSha} WHERE id = ${sessionId}`

    // Create deployment record
    const [deployment] = await db`
      INSERT INTO deployments (cc_session_id, codebase_id, commit_sha, branch, deploy_target, health_check_url, deploy_status)
      VALUES (${sessionId}, ${session.codebase_id}, ${commitSha}, ${branch}, ${deployTarget}, ${healthCheckUrl}, 'deploying')
      RETURNING *
    `
    deploymentId = deployment.id

    // 2. Git push
    git(['push', 'origin', branch], repoPath)

    // 3. Self-deployment: run migrations if new migration files were added
    const isSelfMod = !!(session.self_modification || session.context_bundle?.selfModification)
    if (isSelfMod) {
      try {
        const fs = require('fs')
        const migrationsDir = require('path').join(repoPath, 'src/db/migrations')
        if (fs.existsSync(migrationsDir)) {
          logger.info('Self-modification: checking for new migrations...')
          execFileSync('node', ['src/db/migrate.js'], { cwd: repoPath, encoding: 'utf-8', timeout: 30_000 })
          logger.info('Self-modification: migrations applied successfully')
        }
      } catch (err) {
        logger.warn('Self-modification: migration execution failed', { error: err.message })
        // Don't fail the deploy — migrations might not exist or already applied
      }
    }

    // 4. Deploy by target
    // For Python codebases, install dependencies before restarting
    if (deployTarget === 'pm2' && session.codebase_language === 'python') {
      const fs = require('fs')
      const path = require('path')
      const requirementsFile = path.join(repoPath, 'requirements.txt')
      if (fs.existsSync(requirementsFile)) {
        try {
          const venvPip = path.join(repoPath, '.venv', 'bin', 'pip')
          const pipBin = fs.existsSync(venvPip) ? venvPip : 'pip'
          execFileSync(pipBin, ['install', '-r', requirementsFile, '--quiet'], {
            cwd: repoPath, encoding: 'utf-8', timeout: 120_000,
          })
          logger.info(`Python dependencies installed for ${session.codebase_name}`)
        } catch (pipErr) {
          logger.warn(`pip install failed for ${session.codebase_name} — continuing`, { error: pipErr.message })
        }
      }
    }

    if (deployTarget === 'pm2' && pm2Name) {
      try {
        execFileSync('pm2', ['restart', pm2Name], { encoding: 'utf-8' })
      } catch (restartErr) {
        // Self-healing: if PM2 restart fails on self-modification, revert and try again
        if (isSelfMod) {
          logger.error(`Self-modification PM2 restart failed — self-healing: reverting and restarting`, { error: restartErr.message })
          try {
            git(['revert', '--no-edit', commitSha], repoPath)
            git(['push', 'origin', branch], repoPath)
            execFileSync('pm2', ['restart', pm2Name], { encoding: 'utf-8' })
            logger.info('Self-healing: reverted git changes and restarted PM2 successfully')

            // Record this as a failed deploy (self-healed)
            if (deploymentId) {
              await db`UPDATE deployments SET deploy_status = 'reverted', error_message = ${'Self-healed: PM2 restart failed, auto-reverted'}, reverted_at = now() WHERE id = ${deploymentId}`
            }
            await db`UPDATE cc_sessions SET deploy_status = 'reverted', pipeline_stage = 'failed' WHERE id = ${sessionId}`
            return { status: 'self_healed_revert', commitSha, reason: 'PM2 restart failed, auto-reverted' }
          } catch (healErr) {
            logger.error('CRITICAL: Self-healing also failed', { error: healErr.message })
            await db`
              INSERT INTO notifications (type, message, metadata)
              VALUES ('deployment_revert_failed', 'CRITICAL: Self-mod PM2 restart and self-heal both failed — manual intervention needed',
                      ${JSON.stringify({ sessionId, commitSha, deploymentId, error: healErr.message })})
            `.catch(() => {})
          }
        }
        throw restartErr
      }

      // Grace period before health check:
      // - Self-modifications: 30s (Node.js restart + potential migration)
      // - Python codebases: 15s (FastAPI/uvicorn startup time)
      // - Other: no wait
      if (isSelfMod) {
        await new Promise(r => setTimeout(r, 30_000))
      } else if (session.codebase_language === 'python') {
        await new Promise(r => setTimeout(r, 15_000))
      }
    }
    // Vercel deploys automatically on push — no action needed

    await db`UPDATE deployments SET deploy_status = 'health_check' WHERE id = ${deploymentId}`

    // 4. Health check
    if (healthCheckUrl) {
      const healthy = await runHealthCheck(healthCheckUrl)
      if (healthy) {
        await db`UPDATE deployments SET deploy_status = 'healthy', duration_ms = ${Date.now() - startTime} WHERE id = ${deploymentId}`
        await db`UPDATE cc_sessions SET deploy_status = 'deployed', pipeline_stage = 'complete' WHERE id = ${sessionId}`
        broadcastToSession(sessionId, 'cc:status', { status: 'deployed', commitSha })
      } else {
        // Auto-revert
        await revertDeployment(deploymentId, sessionId, repoPath, commitSha, branch, pm2Name, session.codebase_name)
        return { status: 'reverted', commitSha, reason: 'Health check failed' }
      }
    } else {
      // No health check URL — assume success
      await db`UPDATE deployments SET deploy_status = 'deployed', duration_ms = ${Date.now() - startTime} WHERE id = ${deploymentId}`
      await db`UPDATE cc_sessions SET deploy_status = 'deployed', pipeline_stage = 'complete' WHERE id = ${sessionId}`
      broadcastToSession(sessionId, 'cc:status', { status: 'deployed', commitSha })
    }

    // KG audit trail
    kgHooks.onDeploymentCompleted({
      deployment: { id: deploymentId, commit_sha: commitSha, deploy_status: 'deployed', deploy_target: deployTarget },
      codebaseName: session.codebase_name,
      sessionId,
    }).catch(() => {})

    // Notification
    await db`
      INSERT INTO notifications (type, message, link, metadata)
      VALUES ('deployment', ${'Deployed: ' + (session.initial_prompt || '').slice(0, 100)},
              ${null}, ${JSON.stringify({ sessionId, commitSha, codebaseName: session.codebase_name })})
    `

    logger.info(`Deployment successful: ${session.codebase_name} @ ${commitSha}`, { sessionId, deploymentId })
    return { status: 'deployed', commitSha, deploymentId }

  } catch (err) {
    logger.error(`Deployment failed for session ${sessionId}`, { error: err.message })

    if (deploymentId) {
      await db`UPDATE deployments SET deploy_status = 'failed', error_message = ${err.message}, duration_ms = ${Date.now() - startTime} WHERE id = ${deploymentId}`
    }
    await db`UPDATE cc_sessions SET deploy_status = 'failed', pipeline_stage = 'failed' WHERE id = ${sessionId}`
    broadcastToSession(sessionId, 'cc:status', { status: 'deploy_failed', error: err.message })

    throw err
  }
}

async function runHealthCheck(url) {
  for (let i = 0; i < HEALTH_CHECK_RETRIES; i++) {
    try {
      const res = await axios.get(url, { timeout: 10_000, maxRedirects: 0, validateStatus: () => true })
      if (res.status >= 200 && res.status < 300) return true
      logger.debug(`Health check returned ${res.status}`, { url })
    } catch (err) {
      logger.debug(`Health check request failed`, { url, error: err.message, attempt: i + 1 })
    }

    if (i < HEALTH_CHECK_RETRIES - 1) {
      await new Promise(r => setTimeout(r, HEALTH_CHECK_INTERVAL))
    }
  }
  return false
}

async function revertDeployment(deploymentId, sessionId, repoPath, commitSha, branch, pm2Name, codebaseName) {
  logger.warn(`Reverting deployment ${deploymentId}`, { commitSha })

  try {
    git(['revert', '--no-edit', commitSha], repoPath)
    const revertSha = git(['rev-parse', 'HEAD'], repoPath)
    git(['push', 'origin', branch], repoPath)

    if (pm2Name) {
      execFileSync('pm2', ['restart', pm2Name], { encoding: 'utf-8' })
    }

    await db`
      UPDATE deployments
      SET deploy_status = 'reverted', reverted_at = now(), revert_commit_sha = ${revertSha}
      WHERE id = ${deploymentId}
    `
    await db`UPDATE cc_sessions SET deploy_status = 'reverted', pipeline_stage = 'failed' WHERE id = ${sessionId}`
    broadcastToSession(sessionId, 'cc:status', { status: 'reverted', revertSha })

    // Notify
    await db`
      INSERT INTO notifications (type, message, metadata)
      VALUES ('deployment_reverted', 'Deployment auto-reverted due to health check failure',
              ${JSON.stringify({ sessionId, commitSha, revertSha, deploymentId })})
    `

    kgHooks.onDeploymentCompleted({
      deployment: { id: deploymentId, commit_sha: commitSha, deploy_status: 'reverted', deploy_target: 'revert', reverted_at: new Date() },
      codebaseName: codebaseName || 'unknown',
      sessionId,
    }).catch(() => {})

    logger.info(`Deployment reverted: ${revertSha}`, { sessionId, deploymentId })
  } catch (err) {
    logger.error(`Failed to revert deployment ${deploymentId}`, { error: err.message })
    await db`
      INSERT INTO notifications (type, message, metadata)
      VALUES ('deployment_revert_failed', 'CRITICAL: Auto-revert failed — manual intervention needed',
              ${JSON.stringify({ sessionId, commitSha, deploymentId, error: err.message })})
    `
  }
}

// ─── Revert by Session ID (used by symbridge rollback_request) ──────
// Finds the most recent successful deployment for a session and reverts it.

async function revertSession(sessionId) {
  const [session] = await db`
    SELECT cs.*, cb.repo_path, cb.name AS codebase_name, cb.meta
    FROM cc_sessions cs
    LEFT JOIN codebases cb ON cs.codebase_id = cb.id
    WHERE cs.id = ${sessionId}
  `
  if (!session) throw new Error(`Session ${sessionId} not found`)

  const [deployment] = await db`
    SELECT * FROM deployments
    WHERE cc_session_id = ${sessionId}
      AND deploy_status IN ('deployed', 'healthy')
    ORDER BY created_at DESC
    LIMIT 1
  `
  if (!deployment) throw new Error(`No deployed deployment found for session ${sessionId}`)

  const meta = session.meta || {}
  const branch = meta.branch || 'main'
  const pm2Name = meta.pm2_name || null
  const repoPath = session.repo_path || session.working_dir
  if (!repoPath) throw new Error('No repo path for revert')

  await revertDeployment(
    deployment.id,
    sessionId,
    repoPath,
    deployment.commit_sha,
    branch,
    pm2Name,
    session.codebase_name,
  )
}

module.exports = { deploySession, revertSession, runHealthCheck }
