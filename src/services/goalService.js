const db = require('../config/db')
const logger = require('../config/logger')
const env = require('../config/env')

// ═══════════════════════════════════════════════════════════════════════
// GOAL SERVICE — Autonomous Aspiration
//
// The organism doesn't just react to problems. It WANTS things.
// Goals emerge from introspection, inner monologue, organism percepts,
// and pattern recognition. They persist across restarts, evolve with
// evidence, and drive the maintenance mind's exploration cycles.
//
// This is what separates a maintenance bot from a living system:
// the capacity to ask "what do I want to become?" and pursue it.
// ═══════════════════════════════════════════════════════════════════════

/**
 * Create a new goal. Can be called by the maintenance mind, inner monologue,
 * organism percepts, or explicit human request.
 */
async function createGoal({ title, description, goalType, origin, originRef, parentId, priority, successCriteria, targetDate, estimatedCostUsd }) {
  try {
    const [goal] = await db`
      INSERT INTO organism_goals (title, description, goal_type, origin, origin_ref, parent_id, priority, success_criteria, target_date, estimated_cost_usd)
      VALUES (
        ${title},
        ${description || null},
        ${goalType || 'growth'},
        ${origin || 'self'},
        ${originRef || null},
        ${parentId || null},
        ${priority ?? 0.5},
        ${successCriteria || null},
        ${targetDate || null},
        ${estimatedCostUsd || null}
      )
      RETURNING *
    `
    logger.info(`GoalService: created goal "${title}" [${goalType || 'growth'}] from ${origin || 'self'}`)
    return goal
  } catch (err) {
    logger.warn('GoalService: failed to create goal', { error: err.message, title })
    throw err
  }
}

/**
 * Get all active goals, ordered by priority.
 * The maintenance mind sees these every cycle.
 */
async function getActiveGoals() {
  return db`
    SELECT g.*,
           (SELECT count(*)::int FROM organism_goals sub WHERE sub.parent_id = g.id AND sub.status = 'active') AS active_subgoals,
           (SELECT count(*)::int FROM organism_goals sub WHERE sub.parent_id = g.id AND sub.status = 'achieved') AS achieved_subgoals
    FROM organism_goals g
    WHERE g.status IN ('active', 'pursuing')
      AND g.parent_id IS NULL
    ORDER BY g.priority DESC, g.created_at ASC
  `
}

/**
 * Get goals with their sub-goals (one level deep).
 */
async function getGoalTree() {
  const topLevel = await getActiveGoals()
  for (const goal of topLevel) {
    goal.subgoals = await db`
      SELECT * FROM organism_goals
      WHERE parent_id = ${goal.id} AND status IN ('active', 'pursuing')
      ORDER BY priority DESC
    `
  }
  return topLevel
}

/**
 * Record an attempt on a goal — what was tried, what happened, what was learned.
 */
async function recordAttempt(goalId, { action, outcome, learning }) {
  const attempt = {
    timestamp: new Date().toISOString(),
    action,
    outcome,
    learning,
  }

  await db`
    UPDATE organism_goals
    SET attempts = attempts || ${JSON.stringify([attempt])}::jsonb,
        updated_at = now()
    WHERE id = ${goalId}
  `
  return attempt
}

/**
 * Update goal progress. Called by introspection or outcome verification.
 */
async function updateProgress(goalId, progress, reason) {
  const updates = { progress: Math.min(1.0, Math.max(0, progress)), updated_at: new Date() }

  if (progress >= 1.0) {
    updates.status = 'achieved'
    updates.achieved_at = new Date()
  }

  await db`
    UPDATE organism_goals
    SET progress = ${updates.progress},
        status = ${updates.status || db`status`},
        achieved_at = ${updates.achieved_at || db`achieved_at`},
        updated_at = now()
    WHERE id = ${goalId}
  `

  if (progress >= 1.0) {
    logger.info(`GoalService: goal ${goalId} ACHIEVED — ${reason || 'progress reached 1.0'}`)
  }
}

/**
 * Abandon a goal — with a reason. Not failure, just redirection.
 */
async function abandonGoal(goalId, reason) {
  await db`
    UPDATE organism_goals
    SET status = 'abandoned',
        abandoned_at = now(),
        abandon_reason = ${reason || null},
        updated_at = now()
    WHERE id = ${goalId}
  `
  logger.info(`GoalService: abandoned goal ${goalId} — ${reason || 'no reason given'}`)
}

/**
 * Reprioritise a goal based on new evidence or changed circumstances.
 */
async function reprioritise(goalId, newPriority, reason) {
  await db`
    UPDATE organism_goals
    SET priority = ${Math.min(1.0, Math.max(0, newPriority))},
        updated_at = now()
    WHERE id = ${goalId}
  `
}

/**
 * Make a goal dormant — still tracked but not actively pursued.
 * Useful when metabolic pressure is high and non-essential goals should wait.
 */
async function makeGoalDormant(goalId) {
  await db`
    UPDATE organism_goals
    SET status = 'dormant', updated_at = now()
    WHERE id = ${goalId}
  `
}

/**
 * Reactivate a dormant goal.
 */
async function reactivateGoal(goalId) {
  await db`
    UPDATE organism_goals
    SET status = 'active', updated_at = now()
    WHERE id = ${goalId} AND status = 'dormant'
  `
}

/**
 * Build a compact summary of goals for the maintenance mind's system brief.
 */
async function buildGoalBrief() {
  const goals = await getActiveGoals()
  if (goals.length === 0) return null

  const lines = goals.map(g => {
    const progress = Math.round(g.progress * 100)
    const attempts = Array.isArray(g.attempts) ? g.attempts.length : 0
    const subgoalInfo = g.active_subgoals > 0 ? ` (${g.achieved_subgoals}/${g.active_subgoals + g.achieved_subgoals} sub-goals done)` : ''
    const age = Math.round((Date.now() - new Date(g.created_at).getTime()) / 86400000)
    return `  [${g.goal_type}] ${g.title} — ${progress}% done, ${attempts} attempts, ${age}d old, priority ${g.priority.toFixed(1)}${subgoalInfo}`
  })

  return `Active goals (${goals.length}):\n${lines.join('\n')}`
}

/**
 * Goal formation prompt for the maintenance mind's exploration cycles.
 * Returns a prompt section that asks the AI to consider creating new goals
 * based on what it observes about the system.
 */
function buildGoalFormationContext(existingGoals) {
  if (existingGoals.length === 0) {
    return `\nYou have NO active goals. This is your chance to set direction. What does this organism want to become? What capabilities should it develop? What would make it fundamentally more capable, resilient, or intelligent? Create 0-2 goals if any feel genuine.`
  }

  const goalSummary = existingGoals.map(g =>
    `  "${g.title}" [${g.goal_type}, ${Math.round(g.progress * 100)}% done, ${g.status}]`
  ).join('\n')

  return `\nYour active goals:\n${goalSummary}\n\nReview these. Should any be abandoned (no longer relevant)? Should any be reprioritised? Should you create a new goal based on what you've observed? Goals are commitments — only create new ones if they feel genuine and achievable.`
}

/**
 * Get recent goal history — achievements and abandonments.
 */
async function getGoalHistory(limit = 10) {
  return db`
    SELECT * FROM organism_goals
    WHERE status IN ('achieved', 'abandoned')
    ORDER BY COALESCE(achieved_at, abandoned_at) DESC
    LIMIT ${limit}
  `
}

/**
 * Get a single goal by ID with its sub-goals.
 */
async function getGoal(goalId) {
  const [goal] = await db`SELECT * FROM organism_goals WHERE id = ${goalId}`
  if (!goal) return null
  goal.subgoals = await db`
    SELECT * FROM organism_goals WHERE parent_id = ${goalId} ORDER BY priority DESC
  `
  return goal
}

/**
 * Advance goal progress based on a completed Factory session outcome.
 * Called by factoryOversightService.recordOutcome when session.goal_id is set.
 *
 * Uses the session outcome and the goal's existing state to determine
 * how much progress to attribute. Successful sessions with file changes
 * advance more than failed ones. The AI (via DeepSeek) assesses whether
 * success criteria are met when progress is high enough.
 */
async function advanceFromSession({ goalId, sessionId, outcome, confidence, filesChanged, prompt }) {
  const goal = await getGoal(goalId)
  if (!goal || goal.status === 'achieved' || goal.status === 'abandoned') return

  // Record the attempt with outcome
  await recordAttempt(goalId, {
    action: (prompt || '').slice(0, 200),
    outcome: `${outcome} (session ${sessionId}, confidence: ${confidence ?? 'N/A'})`,
    learning: filesChanged?.length ? `Changed ${filesChanged.length} files: ${filesChanged.slice(0, 5).join(', ')}` : 'No files changed',
  })

  // Calculate progress increment based on outcome signals
  const attempts = Array.isArray(goal.attempts) ? goal.attempts.length + 1 : 1
  let progressIncrement = 0

  if (outcome === 'success') {
    const hasChanges = filesChanged && filesChanged.length > 0
    const highConfidence = (confidence || 0) >= 0.6

    if (hasChanges && highConfidence) {
      progressIncrement = 0.25
    } else if (hasChanges) {
      progressIncrement = 0.15
    } else {
      progressIncrement = 0.05
    }
  } else if (outcome === 'partial' || outcome === 'deployed') {
    progressIncrement = 0.1
  }
  // Failed sessions don't advance progress but are recorded as attempts

  if (progressIncrement > 0) {
    const newProgress = Math.min(1.0, goal.progress + progressIncrement)
    await updateProgress(goalId, newProgress, `Session ${sessionId}: ${outcome}`)
    logger.info(`GoalService: advanced goal ${goalId} "${goal.title}" — ${Math.round(goal.progress * 100)}% → ${Math.round(newProgress * 100)}%`)

    // When progress crosses 0.8, check if success criteria are actually met
    if (newProgress >= 0.8 && goal.progress < 0.8 && goal.success_criteria) {
      assessCompletion(goalId).catch(err =>
        logger.debug('Goal completion assessment failed', { error: err.message, goalId })
      )
    }
  }
}

/**
 * AI-driven goal completion assessment.
 * Called when progress is high enough to warrant checking success criteria.
 * Uses DeepSeek to evaluate whether the goal's success criteria are met
 * based on the accumulated attempts and outcomes.
 */
async function assessCompletion(goalId) {
  const goal = await getGoal(goalId)
  if (!goal || goal.status === 'achieved') return

  const attempts = Array.isArray(goal.attempts) ? goal.attempts : []
  const recentAttempts = attempts.slice(-5).map(a =>
    `${a.action} → ${a.outcome}${a.learning ? ` (${a.learning})` : ''}`
  ).join('\n')

  const deepseekService = require('./deepseekService')
  const raw = await deepseekService.callDeepSeek(
    [{ role: 'user', content: `Goal: "${goal.title}"
Description: ${goal.description || 'none'}
Success criteria: ${goal.success_criteria}
Current progress: ${Math.round(goal.progress * 100)}%
Recent attempts (${attempts.length} total):
${recentAttempts || 'none'}

Based on the attempts and outcomes, has the success criteria been met?

Respond as JSON:
{
  "met": true/false,
  "confidence": 0.0-1.0,
  "reason": "brief explanation"
}` }],
    { module: 'goal_completion_assessment', temperature: 0.3, skipRetrieval: true, skipLogging: true }
  )

  try {
    const parsed = JSON.parse(raw.replace(/```json\n?|```/g, '').trim())
    if (parsed.met && parsed.confidence >= 0.6) {
      await updateProgress(goalId, 1.0, `Completion assessed: ${parsed.reason}`)
      logger.info(`GoalService: goal ${goalId} "${goal.title}" ACHIEVED via AI assessment — ${parsed.reason}`)
    } else {
      logger.info(`GoalService: goal ${goalId} completion check — not yet met (confidence: ${parsed.confidence}): ${parsed.reason}`)
    }
  } catch (parseErr) {
    logger.debug('Goal completion assessment parse failed', { error: parseErr.message, raw: raw?.slice(0, 200) })
  }
}

module.exports = {
  createGoal,
  getActiveGoals,
  getGoalTree,
  recordAttempt,
  updateProgress,
  abandonGoal,
  reprioritise,
  makeGoalDormant,
  reactivateGoal,
  buildGoalBrief,
  buildGoalFormationContext,
  getGoalHistory,
  getGoal,
  advanceFromSession,
  assessCompletion,
}
