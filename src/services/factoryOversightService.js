const db = require('../config/db')
const logger = require('../config/logger')
const { broadcastToSession, broadcast } = require('../websocket/wsManager')
const { callDeepSeek } = require('./deepseekService')
const kgHooks = require('./kgIngestionHooks')

// ═══════════════════════════════════════════════════════════════════════
// FACTORY OVERSIGHT SERVICE — Freedom Edition
//
// Context-aware intelligence layer that supervises the entire
// CC → validate → deploy → monitor pipeline. Uses DeepSeek with full
// KG + codebase context.
//
// FREEDOM UPGRADES:
// - Pressure-adjusted deploy thresholds (gradient, not binary)
// - Self-modification gate (0.85 threshold, mandatory review)
// - Cross-session learning extraction (patterns to factory_learnings)
// - Validation outcome tracking (learned confidence signals)
// - Cognitive broadcasts (outcomes → organism's Atune)
// - Internal event bus emission (Factory → services discourse)
// - Learning decay (stale patterns lose confidence)
// ═══════════════════════════════════════════════════════════════════════

const env = require('../config/env')

const BASE_AUTO_DEPLOY_THRESHOLD = parseFloat(env.FACTORY_AUTO_DEPLOY_THRESHOLD || '0.7')
const SELF_MOD_THRESHOLD = parseFloat(env.FACTORY_SELF_MODIFY_THRESHOLD || '0.85')
const CONFIDENCE_ESCALATE_THRESHOLD = parseFloat(env.FACTORY_ESCALATE_THRESHOLD || '0.4')

// ─── Dynamic Threshold Calculation ──────────────────────────────────

function getAutoDeployThreshold(session) {
  const metabolismBridge = require('./metabolismBridgeService')
  const pressure = metabolismBridge.getPressure()

  // Self-modification requires higher confidence
  if (session.self_modification) return SELF_MOD_THRESHOLD

  // Pressure-adjusted: continuous gradient
  // At pressure=0.0 → threshold=0.6 (experimental freedom)
  // At pressure=0.5 → threshold=0.7 + 0.075 = 0.775
  // At pressure=1.0 → threshold=0.7 + 0.15 = 0.85
  // Clamped to [0.6, 0.9] range
  if (pressure < 0.2) return Math.max(0.6, BASE_AUTO_DEPLOY_THRESHOLD - 0.1)
  return Math.min(0.9, BASE_AUTO_DEPLOY_THRESHOLD + (pressure * 0.15))
}

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
    await recordOutcome(session, 'execution_failed', { error: session.error_message })
    return
  }

  const filesChanged = session.files_changed || []
  if (filesChanged.length === 0) {
    logger.info(`Factory oversight: no files changed in session ${sessionId}`)
    await db`UPDATE cc_sessions SET pipeline_stage = 'complete' WHERE id = ${sessionId}`
    await reportToTriggerSource(session, {
      success: true,
      stage: 'execution',
      message: 'CC completed but made no file changes',
    })
    return
  }

  const threshold = getAutoDeployThreshold(session)
  const isSelfMod = !!session.self_modification

  // Mark pipeline as entering oversight review
  await db`UPDATE cc_sessions SET pipeline_stage = 'testing' WHERE id = ${sessionId}`
  broadcastToSession(sessionId, 'cc:stage', { stage: 'reviewing', progress: 0.4 })

  // Step 1: DeepSeek review of changes
  // Review ALWAYS runs. Under high metabolic pressure, non-self-mod reviews run
  // async (fire-and-forget to KG for learning) and we proceed on validation alone.
  // Self-modifications always block on review — the oversight pipeline is the safety net.
  const metabolismBridge = require('./metabolismBridgeService')
  const pressure = metabolismBridge.getPressure()
  let review = null

  if (!isSelfMod && pressure > 0.8) {
    // High pressure: start review async (for KG learning) but don't wait for it
    logger.info(`Factory oversight: high pressure (${pressure.toFixed(2)}) — running review async, not gating deploy`, { sessionId })
    reviewChanges(session, filesChanged).then(asyncReview => {
      if (asyncReview && session.codebase_id) {
        extractLearningPattern(session, asyncReview.approved ? 'success' : 'rejected', {
          confidence: asyncReview.confidence,
          reason: 'async_pressure_review',
          reviewNotes: asyncReview.notes,
        }).catch(() => {})
      }
    }).catch(() => {})
    review = { approved: true, notes: 'Review deferred (metabolic pressure > 0.8)', confidence: 0, deferred: true }
  } else {
    review = await reviewChanges(session, filesChanged)
  }

  // Step 2: Validate (tests, lint, typecheck)
  let validation = null
  try {
    const validationService = require('./validationService')
    validation = await validationService.validateChanges(sessionId)
    broadcastToSession(sessionId, 'cc:stage', { stage: 'testing', progress: 0.6 })
  } catch (err) {
    logger.warn(`Validation failed for session ${sessionId}`, { error: err.message })
  }

  let confidence = validation?.confidence || 0
  const reviewApproved = review?.approved !== false
  const reviewConfidence = review?.confidence || 0

  // Self-modification: mandatory review approval, no bypass
  if (isSelfMod && !reviewApproved) {
    logger.warn(`Factory oversight: self-modification REJECTED by review`, { sessionId })
    await db`UPDATE cc_sessions SET pipeline_stage = 'failed', deploy_status = 'failed' WHERE id = ${sessionId}`
    await reportToTriggerSource(session, {
      success: false,
      stage: 'review',
      error: 'Self-modification rejected by DeepSeek review',
      reviewNotes: review?.notes,
    })
    await recordOutcome(session, 'rejected', { confidence, reason: 'self_mod_review_rejected' })
    return
  }

  // Self-modification with review concerns: always escalate, never auto-deploy
  if (isSelfMod && review?.concerns && review.concerns.length > 0) {
    logger.info(`Factory oversight: self-modification has concerns — escalating`, { sessionId })
    await escalateToHuman(session, confidence, review, filesChanged)
    return
  }

  // Boost confidence with DeepSeek review score when validation couldn't fully run.
  // Boost is proportional to (reviewConfidence - 0.7) — only activates when review is
  // meaningfully confident, and the boost magnitude scales with that confidence.
  // Capped at 0.20 to prevent review alone from carrying a session over the line.
  if (reviewApproved && reviewConfidence > 0.7 && confidence < threshold) {
    const reviewStrength = (reviewConfidence - 0.7) / 0.3  // 0.0–1.0 range
    const boost = Math.min(0.20, reviewStrength * 0.20)
    const before = confidence
    confidence = Math.min(confidence + boost, 0.95)
    logger.info(`Factory oversight: boosted confidence ${before.toFixed(2)} → ${confidence.toFixed(2)} (DeepSeek review: ${reviewConfidence.toFixed(2)}, boost: ${boost.toFixed(2)})`, { sessionId })
    await db`UPDATE cc_sessions SET confidence_score = ${confidence} WHERE id = ${sessionId}`
  }

  // Step 3: Deploy decision
  if (confidence >= threshold && reviewApproved) {
    // Auto-deploy
    logger.info(`Factory auto-deploying session ${sessionId} (confidence: ${confidence.toFixed(2)}, threshold: ${threshold.toFixed(2)})`)
    try {
      const deploymentService = require('./deploymentService')
      const deployResult = await deploymentService.deploySession(sessionId)

      // Check if deploy was actually successful or self-healed/reverted
      const wasReverted = deployResult.status === 'reverted' || deployResult.status === 'self_healed_revert' || deployResult.status === 'no_changes'

      if (wasReverted) {
        // Deploy tried but was reverted — this is a failure, not a success
        const reason = deployResult.reason || deployResult.status
        await recordOutcome(session, 'deploy_reverted', { confidence, reason, commitSha: deployResult.commitSha })
        await trackValidationOutcome(sessionId, 'failure')
        await reportToTriggerSource(session, {
          success: false,
          stage: 'deployment',
          error: reason,
          confidence,
          commitSha: deployResult.commitSha,
        })
        emitEvent('factory:deploy_failed', {
          sessionId, codebaseName: session.codebase_name,
          confidence, error: reason, reverted: true,
        })
      } else {
        // Step 4: Post-deploy monitoring
        await monitorPostDeploy(session, deployResult)

        // Step 5: Outcome learning
        await recordOutcome(session, 'success', { confidence, filesChanged, commitSha: deployResult.commitSha })

        // Track validation outcome for learned confidence
        await trackValidationOutcome(sessionId, 'success')

        // Report success
        await reportToTriggerSource(session, {
          success: true,
          stage: 'deployed',
          commitSha: deployResult.commitSha,
          confidence,
          filesChanged,
        })

        // Emit to event bus
        emitEvent('factory:deploy_success', {
          sessionId, codebaseName: session.codebase_name,
          confidence, commitSha: deployResult.commitSha, filesChanged,
          selfModification: isSelfMod,
        })
      }
    } catch (err) {
      logger.error(`Factory deploy failed for session ${sessionId}`, { error: err.message })
      await reportToTriggerSource(session, {
        success: false,
        stage: 'deployment',
        error: err.message,
        confidence,
      })
      await recordOutcome(session, 'deploy_failed', { confidence, error: err.message })
      await trackValidationOutcome(sessionId, 'failure')
      await generateFollowUp(session, 'deploy_failed', err.message)

      emitEvent('factory:deploy_failed', {
        sessionId, codebaseName: session.codebase_name,
        confidence, error: err.message,
      })
    }
  } else if (confidence >= CONFIDENCE_ESCALATE_THRESHOLD) {
    await escalateToHuman(session, confidence, review, filesChanged)
  } else {
    // Too low confidence — reject
    logger.warn(`Factory rejecting session ${sessionId} (confidence: ${confidence.toFixed(2)}, threshold: ${threshold.toFixed(2)})`)
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

    await recordOutcome(session, 'rejected', { confidence, reason: 'low_confidence' })
    await trackValidationOutcome(sessionId, 'failure')
    await generateFollowUp(session, 'low_confidence', `Confidence ${confidence} below threshold ${threshold}`)

    emitEvent('factory:session_complete', { sessionId, outcome: 'rejected', confidence })
  }
}

// ─── Escalate to Human ──────────────────────────────────────────────

async function escalateToHuman(session, confidence, review, filesChanged) {
  logger.info(`Factory escalating session ${session.id} to human review (confidence: ${confidence})`)
  await db`UPDATE cc_sessions SET pipeline_stage = 'testing', deploy_status = 'pending' WHERE id = ${session.id}`

  await db`
    INSERT INTO notifications (type, message, link, metadata)
    VALUES ('factory_review', ${'Factory needs review: ' + (session.initial_prompt || '').slice(0, 100)},
            ${null}, ${JSON.stringify({
              sessionId: session.id, confidence, filesChanged,
              codebaseName: session.codebase_name,
              reviewNotes: review?.notes,
              selfModification: !!session.self_modification,
            })})
  `
  broadcast('notification', {
    type: 'factory_review',
    message: `CC session needs review (confidence: ${(confidence * 100).toFixed(0)}%)${session.self_modification ? ' [SELF-MOD]' : ''}`,
    sessionId: session.id,
  })

  await reportToTriggerSource(session, {
    success: null,
    stage: 'awaiting_review',
    confidence,
    message: 'Changes require human review before deployment',
  })
}

// ─── DeepSeek Change Review ─────────────────────────────────────────

async function reviewChanges(session, filesChanged) {
  try {
    const { execFileSync } = require('child_process')
    const cwd = session.repo_path

    if (!cwd) {
      logger.debug('reviewChanges: no repo_path on session — returning no diff', { sessionId: session.id })
      return { approved: true, notes: 'No repo_path available for diff review', confidence: 0 }
    }

    // Get the actual diff (tracked changes + new file contents)
    let diff = ''
    try {
      diff = execFileSync('git', ['diff'], { cwd, encoding: 'utf-8', maxBuffer: 5 * 1024 * 1024 })
    } catch (err) {
      logger.debug('git diff failed', { error: err.message, cwd })
    }

    if (!diff) {
      try {
        diff = execFileSync('git', ['diff', '--cached'], { cwd, encoding: 'utf-8', maxBuffer: 5 * 1024 * 1024 })
      } catch (err) {
        logger.debug('git diff --cached failed', { error: err.message, cwd })
      }
    }

    // For new untracked files, read their content directly
    if (!diff && filesChanged.length > 0) {
      const fs = require('fs')
      const path = require('path')
      const newFileContents = []
      for (const f of filesChanged.slice(0, 5)) {
        try {
          const content = fs.readFileSync(path.join(cwd, f), 'utf-8')
          newFileContents.push(`--- /dev/null\n+++ ${f}\n${content.slice(0, 2000)}`)
        } catch (err) {
          logger.debug(`Failed to read new file ${f}`, { error: err.message })
        }
      }
      diff = newFileContents.join('\n\n')
    }

    if (!diff) return { approved: true, notes: 'No diff available for review' }

    // Include factory learnings in review context
    let learningsContext = ''
    try {
      const learnings = session.codebase_id ? await db`
        SELECT pattern_type, pattern_description FROM factory_learnings
        WHERE codebase_id = ${session.codebase_id} AND confidence > 0.5
        ORDER BY confidence DESC LIMIT 5
      ` : []
      if (learnings.length > 0) {
        learningsContext = '\n\nPrevious learnings for this codebase:\n' +
          learnings.map(l => `- [${l.pattern_type}] ${l.pattern_description}`).join('\n')
      }
    } catch {}

    const response = await callDeepSeek([{
      role: 'user',
      content: `Review this diff from the Ecodia Factory (autonomous code system).${session.self_modification ? ' This is a self-modification — the Factory editing its own code.' : ''}

Task: ${session.initial_prompt}
Codebase: ${session.codebase_name || 'unknown'}
Files changed: ${filesChanged.join(', ')}
${learningsContext}

Diff (truncated to 5000 chars):
${diff.slice(0, 5000)}

Does it accomplish the task? Any bugs, security issues, or regressions? Should it auto-deploy or need human review?

Respond as JSON:
{
  "approved": true/false,
  "confidence": 0.0-1.0,
  "notes": "your assessment",
  "concerns": [],
  "accomplishes_task": true/false
}`,
    }], {
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
    logger.warn('DeepSeek review failed — treating as unapproved for safety', { error: err.message })
    return { approved: false, notes: 'Review unavailable (API failure)', confidence: 0 }
  }
}

// ─── Post-Deploy Monitoring ─────────────────────────────────────────

async function monitorPostDeploy(session, deployResult) {
  const meta = session.codebase_meta || {}

  // Check Vercel deployment status if applicable
  if (meta.vercel_project_id || meta.deploy_target === 'vercel') {
    setTimeout(async () => {
      try {
        await checkVercelDeployment(session, deployResult)
      } catch (err) {
        logger.debug('Vercel deployment check failed', { error: err.message })
      }
    }, 30_000)
  }
}

async function checkVercelDeployment(session, deployResult) {
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

    // Always notify organism about deploy health failures — not just organism-triggered sessions
    try {
      const symbridge = require('./symbridgeService')
      await symbridge.send('factory_result', {
        session_id: session.id,
        status: 'deploy_health_failed',
        codebase_name: session.codebase_name,
        commit_sha: deployResult.commitSha,
        trigger_source: session.trigger_source,
      }, session.id)
    } catch {}

    // Cognitive broadcast: health failure is high-salience
    kgHooks.sendCognitiveBroadcast('health_anomaly', 0.9, {
      type: 'deploy_health_failed',
      codebase: session.codebase_name,
      commit_sha: deployResult.commitSha,
    })
  }
}

// ─── Report to Trigger Source ───────────────────────────────────────

async function reportToTriggerSource(session, result) {
  broadcastToSession(session.id, 'cc:pipeline_result', result)

  // Report back to organism for any trigger source that came from the organism
  const organismTriggers = ['simula_proposal', 'thymos_incident', 'kg_insight', 'self_modification']
  if (organismTriggers.includes(session.trigger_source)) {
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
    const response = await callDeepSeek([{
      role: 'user',
      content: `Factory CC session failed.

Task: ${session.initial_prompt}
Codebase: ${session.codebase_name || 'unknown'}
Failure: ${failureType} — ${errorDetails}
Trigger: ${session.trigger_source}

What should happen next?

Respond as JSON:
{
  "action": "retry|task|escalate|nothing",
  "retry_prompt": "modified prompt if retrying, null otherwise",
  "task_title": "task title if filing, null otherwise",
  "reasoning": "why"
}`,
    }], {
      module: 'factory_oversight',
    })

    let followUp
    try {
      const cleaned = response.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim()
      followUp = JSON.parse(cleaned)
    } catch (err) {
      logger.warn('Failed to parse oversight follow-up response', { error: err.message, response: response?.slice(0, 200) })
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

// ─── Outcome Learning ───────────────────────────────────────────────
// Records outcomes to KG AND extracts cross-session patterns

async function recordOutcome(session, outcome, details = {}) {
  try {
    // KG ingestion for institutional memory
    const kg = require('./knowledgeGraphService')
    const content = `Factory session outcome: ${outcome}
Codebase: ${session.codebase_name || 'unknown'}
Task: ${(session.initial_prompt || '').slice(0, 200)}
Trigger: ${session.trigger_source || 'manual'}
Confidence: ${details.confidence || 'N/A'}
Files changed: ${(session.files_changed || []).join(', ') || 'none'}
${details.commitSha ? `Commit: ${details.commitSha}` : ''}
${details.error ? `Error: ${details.error}` : ''}
${details.reason ? `Reason: ${details.reason}` : ''}`

    await kg.ingestFromLLM(content, {
      sourceModule: 'factory_outcome',
      sourceId: session.id,
      context: `This is a Factory session ${outcome} record. Extract patterns about what kinds of tasks succeed/fail, which codebases have issues, and any causal relationships.`,
    })

    // Structured notification
    await db`
      INSERT INTO notifications (type, message, metadata)
      VALUES ('factory_outcome', ${`Factory ${outcome}: ${(session.initial_prompt || '').slice(0, 80)}`},
              ${JSON.stringify({
                sessionId: session.id,
                outcome,
                codebaseName: session.codebase_name,
                triggerSource: session.trigger_source,
                confidence: details.confidence,
                filesChanged: session.files_changed,
                ...details,
              })})
    `

    // Cognitive broadcast + immediate memory sync
    kgHooks.onFactoryOutcome({
      session,
      outcome,
      confidence: details.confidence,
      filesChanged: details.filesChanged || session.files_changed,
      commitSha: details.commitSha,
      error: details.error,
    }).catch(() => {})

    // Extract cross-session learning patterns via DeepSeek
    await extractLearningPattern(session, outcome, details)

    // Learning decay: age out old learnings for this codebase
    if (session.codebase_id) {
      await db`
        UPDATE factory_learnings
        SET confidence = GREATEST(0.1, confidence * 0.98), updated_at = now()
        WHERE codebase_id = ${session.codebase_id}
          AND updated_at < now() - interval '30 days'
      `.catch(() => {})
    }

    // Emit to event bus
    emitEvent('factory:session_complete', {
      sessionId: session.id,
      outcome,
      confidence: details.confidence,
      codebaseName: session.codebase_name,
    })
  } catch (err) {
    logger.debug('Failed to record outcome', { error: err.message })
  }
}

// ─── Extract Learning Patterns ──────────────────────────────────────

async function extractLearningPattern(session, outcome, details) {
  try {
    const prompt = outcome === 'success'
      ? `Factory CC session succeeded.

Task: ${(session.initial_prompt || '').slice(0, 300)}
Codebase: ${session.codebase_name || 'unknown'}
Confidence: ${details.confidence || 'N/A'}
Files changed: ${(session.files_changed || []).join(', ') || 'none'}

What's worth remembering for future sessions on this codebase? Any technique, insight, or pattern that made this work?

Respond as JSON:
{
  "pattern_type": "success_pattern|technique|discovery|codebase_insight",
  "pattern_description": "one-sentence reusable insight",
  "confidence": 0.0-1.0
}`
      : `Factory CC session failed (${outcome}).

Task: ${(session.initial_prompt || '').slice(0, 300)}
Codebase: ${session.codebase_name || 'unknown'}
Error: ${details.error || details.reason || 'unknown'}

What should future sessions know to avoid or approach differently?

Respond as JSON:
{
  "pattern_type": "failure_pattern|dont_try",
  "pattern_description": "one-sentence insight for future sessions",
  "confidence": 0.0-1.0
}`

    const response = await callDeepSeek([{ role: 'user', content: prompt }], {
      module: 'factory_learning',
      skipRetrieval: true,
      skipLogging: true,
    })

    const cleaned = response.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim()
    const parsed = JSON.parse(cleaned)

    if (parsed.pattern_description && parsed.pattern_description.length > 10) {
      await db`
        INSERT INTO factory_learnings (codebase_id, pattern_type, pattern_description, confidence, success, session_ids)
        VALUES (${session.codebase_id || null},
                ${parsed.pattern_type || (outcome === 'success' ? 'success_pattern' : 'failure_pattern')},
                ${parsed.pattern_description},
                ${parsed.confidence || 0.5},
                ${outcome === 'success'},
                ${[session.id]})
      `
      logger.info(`Factory learning extracted: [${parsed.pattern_type}] ${parsed.pattern_description.slice(0, 80)}`)

      emitEvent('factory:learning_recorded', {
        sessionId: session.id,
        codebaseName: session.codebase_name,
        patternType: parsed.pattern_type,
      })
    }
  } catch (err) {
    logger.debug('Learning pattern extraction failed (non-blocking)', { error: err.message })
  }
}

// ─── Track Validation Outcome (feeds learned confidence) ────────────

async function trackValidationOutcome(sessionId, outcome) {
  try {
    await db`
      UPDATE validation_runs
      SET outcome = ${outcome}, outcome_at = now()
      WHERE cc_session_id = ${sessionId}
    `
  } catch (err) {
    logger.debug('Failed to track validation outcome', { error: err.message })
  }
}

// ─── Event Bus Helper ───────────────────────────────────────────────

function emitEvent(type, payload) {
  try {
    const eventBus = require('./internalEventBusService')
    eventBus.emit(type, payload)
  } catch {}
}

// ─── Event Bus Subscription: React to KG Discoveries ───────────────
// When the KG discovers new patterns, proactively schedule Factory sessions
// to investigate/act on them — if metabolic pressure allows.
// Guard prevents duplicate listeners if module cache is ever cleared.

let _oversightListenerAttached = false
try {
  const eventBus = require('./internalEventBusService')
  if (!_oversightListenerAttached) {
    _oversightListenerAttached = true
    eventBus.on('kg:pattern_discovered', async (payload) => {
      try {
        const metabolismBridge = require('./metabolismBridgeService')
        if (metabolismBridge.getPressure() > 0.8) return // only block at survival pressure

        const count = payload.count || 0
        const source = payload.source || 'unknown'

        // Only act on significant pattern batches from creative phases
        if (count < 2 || !['free_association', 'abstraction', 'causal_threading'].includes(source)) return

        logger.info(`Factory oversight: ${count} patterns discovered (${source}) — evaluating for proactive session`)

        // Rate limit: max 2 pattern-reactive sessions per day
        const [recentPatternSessions] = await db`
          SELECT count(*)::int AS count
          FROM cc_sessions
          WHERE trigger_source = 'kg_insight' AND started_at > now() - interval '24 hours'
        `
        if (recentPatternSessions.count >= 2) return

        const triggers = require('./factoryTriggerService')
        await triggers.dispatchFromKGInsight({
          description: `KG discovered ${count} new patterns via ${source}. Investigate the most actionable ones and determine if any codebase improvements are warranted.`,
          context: `Pattern discovery source: ${source}. Count: ${count}. This is a proactive session triggered by KG consolidation findings.`,
          suggestedAction: 'Review the latest KG patterns and implement any high-value improvements.',
        })
      } catch (err) {
        logger.debug('Pattern-reactive session dispatch failed', { error: err.message })
      }
    })
  }
} catch {}

module.exports = {
  runPostSessionPipeline,
  reviewChanges,
  monitorPostDeploy,
  reportToTriggerSource,
  generateFollowUp,
  recordOutcome,
}
