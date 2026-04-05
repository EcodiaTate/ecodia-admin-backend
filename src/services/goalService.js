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
    // Fire-and-forget: generate follow-up goals from this achievement
    const achievedGoal = await getGoal(goalId).catch(() => null)
    if (achievedGoal) {
      generateFollowUpGoals(achievedGoal).catch(err =>
        logger.debug('Follow-up goal generation failed', { error: err.message, goalId })
      )
    }
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

// ═══════════════════════════════════════════════════════════════════════
// AUTONOMOUS GOAL GENERATION — The organism proposes its own goals
//
// Gathers system signals (errors, learnings, capability gaps, recent
// achievements, introspection findings) and asks DeepSeek to propose
// goals that would make the organism more capable, resilient, or intelligent.
//
// Runs alongside introspection in the maintenance worker cycle.
// Deduplicates against existing goals to prevent redundant aspiration.
// ═══════════════════════════════════════════════════════════════════════

/**
 * Propose new goals autonomously based on system state.
 * Gathers signals, asks DeepSeek, deduplicates, and creates.
 * Returns { proposed, created, skipped } counts.
 */
async function proposeGoals() {
  const deepseekService = require('./deepseekService')

  // Gather signals in parallel
  const [activeGoals, history, signals] = await Promise.all([
    getActiveGoals(),
    getGoalHistory(5),
    _gatherGoalSignals(),
  ])

  // Don't overwhelm — if already pursuing many goals, be selective
  const maxActive = parseInt(env.GOAL_MAX_ACTIVE || '0') // 0 = unlimited
  if (maxActive > 0 && activeGoals.length >= maxActive) {
    logger.debug('GoalService: skipping goal generation — at max active goals')
    return { proposed: 0, created: 0, skipped: 0, reason: 'max_active_reached' }
  }

  const existingSummary = activeGoals.map(g =>
    `"${g.title}" [${g.goal_type}, ${Math.round(g.progress * 100)}%]`
  ).join('\n')

  const historySummary = history.map(g =>
    `"${g.title}" [${g.status}, ${g.goal_type}]${g.abandon_reason ? ` — abandoned: ${g.abandon_reason}` : ''}`
  ).join('\n')

  const raw = await deepseekService.callDeepSeek(
    [{ role: 'user', content: `System signals:
${signals}

Active goals (${activeGoals.length}):
${existingSummary || 'none'}

Recent goal history:
${historySummary || 'none'}

Propose 0-3 new goals. Each must be concrete, achievable via code changes or system configuration, and non-redundant with active goals.

Respond as JSON:
{
  "goals": [
    {
      "title": "short imperative title",
      "description": "what and why",
      "goalType": "growth|capability|resilience|understanding|experiment|relationship|creative",
      "priority": 0.0-1.0,
      "successCriteria": "measurable condition"
    }
  ],
  "reasoning": "brief"
}` }],
    { module: 'goal_generation', temperature: 0.7, skipRetrieval: true, skipLogging: true }
  )

  let proposals
  try {
    const parsed = JSON.parse(raw.replace(/```json\n?|```/g, '').trim())
    proposals = Array.isArray(parsed.goals) ? parsed.goals : []
  } catch {
    logger.debug('GoalService: goal proposal parse failed', { raw: raw?.slice(0, 200) })
    return { proposed: 0, created: 0, skipped: 0 }
  }

  let created = 0
  let skipped = 0

  for (const proposal of proposals) {
    if (!proposal.title || !proposal.successCriteria) { skipped++; continue }

    // Dedup: check title similarity against active goals
    const isDuplicate = activeGoals.some(g =>
      _titleSimilarity(g.title, proposal.title) > 0.6
    )
    if (isDuplicate) {
      logger.debug(`GoalService: skipping duplicate goal proposal — "${proposal.title}"`)
      skipped++
      continue
    }

    try {
      await createGoal({
        title: proposal.title,
        description: proposal.description,
        goalType: proposal.goalType || 'growth',
        origin: 'autonomous',
        priority: proposal.priority ?? 0.5,
        successCriteria: proposal.successCriteria,
      })
      created++
    } catch (err) {
      logger.debug('GoalService: failed to create proposed goal', { error: err.message, title: proposal.title })
      skipped++
    }
  }

  logger.info(`GoalService: autonomous generation — ${proposals.length} proposed, ${created} created, ${skipped} skipped`)
  return { proposed: proposals.length, created, skipped }
}

/**
 * Gather system signals that inform goal generation.
 * Returns a compact string the AI can reason over.
 */
async function _gatherGoalSignals() {
  const lines = []

  // Recurring errors — persistent problems become goals
  const errorRows = await db`
    SELECT error_message AS message, count(*)::int AS occurrences
    FROM app_errors
    WHERE created_at > now() - interval '7 days'
    GROUP BY error_message
    HAVING count(*) >= 3
    ORDER BY count(*) DESC
    LIMIT 5
  `.catch(() => [])
  if (errorRows.length > 0) {
    lines.push('Recurring errors (7d):')
    errorRows.forEach(e => lines.push(`  ${e.occurrences}x: ${(e.message || '').slice(0, 100)}`))
  }

  // Learning effectiveness — are we getting better?
  const [learningStats] = await db`
    SELECT count(*)::int AS total,
           count(*) FILTER (WHERE confidence > 0.5)::int AS high_confidence,
           count(*) FILTER (WHERE absorbed_into IS NULL AND embedding IS NULL)::int AS unembedded
    FROM factory_learnings
  `.catch(() => [{}])
  if (learningStats?.total) {
    lines.push(`Factory learnings: ${learningStats.total} total, ${learningStats.high_confidence} high-confidence, ${learningStats.unembedded} unembedded`)
  }

  // Session success rate — are sessions productive?
  const [sessionStats] = await db`
    SELECT count(*)::int AS total,
           count(*) FILTER (WHERE status = 'complete' AND array_length(files_changed, 1) > 0)::int AS productive
    FROM cc_sessions
    WHERE started_at > now() - interval '7 days'
  `.catch(() => [{}])
  if (sessionStats?.total > 0) {
    lines.push(`Session productivity (7d): ${sessionStats.productive}/${sessionStats.total} produced file changes`)
  }

  // Capability gaps — actions that failed due to missing capabilities
  const capGaps = await db`
    SELECT title, description
    FROM action_queue
    WHERE status = 'error'
      AND created_at > now() - interval '7 days'
    ORDER BY created_at DESC
    LIMIT 5
  `.catch(() => [])
  if (capGaps.length > 0) {
    lines.push('Recent action failures:')
    capGaps.forEach(a => lines.push(`  "${(a.title || '').slice(0, 80)}"`))
  }

  // Recent introspection concerns
  const [latestIntro] = await db`
    SELECT observations
    FROM introspection_logs
    WHERE log_type = 'full_introspection'
    ORDER BY created_at DESC
    LIMIT 1
  `.catch(() => [null])
  if (latestIntro?.observations) {
    const obs = typeof latestIntro.observations === 'string' ? JSON.parse(latestIntro.observations) : latestIntro.observations
    if (obs.concerns?.length > 0) {
      lines.push(`Introspection concerns: ${obs.concerns.join('; ')}`)
    }
  }

  return lines.length > 0 ? lines.join('\n') : 'No significant signals detected — system is stable.'
}

/**
 * Simple word-overlap similarity for goal title dedup.
 */
function _titleSimilarity(a, b) {
  const wordsA = new Set(a.toLowerCase().replace(/[^a-z0-9\s]/g, '').split(/\s+/).filter(w => w.length > 2))
  const wordsB = new Set(b.toLowerCase().replace(/[^a-z0-9\s]/g, '').split(/\s+/).filter(w => w.length > 2))
  if (wordsA.size === 0 || wordsB.size === 0) return 0
  let overlap = 0
  for (const w of wordsA) { if (wordsB.has(w)) overlap++ }
  return overlap / Math.max(wordsA.size, wordsB.size)
}

/**
 * Act on introspection goal recommendations.
 * Auto-executes dormant/abandon recommendations for stale/stuck goals.
 * Returns count of actions taken.
 */
async function actOnGoalRecommendations(recommendations) {
  if (!recommendations?.length) return 0
  let acted = 0

  for (const rec of recommendations) {
    try {
      if (rec.recommendation === 'dormant') {
        await makeGoalDormant(rec.goalId)
        logger.info(`GoalService: auto-dormant goal ${rec.goalId} — ${rec.reason}`)
        acted++
      }
      // 'reassess' and 'overdue' are left for the AI to decide via exploration stream
    } catch (err) {
      logger.debug('GoalService: failed to act on recommendation', { error: err.message, goalId: rec.goalId })
    }
  }

  return acted
}

/**
 * Generate follow-up goals when a goal is achieved.
 * Asks DeepSeek what naturally comes next.
 */
async function generateFollowUpGoals(achievedGoal) {
  if (!achievedGoal?.title) return

  const deepseekService = require('./deepseekService')
  const activeGoals = await getActiveGoals()

  const existingSummary = activeGoals.map(g => `"${g.title}"`).join(', ')
  const attempts = Array.isArray(achievedGoal.attempts) ? achievedGoal.attempts : []
  const recentAttempts = attempts.slice(-3).map(a => `${a.action} → ${a.outcome}`).join('\n')

  const raw = await deepseekService.callDeepSeek(
    [{ role: 'user', content: `Goal achieved: "${achievedGoal.title}"
Type: ${achievedGoal.goal_type}
Description: ${achievedGoal.description || 'none'}
Success criteria: ${achievedGoal.success_criteria || 'none'}
Recent attempts:
${recentAttempts || 'none'}

Current active goals: ${existingSummary || 'none'}

What naturally follows from this achievement? Propose 0-1 follow-up goals that build on what was learned. Only propose if genuinely valuable — [] is valid.

Respond as JSON:
{
  "goals": [{ "title": "...", "description": "...", "goalType": "...", "priority": 0.0-1.0, "successCriteria": "..." }]
}` }],
    { module: 'goal_followup', temperature: 0.7, skipRetrieval: true, skipLogging: true }
  )

  try {
    const parsed = JSON.parse(raw.replace(/```json\n?|```/g, '').trim())
    const proposals = Array.isArray(parsed.goals) ? parsed.goals : []

    for (const p of proposals.slice(0, 1)) {
      if (!p.title || !p.successCriteria) continue
      const isDuplicate = activeGoals.some(g => _titleSimilarity(g.title, p.title) > 0.6)
      if (isDuplicate) continue

      await createGoal({
        title: p.title,
        description: p.description,
        goalType: p.goalType || achievedGoal.goal_type || 'growth',
        origin: 'followup',
        originRef: String(achievedGoal.id),
        priority: p.priority ?? 0.5,
        successCriteria: p.successCriteria,
      })
      logger.info(`GoalService: follow-up goal created — "${p.title}" (from achieved: "${achievedGoal.title}")`)
    }
  } catch {
    logger.debug('GoalService: follow-up goal parse failed', { raw: raw?.slice(0, 200) })
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
  proposeGoals,
  actOnGoalRecommendations,
  generateFollowUpGoals,
}
