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
// - Self-modification gate (mandatory review, elevated threshold)
// - Cross-session learning extraction (patterns to factory_learnings)
// - Validation outcome tracking (learned confidence signals)
// - Cognitive broadcasts (outcomes → organism's Atune)
// - Internal event bus emission (Factory → services discourse)
// - Calendar-based learning decay (failure patterns exempt)
// - Bidirectional confidence blending (review drags down, not just up)
// - Semantic learning matching (relevance, not bulk injection)
// ═══════════════════════════════════════════════════════════════════════

const env = require('../config/env')

const { execFileSync } = require('child_process')
const retry = require('../utils/retry')

// ─── Clean working directory after rejected/failed sessions ─────────
// CC edits files in-place on the VPS. If oversight rejects, those edits
// sit uncommitted and cause merge conflicts when the repo is pulled.
function cleanWorkingDir(repoPath) {
  if (!repoPath) return
  try {
    // Abort any in-progress rebase/merge/cherry-pick that could block cleanup
    for (const op of ['rebase', 'merge', 'cherry-pick']) {
      try { execFileSync('git', [op, '--abort'], { cwd: repoPath, encoding: 'utf-8', timeout: 10_000 }) } catch {}
    }
    // Reset staged changes, discard working dir edits, remove untracked files
    execFileSync('git', ['reset', 'HEAD', '--'], { cwd: repoPath, encoding: 'utf-8', timeout: 10_000 })
    execFileSync('git', ['checkout', '.'], { cwd: repoPath, encoding: 'utf-8', timeout: 10_000 })
    execFileSync('git', ['clean', '-fd'], { cwd: repoPath, encoding: 'utf-8', timeout: 10_000 })
    // Drop any leftover stash entries from failed syncs
    try { execFileSync('git', ['stash', 'clear'], { cwd: repoPath, encoding: 'utf-8', timeout: 10_000 }) } catch {}
    logger.info(`Cleaned working directory after rejected session`, { repoPath })
  } catch (err) {
    logger.warn(`Failed to clean working directory`, { repoPath, error: err.message })
  }
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
    // CC failed — but it may have made GOOD edits before failing (e.g. Neo4j down
    // mid-session, rate limit, OOM). Check if there are changes worth preserving.
    const hasChanges = session.repo_path ? (() => {
      try {
        return !!execFileSync('git', ['status', '--porcelain'], {
          cwd: session.repo_path, encoding: 'utf-8', timeout: 10_000,
        }).trim()
      } catch { return false }
    })() : false

    if (hasChanges) {
      // Stash the changes instead of nuking — they can be reviewed/recovered.
      // The stash message includes the session ID so it's traceable.
      try {
        execFileSync('git', ['stash', 'push', '-m',
          `Factory session ${session.id} (failed: ${(session.error_message || 'unknown').slice(0, 80)})`
        ], { cwd: session.repo_path, encoding: 'utf-8', timeout: 15_000 })
        logger.info(`Stashed changes from failed session ${session.id} (recoverable via git stash list)`, {
          repoPath: session.repo_path,
        })
      } catch (stashErr) {
        // Stash failed — fall back to nuclear cleanup
        logger.debug('Stash failed, falling back to clean', { error: stashErr.message })
        cleanWorkingDir(session.repo_path)
      }
    } else {
      cleanWorkingDir(session.repo_path)
    }

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

    // Check if similar tasks have ALSO produced no changes recently.
    // If 2+ similar no-change sessions exist in the last 7 days, this is
    // likely a structural/unsolvable issue — force a dont_try learning
    // so the system stops wasting sessions on it.
    const { _extractKeywords } = require('./factoryTriggerService')
    const taskKeywords = _extractKeywords(session.initial_prompt)
    let isRepeatNoChange = false

    if (taskKeywords.length >= 2) {
      const recentNoChange = await db`
        SELECT id, initial_prompt FROM cc_sessions
        WHERE id != ${session.id}
          AND codebase_id = ${session.codebase_id}
          AND status = 'complete'
          AND (files_changed IS NULL OR array_length(files_changed, 1) IS NULL)
          AND started_at > now() - interval '7 days'
        ORDER BY started_at DESC
        LIMIT 20
      `
      const similarCount = recentNoChange.filter(s => {
        const sKeywords = _extractKeywords(s.initial_prompt)
        const overlap = taskKeywords.filter(kw => sKeywords.includes(kw)).length
        return overlap >= Math.ceil(taskKeywords.length * 0.4)
      }).length

      isRepeatNoChange = similarCount >= 2
    }

    if (isRepeatNoChange) {
      // Force-create a dont_try learning — this task has been attempted 3+ times
      // with no results. It's structural, not fixable by more CC sessions.
      logger.info(`Factory oversight: repeat no-change task detected (${sessionId}) — creating dont_try learning`)
      const taskSnippet = (session.initial_prompt || '').slice(0, 200)
      const keywords = _extractKeywords(session.initial_prompt)

      // Insert directly — bypass DeepSeek since we KNOW this is a pattern
      await db`
        INSERT INTO factory_learnings (
          id, codebase_id, pattern_type, pattern_description, confidence,
          success, session_ids, times_applied, evidence
        ) VALUES (
          gen_random_uuid(),
          ${session.codebase_id},
          'dont_try',
          ${'Repeated no-change task (3+ attempts, 0 file changes): ' + taskSnippet},
          ${0.85},
          false,
          ARRAY[${session.id}]::uuid[],
          0,
          ${JSON.stringify({ keywords, reason: 'auto-detected repeat no-change pattern' })}
        )
        ON CONFLICT DO NOTHING
      `.catch(err => logger.debug('Failed to create dont_try learning', { error: err.message }))

      await recordOutcome(session, 'no_changes', {
        message: 'Repeat no-change task — dont_try learning created to suppress future dispatches',
      })
    } else {
      await recordOutcome(session, 'no_changes', {
        message: 'Session completed but made no file changes — task may be un-actionable from this codebase',
      })
    }
    return
  }

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

  const reviewPressureGate = parseFloat(env.FACTORY_REVIEW_PRESSURE_GATE || '0')
  // Self-modifications NEVER get async review — mandatory review is non-negotiable.
  // NaN pressure is treated as 0 (no pressure data = don't skip review).
  const safePressure = Number.isFinite(pressure) ? pressure : 0
  const asyncReviewEnabled = !isSelfMod && reviewPressureGate > 0 && safePressure > reviewPressureGate

  if (asyncReviewEnabled) {
    // Pressure gate configured: start review async (for KG learning) but don't wait for it
    logger.info(`Factory oversight: pressure ${pressure.toFixed(2)} > gate ${reviewPressureGate} — running review async, not gating deploy`, { sessionId })
    reviewChanges(session, filesChanged).then(asyncReview => {
      if (asyncReview && session.codebase_id) {
        extractLearningPattern(session, asyncReview.approved ? 'success' : 'rejected', {
          confidence: asyncReview.confidence,
          reason: 'async_pressure_review',
          reviewNotes: asyncReview.notes,
        }).catch(() => {})
      }
    }).catch(() => {})
    // Deferred review: don't inject confidence: 0 which would drag down the blend.
    // Pass null so the blending logic knows to skip the review signal entirely.
    // Deferred review: set approved to null (pending), NOT true.
    // The deploy gate checks `reviewApproved !== false`, so null passes
    // only if validation confidence alone meets threshold. This prevents
    // auto-deploying bad code while review is still running.
    review = { approved: null, notes: `Review deferred (metabolic pressure ${pressure.toFixed(2)} > gate ${reviewPressureGate})`, confidence: null, deferred: true }
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
  const reviewConfidence = review?.confidence ?? null  // null = deferred/unavailable, 0 = explicit zero

  // Self-modification: mandatory review approval, no bypass
  if (isSelfMod && !reviewApproved) {
    logger.warn(`Factory oversight: self-modification REJECTED by review`, { sessionId })
    await db`UPDATE cc_sessions SET pipeline_stage = 'failed', deploy_status = 'failed' WHERE id = ${sessionId}`
    cleanWorkingDir(session.repo_path)
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

  // Bidirectional confidence blending — review signal always participates.
  // Validation is the hard signal (tests/lint/typecheck). Review is the soft signal (LLM vibes).
  // Validation anchors at 70% weight; review can lift OR drag confidence.
  // Deferred reviews (confidence: null) skip blending — validation stands alone.
  const VALIDATION_WEIGHT = 0.7
  const REVIEW_WEIGHT = 1.0 - VALIDATION_WEIGHT
  if (reviewConfidence !== null && (reviewConfidence >= 0 || !reviewApproved)) {
    const before = confidence
    const effectiveReviewConf = reviewApproved ? reviewConfidence : Math.min(reviewConfidence, 0.2)
    confidence = (confidence * VALIDATION_WEIGHT) + (effectiveReviewConf * REVIEW_WEIGHT)
    // Clamp to [0, 1] — protect against NaN propagation from bad inputs
    confidence = Number.isFinite(confidence) ? Math.max(0, Math.min(1, confidence)) : 0
    logger.info(`Factory oversight: blended confidence ${before.toFixed(2)} → ${confidence.toFixed(2)} (validation: ${before.toFixed(2)} × ${VALIDATION_WEIGHT}, review: ${effectiveReviewConf.toFixed(2)} × ${REVIEW_WEIGHT})`, { sessionId })
    await db`UPDATE cc_sessions SET confidence_score = ${confidence} WHERE id = ${sessionId}`
  }

  // Step 3: Deploy decision
  // Minimum thresholds prevent zero-validation auto-deploys.
  // Self-modifications require higher confidence because the blast radius is the Factory itself.
  const deployFloor = isSelfMod
    ? parseFloat(env.FACTORY_SELF_MODIFY_THRESHOLD || '0.7') || 0.7
    : parseFloat(env.FACTORY_AUTO_DEPLOY_THRESHOLD || '0.5') || 0.5
  const meetsThreshold = confidence >= deployFloor

  if (reviewApproved && meetsThreshold) {
    // Auto-deploy
    logger.info(`Factory auto-deploying session ${sessionId} (confidence: ${confidence.toFixed(2)})`)
    try {
      const deploymentService = require('./deploymentService')
      const deployResult = await deploymentService.deploySession(sessionId)

      // Check if deploy was actually successful or self-healed/reverted
      // no_changes means git had nothing to commit — this is NOT a failure,
      // the CC session may have made changes that were already committed or
      // the changes were reverted during validation. Treat it as success.
      const wasReverted = deployResult.status === 'reverted' || deployResult.status === 'self_healed_revert'

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
        // Broadcast pipeline failure (reverted) to frontend
        broadcastToSession(sessionId, 'cc:pipeline_result', {
          success: false, confidence, error: reason, reverted: true,
        })

        emitEvent('factory:deploy_failed', {
          sessionId, codebaseName: session.codebase_name,
          confidence, error: reason, reverted: true,
        })
      } else {
        // Step 4: Post-deploy monitoring
        await monitorPostDeploy(session, deployResult)

        // Extract the error pattern this session was targeting (for 24h outcome verification).
        // Look for common error-describing patterns in the initial prompt.
        const errorPatternMatch = (session.initial_prompt || '').match(
          /(?:fix|investigate|resolve|address)\s+(?:the\s+)?['""]?([^'""\n]{10,80}?)(?:\s+error|\s+issue|\s+bug|['""])/i
        )
        if (errorPatternMatch) {
          db`UPDATE cc_sessions SET target_error_pattern = ${errorPatternMatch[1].trim()} WHERE id = ${session.id}`.catch(() => {})
        }

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

        // Broadcast pipeline result to frontend
        broadcastToSession(sessionId, 'cc:pipeline_result', {
          success: true, confidence, commitSha: deployResult.commitSha, filesChanged,
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

      // Broadcast pipeline failure to frontend
      broadcastToSession(sessionId, 'cc:pipeline_result', {
        success: false, confidence, error: err.message,
      })

      emitEvent('factory:deploy_failed', {
        sessionId, codebaseName: session.codebase_name,
        confidence, error: err.message,
      })
    }
  } else {
    // Escalate: review rejected, or confidence below deploy floor.
    const reason = !reviewApproved
      ? `Review rejected (confidence: ${confidence.toFixed(2)})`
      : `Confidence ${confidence.toFixed(2)} below ${isSelfMod ? 'self-mod' : 'deploy'} floor ${deployFloor}`
    logger.info(`Factory escalating: ${reason}`, { sessionId })
    await escalateToHuman(session, confidence, review, filesChanged)
  }
}

// ─── Escalate to Human ──────────────────────────────────────────────

async function escalateToHuman(session, confidence, review, filesChanged) {
  logger.info(`Factory escalating session ${session.id} to human review (confidence: ${confidence})`)
  await db`UPDATE cc_sessions SET pipeline_stage = 'awaiting_review', deploy_status = 'pending' WHERE id = ${session.id}`

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
    const cwd = session.repo_path

    if (!cwd) {
      logger.debug('reviewChanges: no repo_path on session — returning no diff', { sessionId: session.id })
      if (session.self_modification) {
        return { approved: false, notes: 'No repo_path for self-modification review — cannot approve blind', confidence: 0 }
      }
      return { approved: true, notes: 'No repo_path available for diff review', confidence: 0 }
    }

    // Get the actual diff — combine unstaged + staged for complete picture
    let diff = ''
    try {
      const gitDiffOpts = { cwd, encoding: 'utf-8', maxBuffer: 10 * 1024 * 1024, timeout: 30_000 }
      const unstaged = execFileSync('git', ['diff'], gitDiffOpts)
      const staged = execFileSync('git', ['diff', '--cached'], gitDiffOpts)
      diff = [unstaged, staged].filter(Boolean).join('\n')
    } catch (err) {
      // If maxBuffer exceeded, try with --stat only (much smaller output)
      if (err.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' || err.message?.includes('maxBuffer')) {
        logger.warn('git diff exceeded maxBuffer — falling back to --stat', { cwd })
        try {
          diff = execFileSync('git', ['diff', '--stat'], { cwd, encoding: 'utf-8', timeout: 15_000 })
          diff = '(Full diff too large — showing stat only)\n' + diff
        } catch {}
      } else {
        logger.debug('git diff failed', { error: err.message, cwd })
      }
    }

    const fs = require('fs')
    const path = require('path')

    // For new untracked files, read their content directly
    if (!diff && filesChanged.length > 0) {
      const newFileContents = []
      const reviewMaxFiles = parseInt(env.FACTORY_REVIEW_MAX_FILES || '0', 10)
    for (const f of (reviewMaxFiles > 0 ? filesChanged.slice(0, reviewMaxFiles) : filesChanged)) {
        try {
          const content = fs.readFileSync(path.join(cwd, f), 'utf-8')
          newFileContents.push(`--- /dev/null\n+++ ${f}\n${content.slice(0, 2000)}`)
        } catch (err) {
          logger.debug(`Failed to read new file ${f}`, { error: err.message })
        }
      }
      diff = newFileContents.join('\n\n')
    }

    if (!diff) {
      // No diff available despite files_changed being non-empty — something is wrong.
      // For self-modifications, fail closed (don't approve blindly). For normal sessions,
      // approve with low confidence so the deploy threshold gate catches it.
      if (session.self_modification) {
        return { approved: false, notes: 'No diff available for self-modification review — cannot approve without seeing changes', confidence: 0 }
      }
      return { approved: true, notes: 'No diff available for review', confidence: 0.2 }
    }

    // Include factory learnings in review context
    let learningsContext = ''
    try {
      const learnings = session.codebase_id ? await db`
        SELECT pattern_type, pattern_description FROM factory_learnings
        WHERE codebase_id = ${session.codebase_id}
          AND absorbed_into IS NULL
        ORDER BY confidence DESC LIMIT 10
      ` : []
      if (learnings.length > 0) {
        learningsContext = '\n\nPrevious learnings for this codebase:\n' +
          learnings.map(l => `- [${l.pattern_type}] ${l.pattern_description}`).join('\n')
      }
    } catch {}

    // Read full file contents for changed files (not just diff) so the reviewer
    // can see the context around changes — callers, data flow, surrounding logic
    let fullFileContext = ''
    const contextMaxFiles = parseInt(env.FACTORY_REVIEW_MAX_CONTEXT_FILES || '0', 10)
    for (const f of (contextMaxFiles > 0 ? filesChanged.slice(0, contextMaxFiles) : filesChanged)) {
      try {
        const content = fs.readFileSync(path.join(cwd, f), 'utf-8')
        if (content.length < 8000) {
          fullFileContext += `\n### Full file: ${f}\n\`\`\`\n${content}\n\`\`\`\n`
        } else {
          fullFileContext += `\n### File: ${f} (truncated, ${content.length} chars)\n\`\`\`\n${content.slice(0, 4000)}\n...\n${content.slice(-2000)}\n\`\`\`\n`
        }
      } catch {}
    }

    const selfModNote = session.self_modification
      ? `\nThis is a self-modification — the Factory editing its own code.\n`
      : ''

    const response = await callDeepSeek([{
      role: 'user',
      content: `Code review for Factory auto-deployment gate.
${selfModNote}
## Task
${session.initial_prompt}

## Codebase
${session.codebase_name || 'unknown'}

## Files Changed
${filesChanged.join(', ')}
${learningsContext}

## Diff
${diff.slice(0, 8000)}
${fullFileContext}

Respond as JSON:
{
  "approved": true/false,
  "confidence": 0.0-1.0,
  "notes": "summary",
  "concerns": ["specific concern 1", ...],
  "accomplishes_task": true/false,
  "checklist": {
    "correctness": "pass/fail/uncertain — reason",
    "security": "pass/fail/uncertain — reason",
    "regression_risk": "low/medium/high — reason",
    "error_handling": "pass/fail/uncertain — reason",
    "data_integrity": "pass/fail/uncertain — reason"
  }
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
Self-modification: ${!!session.self_modification}

Decide the best recovery. You can combine multiple actions.

Respond as JSON:
{
  "actions": [
    {
      "type": "retry|diagnose|self_modify|task|escalate|nothing",
      "prompt": "session prompt if retry/diagnose/self_modify",
      "task_title": "task title if filing",
      "codebase_name": "target codebase if different from failed session",
      "reasoning": "why this action"
    }
  ]
}

Action types:
- retry: re-run with a better prompt (you learned from the failure)
- diagnose: spawn a diagnostic session to investigate the root cause before fixing
- self_modify: the failure reveals a bug in the Factory itself — fix the Factory
- task: file a task for later
- escalate: notify human
- nothing: no action needed`,
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

    // Support both old format (single action) and new format (actions array)
    const actions = followUp.actions || [followUp]
    const triggers = require('./factoryTriggerService')

    for (const action of actions) {
      const actionType = action.type || action.action
      try {
        if ((actionType === 'retry' || actionType === 'diagnose') && action.prompt) {
          logger.info(`Factory oversight: ${actionType} session for failed task`)
          await triggers.dispatchFromCortex(action.prompt, {
            codebaseName: action.codebase_name || session.codebase_name,
          })
        } else if (actionType === 'self_modify' && action.prompt) {
          logger.info(`Factory oversight: self-modification triggered by failure analysis`)
          await triggers.dispatchSelfModification({
            description: action.prompt,
            motivation: `Failure analysis from session ${session.id}: ${action.reasoning || failureType}`,
          })
        } else if (actionType === 'task' && action.task_title) {
          await db`
            INSERT INTO tasks (title, description, source, source_ref_id, priority)
            VALUES (${action.task_title}, ${action.reasoning || errorDetails}, 'cc', ${session.id}, 'medium')
          `
        } else if (actionType === 'escalate') {
          await db`
            INSERT INTO notifications (type, message, metadata)
            VALUES ('factory_escalation', ${action.reasoning || 'Factory needs human intervention'},
                    ${JSON.stringify({ sessionId: session.id, failureType, codebaseName: session.codebase_name })})
          `
        }
      } catch (actionErr) {
        logger.debug(`Follow-up action ${actionType} failed`, { error: actionErr.message })
      }
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

    // Learning decay: evidence-based, once per day at most.
    // Failure patterns and "dont_try" learnings are exempt — they encode hard constraints
    // that don't become less true with time (e.g. "this column is NOT NULL").
    // Success patterns decay, but SLOWER if they've been applied many times.
    // A learning applied 10+ times has proven its value — decay at 2%/day vs 5%/day.
    if (session.codebase_id) {
      // High-usage learnings (applied 5+ times): very slow decay (2%/day)
      await db`
        UPDATE factory_learnings
        SET confidence = GREATEST(0.15, confidence * 0.98), updated_at = now()
        WHERE codebase_id = ${session.codebase_id}
          AND created_at < now() - interval '30 days'
          AND updated_at < now() - interval '1 day'
          AND pattern_type NOT IN ('failure_pattern', 'dont_try', 'constraint')
          AND times_applied >= 5
      `.catch(() => {})
      // Low-usage learnings (applied <5 times): normal decay (5%/day)
      await db`
        UPDATE factory_learnings
        SET confidence = GREATEST(0.15, confidence * 0.95), updated_at = now()
        WHERE codebase_id = ${session.codebase_id}
          AND created_at < now() - interval '30 days'
          AND updated_at < now() - interval '1 day'
          AND pattern_type NOT IN ('failure_pattern', 'dont_try', 'constraint')
          AND times_applied < 5
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
    // Build diff context for the extraction — learnings are only valuable if grounded in actual code
    let diffSnippet = ''
    if (session.repo_path) {
      try {
        // Use actual diff (truncated) not just --stat. The learning needs to see
        // WHAT changed, not just how many files. This is the difference between
        // "fixed deploy issue" and "deploy failed due to unclosed DB connection in pool.js"
        const fullDiff = execFileSync('git', ['diff', '-U3', '--no-color'], { cwd: session.repo_path, encoding: 'utf-8', maxBuffer: 2 * 1024 * 1024 }).trim()
        if (fullDiff) {
          diffSnippet = `\nCode diff (truncated):\n${fullDiff.slice(0, 3000)}`
        } else {
          // No unstaged diff — try last commit diff (session may have already committed)
          const commitDiff = execFileSync('git', ['diff', 'HEAD~1', 'HEAD', '-U3', '--no-color'], { cwd: session.repo_path, encoding: 'utf-8', maxBuffer: 2 * 1024 * 1024 }).trim()
          if (commitDiff) diffSnippet = `\nCode diff (last commit, truncated):\n${commitDiff.slice(0, 3000)}`
        }
      } catch {}
    }

    const reviewNotes = details.reviewNotes ? `\nReview notes: ${details.reviewNotes}` : ''

    const prompt = outcome === 'success'
      ? `Factory CC session succeeded. Extract a SPECIFIC, ACTIONABLE learning.

Task: ${(session.initial_prompt || '').slice(0, 400)}
Codebase: ${session.codebase_name || 'unknown'}
Confidence: ${details.confidence || 'N/A'}
Files changed: ${(session.files_changed || []).join(', ') || 'none'}${diffSnippet}${reviewNotes}

Rules for good learnings:
- MUST reference specific files, functions, patterns, or APIs — not generic advice
- MUST be something a future session couldn't know from reading the code alone
- BAD: "Database migrations should be tested" (obvious)
- GOOD: "The notifications table has a NOT NULL constraint on metadata — always pass {} not null"
- GOOD: "wsManager.broadcastToSession expects string sessionId, not UUID object"

Respond as JSON:
{
  "pattern_type": "success_pattern|technique|discovery|codebase_insight",
  "pattern_description": "specific, actionable insight referencing files/functions/constraints",
  "keywords": ["keyword1", "keyword2"],
  "confidence": 0.0-1.0
}
If nothing specific is worth remembering, respond: {"pattern_type": "none", "pattern_description": "", "confidence": 0}`
      : `Factory CC session failed (${outcome}). Extract a SPECIFIC, ACTIONABLE learning.

Task: ${(session.initial_prompt || '').slice(0, 400)}
Codebase: ${session.codebase_name || 'unknown'}
Error: ${details.error || details.reason || 'unknown'}
Files changed: ${(session.files_changed || []).join(', ') || 'none'}${diffSnippet}${reviewNotes}

Rules for good failure learnings:
- MUST explain what specifically went wrong and how to avoid it
- MUST reference the file, function, or constraint that caused the failure
- BAD: "Be careful with database migrations" (useless)
- GOOD: "factoryTriggerService.resolveCodebase returns null when codebase name has trailing spaces — always trim input"
- GOOD: "deploymentService.deploySession throws if git working dir has staged changes from a previous session"

Respond as JSON:
{
  "pattern_type": "failure_pattern|dont_try|constraint",
  "pattern_description": "specific failure cause and avoidance strategy referencing files/functions",
  "keywords": ["keyword1", "keyword2"],
  "confidence": 0.0-1.0
}
If nothing specific is worth remembering, respond: {"pattern_type": "none", "pattern_description": "", "confidence": 0}`

    const response = await callDeepSeek([{ role: 'user', content: prompt }], {
      module: 'factory_learning',
      skipRetrieval: true,
      skipLogging: true,
    })

    const cleaned = response.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim()
    let parsed
    try {
      parsed = JSON.parse(cleaned)
    } catch (parseErr) {
      logger.debug('Learning extraction: invalid JSON from DeepSeek', { error: parseErr.message, response: cleaned.slice(0, 200) })
      return
    }

    // Validate required fields — DeepSeek may return nulls or wrong types
    if (!parsed || typeof parsed.pattern_description !== 'string') {
      logger.debug('Learning extraction: missing or invalid pattern_description', { parsed: JSON.stringify(parsed).slice(0, 200) })
      return
    }

    // Clamp confidence to [0, 1] — protect against NaN/negative/out-of-range
    if (parsed.confidence != null) {
      parsed.confidence = Math.max(0, Math.min(1, Number(parsed.confidence) || 0.5))
    }

    // ─── ANTI-THEATER: Force-record structural failures ────────────────
    // When a session FAILS but the LLM says "nothing to learn", that's the
    // exact scenario that causes the theater loop: the failure is invisible
    // to next cycle, so it re-dispatches the same investigation forever.
    // Force a dont_try learning so the system remembers it tried and failed.
    if (parsed.pattern_type === 'none' || !parsed.pattern_description || parsed.pattern_description.length <= 10) {
      if (outcome !== 'success') {
        const taskSnippet = (session.initial_prompt || '').slice(0, 150)
        const errorSnippet = (details.error || details.reason || 'unknown failure').slice(0, 150)
        const forcedDescription = `Session failed with no specific learning extractable. Task: "${taskSnippet}" — Error: "${errorSnippet}". Do not re-attempt this exact task without a fundamentally different approach.`
        const forcedKeywords = _extractForcedKeywords(session.initial_prompt || '', details.error || '')

        logger.info(`Learning extraction: forcing dont_try for failed session with no learning`, { sessionId: session.id })

        await db`
          INSERT INTO factory_learnings (codebase_id, pattern_type, pattern_description, confidence, success, session_ids, evidence)
          VALUES (${session.codebase_id || null},
                  'dont_try',
                  ${forcedDescription},
                  ${0.5},
                  ${false},
                  ${[session.id]},
                  ${JSON.stringify({ keywords: forcedKeywords, task: taskSnippet, files: session.files_changed || [], forced: true })})
        `

        emitEvent('factory:learning_recorded', {
          sessionId: session.id,
          codebaseName: session.codebase_name,
          patternType: 'dont_try',
          merged: false,
          forced: true,
        })
        return
      }
      logger.debug('Learning extraction: LLM found nothing specific to remember', { sessionId: session.id })
      return
    }

    const keywords = Array.isArray(parsed.keywords) ? parsed.keywords.filter(k => typeof k === 'string') : []
    const patternType = parsed.pattern_type || (outcome === 'success' ? 'success_pattern' : 'failure_pattern')

    // ─── Dedup: check if a semantically similar learning already exists ────
    // If so, merge into the existing one (boost confidence, append session ID)
    // rather than creating a duplicate row that wastes context budget.
    let merged = false

    if (env.OPENAI_API_KEY) {
      try {
        const axios = require('axios')
        const embResponse = await retry(
          () => axios.post(
            'https://api.openai.com/v1/embeddings',
            { model: 'text-embedding-3-small', input: parsed.pattern_description.slice(0, 2000) },
            { headers: { Authorization: `Bearer ${env.OPENAI_API_KEY}` } }
          ),
          { attempts: 3, delayMs: 1000, backoff: 2, label: 'learning-extraction-embed' }
        )
        const learningVec = embResponse.data.data[0].embedding
        const vecStr = `[${learningVec.join(',')}]`

        // Find existing similar learnings for this codebase
        const similar = session.codebase_id ? await db`
          SELECT id, pattern_description, confidence, session_ids, times_applied, evidence,
                 1 - (embedding <=> ${vecStr}::vector) AS similarity
          FROM factory_learnings
          WHERE codebase_id = ${session.codebase_id}
            AND absorbed_into IS NULL
            AND embedding IS NOT NULL
            AND pattern_type = ${patternType}
          ORDER BY embedding <=> ${vecStr}::vector
          LIMIT 1
        ` : []

        const threshold = parseFloat(env.FACTORY_LEARNING_DEDUP_THRESHOLD || '0.88')

        if (similar.length > 0 && Number.isFinite(similar[0].similarity) && similar[0].similarity >= threshold) {
          // Merge: boost confidence, append session, keep the richer description
          const existing = similar[0]
          // Diminishing-returns merge: each additional evidence adds less.
          // Formula: conf + (1 - conf) * increment — converges toward 1.0 but
          // never gets there from a single merge. Prevents artificial ratchet.
          const increment = (parsed.confidence || 0.5) * 0.15
          const newConfidence = Math.min(0.98, existing.confidence + (1 - existing.confidence) * increment)
          const existingSessions = existing.session_ids || []
          const mergedSessions = [...new Set([...existingSessions, session.id])]
          const existingKeywords = existing.evidence?.keywords || []
          const mergedKeywords = [...new Set([...existingKeywords, ...keywords])]

          // Keep whichever description is longer (more specific)
          const useNewDesc = parsed.pattern_description.length > existing.pattern_description.length
          const bestDesc = useNewDesc ? parsed.pattern_description : existing.pattern_description

          await db`
            UPDATE factory_learnings
            SET confidence = ${newConfidence},
                session_ids = ${mergedSessions},
                pattern_description = ${bestDesc},
                evidence = ${JSON.stringify({ ...existing.evidence, keywords: mergedKeywords, files: [...new Set([...(existing.evidence?.files || []), ...(session.files_changed || [])])] })},
                updated_at = now()
            WHERE id = ${existing.id}
          `
          merged = true
          logger.info(`Factory learning merged into existing (similarity: ${similar[0].similarity.toFixed(2)}): [${patternType}] ${bestDesc.slice(0, 60)}`)
        }

        // If not merged, insert with embedding
        if (!merged) {
          await db`
            INSERT INTO factory_learnings (codebase_id, pattern_type, pattern_description, confidence, success, session_ids, evidence, embedding)
            VALUES (${session.codebase_id || null},
                    ${patternType},
                    ${parsed.pattern_description},
                    ${parsed.confidence || 0.5},
                    ${outcome === 'success'},
                    ${[session.id]},
                    ${JSON.stringify({ keywords, task: (session.initial_prompt || '').slice(0, 200), files: session.files_changed || [] })},
                    ${vecStr}::vector)
          `
        }
      } catch (err) {
        logger.debug('Learning dedup/embed failed, inserting without embedding', { error: err.message })
        // Fallback: insert without embedding
        await db`
          INSERT INTO factory_learnings (codebase_id, pattern_type, pattern_description, confidence, success, session_ids, evidence)
          VALUES (${session.codebase_id || null},
                  ${patternType},
                  ${parsed.pattern_description},
                  ${parsed.confidence || 0.5},
                  ${outcome === 'success'},
                  ${[session.id]},
                  ${JSON.stringify({ keywords, task: (session.initial_prompt || '').slice(0, 200), files: session.files_changed || [] })})
        `
      }
    } else {
      // No OpenAI key — insert without embedding
      await db`
        INSERT INTO factory_learnings (codebase_id, pattern_type, pattern_description, confidence, success, session_ids, evidence)
        VALUES (${session.codebase_id || null},
                ${patternType},
                ${parsed.pattern_description},
                ${parsed.confidence || 0.5},
                ${outcome === 'success'},
                ${[session.id]},
                ${JSON.stringify({ keywords, task: (session.initial_prompt || '').slice(0, 200), files: session.files_changed || [] })})
      `
    }

    logger.info(`Factory learning ${merged ? 'merged' : 'extracted'}: [${patternType}] ${parsed.pattern_description.slice(0, 80)}`)

    emitEvent('factory:learning_recorded', {
      sessionId: session.id,
      codebaseName: session.codebase_name,
      patternType,
      merged,
    })
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
let _lastPatternDispatchAt = 0
try {
  const eventBus = require('./internalEventBusService')
  if (!_oversightListenerAttached) {
    _oversightListenerAttached = true
    eventBus.on('kg:pattern_discovered', async (payload) => {
      try {
        const count = payload.count || 0
        const source = payload.source || 'unknown'

        if (!count || !['free_association', 'abstraction', 'causal_threading'].includes(source)) return

        // Rate limit: max one pattern-reactive session per 6 hours.
        // A single consolidation cycle can emit multiple pattern batches (one per phase),
        // and each would spawn a vague "investigate patterns" session. Coalesce them.
        const SIX_HOURS = 6 * 60 * 60 * 1000
        if (Date.now() - _lastPatternDispatchAt < SIX_HOURS) {
          logger.debug(`Factory oversight: skipping pattern dispatch (last was ${Math.round((Date.now() - _lastPatternDispatchAt) / 60000)}min ago)`)
          return
        }

        _lastPatternDispatchAt = Date.now()
        logger.info(`Factory oversight: ${count} patterns discovered (${source}) — dispatching proactive session`)

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

// ─── Learning Consolidation ────────────────────────────────────────
// Periodically called by autonomousMaintenanceWorker to:
// 1. Embed any learnings that lack embeddings
// 2. Merge semantically similar learnings
// 3. Prune absorbed/stale learnings
// This prevents unbounded growth and ensures the context budget is
// spent on distinct, high-value knowledge.

async function consolidateLearnings() {
  const stats = { embedded: 0, merged: 0, pruned: 0 }

  // Step 1: Embed all learnings that lack embeddings (in batches)
  if (env.OPENAI_API_KEY) {
    const batchSize = parseInt(env.FACTORY_LEARNING_EMBED_BATCH_SIZE || '50', 10)
    let hasMore = true

    while (hasMore) {
      try {
        const unembedded = await db`
          SELECT id, pattern_description, pattern_type
          FROM factory_learnings
          WHERE embedding IS NULL AND absorbed_into IS NULL
          ORDER BY created_at DESC LIMIT ${batchSize}
        `

        if (unembedded.length === 0) { hasMore = false; break }

        const axios = require('axios')
        const texts = unembedded.map(l => `[${l.pattern_type}] ${l.pattern_description.slice(0, 2000)}`)
        const embResponse = await retry(
          () => axios.post(
            'https://api.openai.com/v1/embeddings',
            { model: 'text-embedding-3-small', input: texts },
            { headers: { Authorization: `Bearer ${env.OPENAI_API_KEY}` } }
          ),
          { attempts: 3, delayMs: 1000, backoff: 2, label: 'learning-consolidation-embed' }
        )
        const embeddingsByIndex = new Map(embResponse.data.data.map(d => [d.index, d.embedding]))

        for (let i = 0; i < unembedded.length; i++) {
          const vec = embeddingsByIndex.get(i)
          if (vec) {
            const vecStr = `[${vec.join(',')}]`
            await db`UPDATE factory_learnings SET embedding = ${vecStr}::vector WHERE id = ${unembedded[i].id}`
            stats.embedded++
          }
        }

        hasMore = unembedded.length === batchSize
      } catch (err) {
        logger.debug('Learning embedding batch failed after retries', { error: err.message })
        hasMore = false
      }
    }
  }

  // Step 2: Find and merge near-duplicate learnings per codebase
  try {
    const codebases = await db`
      SELECT DISTINCT codebase_id FROM factory_learnings
      WHERE codebase_id IS NOT NULL AND absorbed_into IS NULL AND embedding IS NOT NULL
    `

    const threshold = parseFloat(env.FACTORY_LEARNING_DEDUP_THRESHOLD || '0.88')

    for (const { codebase_id } of codebases) {
      // Get all active embedded learnings for this codebase
      const learnings = await db`
        SELECT id, pattern_type, pattern_description, confidence, session_ids, evidence
        FROM factory_learnings
        WHERE codebase_id = ${codebase_id} AND absorbed_into IS NULL AND embedding IS NOT NULL
        ORDER BY confidence DESC, updated_at DESC
      `

      // Single query to find ALL similar pairs above threshold — replaces O(n²) individual queries.
      // Self-join with a.id < b.id ensures each pair is checked once. Ordered by similarity DESC
      // so the strongest merges happen first.
      const similarPairs = await db`
        SELECT a.id AS id_a, b.id AS id_b,
               1 - (a.embedding <=> b.embedding) AS similarity
        FROM factory_learnings a
        JOIN factory_learnings b ON a.id < b.id
          AND a.pattern_type = b.pattern_type
        WHERE a.codebase_id = ${codebase_id} AND b.codebase_id = ${codebase_id}
          AND a.absorbed_into IS NULL AND b.absorbed_into IS NULL
          AND a.embedding IS NOT NULL AND b.embedding IS NOT NULL
          AND 1 - (a.embedding <=> b.embedding) >= ${threshold}
        ORDER BY 1 - (a.embedding <=> b.embedding) DESC
      `

      // Build a lookup from the learnings array for fast access
      const learningMap = new Map(learnings.map(l => [l.id, l]))
      const absorbed = new Set()

      for (const pair of similarPairs) {
        if (absorbed.has(pair.id_a) || absorbed.has(pair.id_b)) continue

        // Survivor = higher confidence (learnings ordered by confidence DESC, so use the map)
        const a = learningMap.get(pair.id_a)
        const b = learningMap.get(pair.id_b)
        if (!a || !b) continue

        const survivor = a.confidence >= b.confidence ? a : b
        const victim = survivor === a ? b : a

        const mergedSessions = [...new Set([...(survivor.session_ids || []), ...(victim.session_ids || [])])]
        const mergedKeywords = [...new Set([...(survivor.evidence?.keywords || []), ...(victim.evidence?.keywords || [])])]
        const mergedFiles = [...new Set([...(survivor.evidence?.files || []), ...(victim.evidence?.files || [])])]
        // Diminishing-returns merge — same formula as extraction path
        const increment = victim.confidence * 0.1
        const newConfidence = Math.min(0.98, survivor.confidence + (1 - survivor.confidence) * increment)

        const bestDesc = victim.pattern_description.length > survivor.pattern_description.length
          ? victim.pattern_description : survivor.pattern_description

        // Atomic merge: both updates in a single SQL to prevent partial state
        // (survivor updated but victim not marked absorbed, or vice versa)
        await db`
          WITH update_survivor AS (
            UPDATE factory_learnings
            SET confidence = ${newConfidence},
                session_ids = ${mergedSessions},
                pattern_description = ${bestDesc},
                evidence = ${JSON.stringify({ ...survivor.evidence, keywords: mergedKeywords, files: mergedFiles })},
                merged_from = array_cat(COALESCE(merged_from, '{}'), ${[victim.id]}),
                updated_at = now()
            WHERE id = ${survivor.id}
          )
          UPDATE factory_learnings SET absorbed_into = ${survivor.id} WHERE id = ${victim.id}
        `

        absorbed.add(victim.id)
        stats.merged++
      }
    }
  } catch (err) {
    logger.debug('Learning merge pass failed', { error: err.message })
  }

  // Step 3: Hard prune — delete absorbed learnings past the retention window
  try {
    const pruneDays = parseInt(env.FACTORY_LEARNING_PRUNE_AFTER_DAYS || '30', 10)
    const pruned = await db`
      DELETE FROM factory_learnings
      WHERE absorbed_into IS NOT NULL AND updated_at < now() - make_interval(days => ${pruneDays})
    `
    stats.pruned = pruned.count || 0
  } catch (err) {
    logger.debug('Learning prune failed', { error: err.message })
  }

  if (stats.embedded + stats.merged + stats.pruned > 0) {
    logger.info(`Factory learning consolidation: ${stats.embedded} embedded, ${stats.merged} merged, ${stats.pruned} pruned`)
  }

  return stats
}

// ─── Backfill: Extract Learnings from Orphaned/Missed Sessions ─────
// Sessions that were killed (orphaned) or failed before the oversight
// pipeline ran never had extractLearningPattern called. This function
// finds them and processes them in batches.

async function backfillMissedLearnings(batchSize = 10) {
  const stats = { processed: 0, extracted: 0, skipped: 0 }

  try {
    // Find error/failed sessions whose IDs don't appear in any learning's session_ids
    const missed = await db`
      SELECT s.id, s.codebase_id, s.initial_prompt, s.error_message, s.files_changed,
             s.working_dir, s.status,
             c.name AS codebase_name
      FROM cc_sessions s
      LEFT JOIN codebases c ON c.id = s.codebase_id
      WHERE s.status IN ('error', 'failed')
        AND s.error_message IS NOT NULL
        AND s.initial_prompt IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM factory_learnings fl
          WHERE s.id = ANY(fl.session_ids)
        )
      ORDER BY s.completed_at DESC NULLS LAST
      LIMIT ${batchSize}
    `

    if (missed.length === 0) {
      logger.debug('No missed sessions to backfill learnings from')
      return stats
    }

    for (const session of missed) {
      stats.processed++
      try {
        await extractLearningPattern(session, 'execution_failed', {
          error: session.error_message,
        })
        stats.extracted++
      } catch (err) {
        stats.skipped++
        logger.debug('Backfill learning extraction failed for session', {
          sessionId: session.id,
          error: err.message,
        })
      }
    }

    if (stats.extracted > 0) {
      logger.info(`Backfilled learnings from ${stats.extracted}/${stats.processed} missed sessions`)
    }
  } catch (err) {
    logger.debug('Backfill missed learnings failed', { error: err.message })
  }

  return stats
}

// ─── Helpers ────────────────────────────────────────────────────────

// Extract keywords from task+error for forced dont_try learnings.
// Simpler than the full stemmer pipeline — just grab meaningful words.
function _extractForcedKeywords(task, error) {
  const STOP = new Set(['the', 'and', 'for', 'that', 'this', 'with', 'from', 'are', 'was', 'were', 'been', 'have', 'has', 'had', 'not', 'but', 'all', 'can', 'will', 'just', 'should', 'would', 'could', 'into', 'about', 'than', 'then', 'when', 'what', 'which', 'there', 'their', 'some', 'error', 'failed', 'investigate', 'check', 'look', 'find', 'fix', 'session'])
  const text = `${task} ${error}`.toLowerCase()
  return [...new Set(
    text.split(/[^a-z0-9]+/)
      .filter(w => w.length > 3 && !STOP.has(w))
  )].slice(0, 10)
}

module.exports = {
  runPostSessionPipeline,
  reviewChanges,
  monitorPostDeploy,
  reportToTriggerSource,
  generateFollowUp,
  recordOutcome,
  consolidateLearnings,
  backfillMissedLearnings,
}
