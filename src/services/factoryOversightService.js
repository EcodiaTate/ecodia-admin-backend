const db = require('../config/db')
const logger = require('../config/logger')
const { broadcastToSession, broadcast } = require('../websocket/wsManager')
const { callDeepSeek } = require('./deepseekService')
const kgHooks = require('./kgIngestionHooks')

// ═══════════════════════════════════════════════════════════════════════
// FACTORY OVERSIGHT SERVICE
//
// Context-aware intelligence layer that supervises the entire
// CC → validate → deploy → monitor pipeline. Uses DeepSeek with full
// KG + codebase context to:
//
// 1. Review CC output before validation (sanity check)
// 2. Decide whether to auto-deploy or escalate to human
// 3. Monitor post-deploy health (Vercel deployment status, errors)
// 4. Report back to trigger source (Cortex, Thymos, Simula)
// 5. Generate follow-up actions if deploy fails
// ═══════════════════════════════════════════════════════════════════════

const CONFIDENCE_AUTO_DEPLOY_THRESHOLD = 0.7
const CONFIDENCE_ESCALATE_THRESHOLD = 0.4

// ─── Full Pipeline Orchestrator ─────────────────────────────────────

async function runPostSessionPipeline(sessionId) {
  const [session] = await db`
    SELECT cs.*, cb.name AS codebase_name, cb.repo_path, cb.meta AS codebase_meta
    FROM cc_sessions cs
    LEFT JOIN codebases cb ON cs.codebase_id = cb.id
    WHERE cs.id = ${sessionId}
  `

  if (!session) return
  if (session.status !== 'complete') {
    // CC failed — report back to trigger source
    await reportToTriggerSource(session, {
      success: false,
      stage: 'execution',
      error: session.error_message,
    })
    return
  }

  const filesChanged = session.files_changed || []
  if (filesChanged.length === 0) {
    logger.info(`Factory oversight: no files changed in session ${sessionId}`)
    await reportToTriggerSource(session, {
      success: true,
      stage: 'execution',
      message: 'CC completed but made no file changes',
    })
    return
  }

  // Step 1: DeepSeek review of changes
  const review = await reviewChanges(session, filesChanged)

  // Step 2: Validate (tests, lint, typecheck)
  let validation = null
  try {
    const validationService = require('./validationService')
    validation = await validationService.validateChanges(sessionId)
    broadcastToSession(sessionId, 'cc:stage', { stage: 'testing', progress: 0.6 })
  } catch (err) {
    logger.warn(`Validation failed for session ${sessionId}`, { error: err.message })
  }

  const confidence = validation?.confidence || 0
  const reviewApproved = review?.approved !== false

  // Step 3: Deploy decision
  if (confidence >= CONFIDENCE_AUTO_DEPLOY_THRESHOLD && reviewApproved) {
    // Auto-deploy
    logger.info(`Factory auto-deploying session ${sessionId} (confidence: ${confidence})`)
    try {
      const deploymentService = require('./deploymentService')
      const deployResult = await deploymentService.deploySession(sessionId)

      // Step 4: Post-deploy monitoring
      await monitorPostDeploy(session, deployResult)

      // Report success
      await reportToTriggerSource(session, {
        success: true,
        stage: 'deployed',
        commitSha: deployResult.commitSha,
        confidence,
        filesChanged,
      })
    } catch (err) {
      logger.error(`Factory deploy failed for session ${sessionId}`, { error: err.message })
      await reportToTriggerSource(session, {
        success: false,
        stage: 'deployment',
        error: err.message,
        confidence,
      })
      await generateFollowUp(session, 'deploy_failed', err.message)
    }
  } else if (confidence >= CONFIDENCE_ESCALATE_THRESHOLD) {
    // Needs human review
    logger.info(`Factory escalating session ${sessionId} to human review (confidence: ${confidence})`)
    await db`UPDATE cc_sessions SET pipeline_stage = 'testing', deploy_status = 'pending' WHERE id = ${sessionId}`

    await db`
      INSERT INTO notifications (type, message, link, metadata)
      VALUES ('factory_review', ${'Factory needs review: ' + (session.initial_prompt || '').slice(0, 100)},
              ${null}, ${JSON.stringify({
                sessionId, confidence, filesChanged,
                codebaseName: session.codebase_name,
                reviewNotes: review?.notes,
              })})
    `
    broadcast('notification', {
      type: 'factory_review',
      message: `CC session needs review (confidence: ${(confidence * 100).toFixed(0)}%)`,
      sessionId,
    })

    await reportToTriggerSource(session, {
      success: null,
      stage: 'awaiting_review',
      confidence,
      message: 'Changes require human review before deployment',
    })
  } else {
    // Too low confidence — reject
    logger.warn(`Factory rejecting session ${sessionId} (confidence: ${confidence})`)
    await db`UPDATE cc_sessions SET pipeline_stage = 'failed', deploy_status = 'failed' WHERE id = ${sessionId}`

    await reportToTriggerSource(session, {
      success: false,
      stage: 'validation',
      confidence,
      error: 'Validation confidence too low for deployment',
      validationDetails: {
        testPassed: validation?.testPassed,
        lintPassed: validation?.lintPassed,
        typecheckPassed: validation?.typecheckPassed,
      },
    })

    await generateFollowUp(session, 'low_confidence', `Confidence ${confidence} below threshold`)
  }
}

// ─── DeepSeek Change Review ─────────────────────────────────────────

async function reviewChanges(session, filesChanged) {
  try {
    const { execFileSync } = require('child_process')
    const cwd = session.repo_path || session.working_dir

    // Get the actual diff
    let diff = ''
    try {
      diff = execFileSync('git', ['diff'], { cwd, encoding: 'utf-8', maxBuffer: 5 * 1024 * 1024 })
    } catch {}

    if (!diff && filesChanged.length > 0) {
      try {
        diff = execFileSync('git', ['diff', '--cached'], { cwd, encoding: 'utf-8', maxBuffer: 5 * 1024 * 1024 })
      } catch {}
    }

    if (!diff) return { approved: true, notes: 'No diff available for review' }

    const response = await callDeepSeek({
      messages: [{
        role: 'user',
        content: `You are a code reviewer for the Ecodia Factory — an autonomous code system. Review this diff and assess:

1. Does this change accomplish the stated task?
2. Are there any obvious bugs, security issues, or regressions?
3. Is the code quality acceptable?
4. Should this be auto-deployed, or does it need human review?

Task: ${session.initial_prompt}
Codebase: ${session.codebase_name || 'unknown'}
Files changed: ${filesChanged.join(', ')}

Diff (truncated to 5000 chars):
${diff.slice(0, 5000)}

Respond with JSON:
{
  "approved": true/false,
  "confidence": 0.0-1.0,
  "notes": "brief assessment",
  "concerns": ["list of any concerns"],
  "accomplishes_task": true/false
}`,
      }],
      module: 'factory_oversight',
      contextQuery: session.initial_prompt,
    })

    try {
      const cleaned = response.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim()
      return JSON.parse(cleaned)
    } catch {
      return { approved: true, notes: response.slice(0, 200) }
    }
  } catch (err) {
    logger.debug('DeepSeek review failed (non-blocking)', { error: err.message })
    return { approved: true, notes: 'Review unavailable' }
  }
}

// ─── Post-Deploy Monitoring ─────────────────────────────────────────

async function monitorPostDeploy(session, deployResult) {
  const meta = session.codebase_meta || {}

  // Check Vercel deployment status if applicable
  if (meta.vercel_project_id || meta.deploy_target === 'vercel') {
    // Vercel auto-deploys on push — check deployment status after a delay
    setTimeout(async () => {
      try {
        await checkVercelDeployment(session, deployResult)
      } catch (err) {
        logger.debug('Vercel deployment check failed', { error: err.message })
      }
    }, 30_000) // Check after 30s (Vercel usually deploys in 30-60s)
  }

  // For PM2 services, the health check in deploymentService already handles it
}

async function checkVercelDeployment(session, deployResult) {
  // Check if the health URL is responding after Vercel deploy
  const meta = session.codebase_meta || {}
  const healthUrl = meta.health_check_url

  if (!healthUrl) return

  const deploymentService = require('./deploymentService')
  const healthy = await deploymentService.runHealthCheck(healthUrl)

  if (!healthy) {
    logger.error(`Post-deploy Vercel health check failed for ${session.codebase_name}`)

    await db`
      INSERT INTO notifications (type, message, metadata)
      VALUES ('deploy_health_failed',
              ${'Vercel deploy may have failed: ' + session.codebase_name},
              ${JSON.stringify({ sessionId: session.id, commitSha: deployResult.commitSha })})
    `

    // Notify via symbridge if triggered by organism
    if (session.trigger_source === 'simula_proposal' || session.trigger_source === 'thymos_incident') {
      const symbridge = require('./symbridgeService')
      await symbridge.send('factory_result', {
        session_id: session.id,
        status: 'deploy_health_failed',
        codebase_name: session.codebase_name,
        commit_sha: deployResult.commitSha,
      }, session.id)
    }
  }
}

// ─── Report to Trigger Source ───────────────────────────────────────

async function reportToTriggerSource(session, result) {
  // Always broadcast via WS for the UI
  broadcastToSession(session.id, 'cc:pipeline_result', result)

  // Report to Cortex conversation if triggered from there
  // (The frontend will pick this up from the WS broadcast)

  // Report to organism via symbridge if triggered by Simula/Thymos
  if (['simula_proposal', 'thymos_incident'].includes(session.trigger_source)) {
    try {
      const symbridge = require('./symbridgeService')
      await symbridge.send('factory_result', {
        session_id: session.id,
        status: result.success ? 'completed' : 'failed',
        stage: result.stage,
        error_message: result.error || null,
        files_changed: result.filesChanged || session.files_changed || [],
        commit_sha: result.commitSha || null,
        confidence_score: result.confidence || null,
        codebase_name: session.codebase_name,
        deploy_status: result.stage === 'deployed' ? 'deployed' : null,
      }, session.trigger_ref_id || session.id)
    } catch (err) {
      logger.debug('Failed to report to organism via symbridge', { error: err.message })
    }
  }
}

// ─── Follow-Up Generation ───────────────────────────────────────────

async function generateFollowUp(session, failureType, errorDetails) {
  try {
    const response = await callDeepSeek({
      messages: [{
        role: 'user',
        content: `A Factory CC session failed. Analyze and suggest next steps.

Task: ${session.initial_prompt}
Codebase: ${session.codebase_name || 'unknown'}
Failure type: ${failureType}
Error: ${errorDetails}
Trigger source: ${session.trigger_source}

Should we:
1. Retry with a modified approach?
2. Escalate to human?
3. File a task for later?
4. Something else?

Respond with JSON:
{
  "action": "retry|escalate|task|none",
  "retry_prompt": "modified prompt if retrying",
  "task_title": "task title if filing",
  "reasoning": "why this action"
}`,
      }],
      module: 'factory_oversight',
    })

    let followUp
    try {
      const cleaned = response.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim()
      followUp = JSON.parse(cleaned)
    } catch {
      return
    }

    if (followUp.action === 'retry' && followUp.retry_prompt) {
      logger.info(`Factory oversight: retrying session with modified prompt`)
      const triggers = require('./factoryTriggerService')
      await triggers.dispatchFromCortex(followUp.retry_prompt, {
        codebaseName: session.codebase_name,
      })
    } else if (followUp.action === 'task' && followUp.task_title) {
      await db`
        INSERT INTO tasks (title, description, source, source_ref_id, priority)
        VALUES (${followUp.task_title}, ${followUp.reasoning || errorDetails}, 'cc', ${session.id}, 'medium')
      `
    } else if (followUp.action === 'escalate') {
      await db`
        INSERT INTO notifications (type, message, metadata)
        VALUES ('factory_escalation', ${followUp.reasoning || 'Factory needs human intervention'},
                ${JSON.stringify({ sessionId: session.id, failureType, codebaseName: session.codebase_name })})
      `
    }
  } catch (err) {
    logger.debug('Follow-up generation failed', { error: err.message })
  }
}

module.exports = {
  runPostSessionPipeline,
  reviewChanges,
  monitorPostDeploy,
  reportToTriggerSource,
  generateFollowUp,
}
