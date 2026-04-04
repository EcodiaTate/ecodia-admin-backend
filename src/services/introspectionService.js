const db = require('../config/db')
const logger = require('../config/logger')
const env = require('../config/env')

// ═══════════════════════════════════════════════════════════════════════
// INTROSPECTION SERVICE — "How am I doing?"
//
// The organism's self-evaluation system. Not just "is the DB up?" but
// "are my decisions getting better?", "is my learning working?",
// "what should I change about how I operate?"
//
// Three functions:
//   1. Cognitive Health  — decision quality trends, learning effectiveness
//   2. Meta-Learning     — learning about the learning system
//   3. Goal Review       — are goals progressing? should they change?
//
// Runs periodically via the maintenance worker. Results feed into
// the self-model (updating capability beliefs) and goal system
// (adjusting priorities, creating sub-goals, abandoning dead ends).
// ═══════════════════════════════════════════════════════════════════════

/**
 * Run a full cognitive health check.
 * Returns structured metrics about decision quality, learning effectiveness,
 * and system-level cognitive performance.
 */
async function assessCognitiveHealth() {
  const metrics = {}

  // 1. Decision quality — are Factory sessions succeeding more or less over time?
  const [trend7d] = await db`
    SELECT
      count(*)::int AS total_sessions,
      count(*) FILTER (WHERE status = 'complete')::int AS successful,
      count(*) FILTER (WHERE status = 'error')::int AS failed,
      count(*) FILTER (WHERE deploy_status = 'deployed')::int AS deployed,
      round(avg(confidence_score)::numeric, 3) AS avg_confidence,
      round(avg(CASE WHEN status = 'complete' THEN confidence_score END)::numeric, 3) AS avg_success_confidence,
      round(avg(CASE WHEN status = 'error' THEN confidence_score END)::numeric, 3) AS avg_failure_confidence
    FROM cc_sessions
    WHERE started_at > now() - interval '7 days'
  `.catch(() => [{}])

  metrics.decisionQuality = {
    totalSessions7d: trend7d?.total_sessions || 0,
    successRate: trend7d?.total_sessions > 0 ? ((trend7d.successful || 0) / trend7d.total_sessions) : null,
    deployRate: trend7d?.total_sessions > 0 ? ((trend7d.deployed || 0) / trend7d.total_sessions) : null,
    avgConfidence: parseFloat(trend7d?.avg_confidence) || null,
    avgSuccessConfidence: parseFloat(trend7d?.avg_success_confidence) || null,
    avgFailureConfidence: parseFloat(trend7d?.avg_failure_confidence) || null,
  }

  // 2. Confidence calibration — when I'm confident, am I right?
  const calibration = await db`
    SELECT
      CASE
        WHEN confidence_score >= 0.8 THEN 'high'
        WHEN confidence_score >= 0.5 THEN 'medium'
        ELSE 'low'
      END AS confidence_band,
      count(*)::int AS total,
      count(*) FILTER (WHERE status = 'complete')::int AS succeeded,
      count(*) FILTER (WHERE deploy_status = 'deployed')::int AS deployed
    FROM cc_sessions
    WHERE started_at > now() - interval '14 days'
      AND confidence_score IS NOT NULL
    GROUP BY confidence_band
  `.catch(() => [])

  metrics.confidenceCalibration = {}
  for (const row of calibration) {
    metrics.confidenceCalibration[row.confidence_band] = {
      total: row.total,
      successRate: row.total > 0 ? row.succeeded / row.total : null,
      deployRate: row.total > 0 ? row.deployed / row.total : null,
    }
  }

  // 3. Learning effectiveness — are learnings actually helping?
  const [learningHealth] = await db`
    SELECT
      count(*)::int AS total_learnings,
      count(*) FILTER (WHERE outcome_status = 'verified_effective')::int AS effective,
      count(*) FILTER (WHERE outcome_status = 'verified_ineffective')::int AS ineffective,
      count(*) FILTER (WHERE outcome_status = 'pending')::int AS pending_verification,
      round(avg(confidence)::numeric, 3) AS avg_confidence,
      count(*) FILTER (WHERE pattern_type = 'dont_try')::int AS dont_try_count,
      count(*) FILTER (WHERE absorbed_into IS NOT NULL)::int AS consolidated
    FROM factory_learnings
  `.catch(() => [{}])

  metrics.learningEffectiveness = {
    totalLearnings: learningHealth?.total_learnings || 0,
    effective: learningHealth?.effective || 0,
    ineffective: learningHealth?.ineffective || 0,
    pendingVerification: learningHealth?.pending_verification || 0,
    avgConfidence: parseFloat(learningHealth?.avg_confidence) || null,
    dontTryCount: learningHealth?.dont_try_count || 0,
    consolidated: learningHealth?.consolidated || 0,
    effectivenessRate: (learningHealth?.effective + learningHealth?.ineffective) > 0
      ? learningHealth.effective / (learningHealth.effective + learningHealth.ineffective)
      : null,
  }

  // 4. Error recurrence — are the same errors coming back after fixes?
  const recurringErrors = await db`
    SELECT message, count(*)::int AS occurrences,
           min(created_at) AS first_seen, max(created_at) AS last_seen,
           count(DISTINCT date_trunc('day', created_at))::int AS days_active
    FROM app_errors
    WHERE created_at > now() - interval '14 days'
    GROUP BY message
    HAVING count(*) >= 3
    ORDER BY occurrences DESC
    LIMIT 5
  `.catch(() => [])

  metrics.recurringErrors = recurringErrors.map(e => ({
    message: e.message?.slice(0, 100),
    occurrences: e.occurrences,
    daysActive: e.days_active,
    persistent: e.days_active >= 7, // been around for a week+
  }))

  // 5. Maintenance mind effectiveness — are cycles producing results?
  const [cycleMetrics] = await db`
    SELECT
      count(*)::int AS total_cycles,
      count(*) FILTER (WHERE metadata->>'decisions' != '0')::int AS productive_cycles,
      count(*) FILTER (WHERE metadata->>'actionTaken' IS NOT NULL)::int AS action_cycles
    FROM notifications
    WHERE type = 'inner_monologue'
      AND created_at > now() - interval '7 days'
  `.catch(() => [{}])

  metrics.maintenanceMindHealth = {
    totalCycles7d: cycleMetrics?.total_cycles || 0,
    productiveRate: cycleMetrics?.total_cycles > 0
      ? (cycleMetrics.productive_cycles || 0) / cycleMetrics.total_cycles
      : null,
    actionRate: cycleMetrics?.total_cycles > 0
      ? (cycleMetrics.action_cycles || 0) / cycleMetrics.total_cycles
      : null,
  }

  // 6. Action queue intelligence — are surfaced actions being approved or dismissed?
  const [actionMetrics] = await db`
    SELECT
      count(*)::int AS total_decisions,
      count(*) FILTER (WHERE decision = 'approved')::int AS approved,
      count(*) FILTER (WHERE decision = 'dismissed')::int AS dismissed,
      round(avg(time_to_decision_seconds)::numeric, 0) AS avg_decision_time_s
    FROM action_decisions
    WHERE created_at > now() - interval '7 days'
  `.catch(() => [{}])

  metrics.actionQueueIntelligence = {
    totalDecisions7d: actionMetrics?.total_decisions || 0,
    approvalRate: actionMetrics?.total_decisions > 0
      ? (actionMetrics.approved || 0) / actionMetrics.total_decisions
      : null,
    avgDecisionTimeSeconds: parseInt(actionMetrics?.avg_decision_time_s) || null,
  }

  return metrics
}

/**
 * Run meta-learning analysis — learning about the learning system.
 * Are certain types of learnings more effective? Are certain codebases
 * harder to learn about? Is the consolidation working?
 */
async function runMetaLearning() {
  const insights = []

  // Which pattern types are most effective?
  const typeEffectiveness = await db`
    SELECT pattern_type,
           count(*)::int AS total,
           count(*) FILTER (WHERE outcome_status = 'verified_effective')::int AS effective,
           count(*) FILTER (WHERE outcome_status = 'verified_ineffective')::int AS ineffective
    FROM factory_learnings
    WHERE outcome_status IS NOT NULL AND outcome_status != 'pending'
    GROUP BY pattern_type
    HAVING count(*) >= 2
  `.catch(() => [])

  for (const row of typeEffectiveness) {
    const total = row.effective + row.ineffective
    const rate = total > 0 ? row.effective / total : null
    if (rate !== null && rate < 0.4) {
      insights.push({
        type: 'low_effectiveness_pattern_type',
        detail: `"${row.pattern_type}" learnings are only ${Math.round(rate * 100)}% effective (${row.effective}/${total})`,
        suggestion: `Consider whether "${row.pattern_type}" learnings need different evidence criteria or should be weighted lower`,
      })
    }
  }

  // Which codebases have the worst learning outcomes?
  const codebaseEffectiveness = await db`
    SELECT fl.codebase_id, cb.name AS codebase_name,
           count(*)::int AS total,
           count(*) FILTER (WHERE fl.outcome_status = 'verified_effective')::int AS effective
    FROM factory_learnings fl
    LEFT JOIN codebases cb ON cb.id = fl.codebase_id
    WHERE fl.outcome_status IS NOT NULL AND fl.outcome_status != 'pending'
    GROUP BY fl.codebase_id, cb.name
    HAVING count(*) >= 3
  `.catch(() => [])

  for (const row of codebaseEffectiveness) {
    const rate = row.total > 0 ? row.effective / row.total : null
    if (rate !== null && rate < 0.3) {
      insights.push({
        type: 'low_effectiveness_codebase',
        detail: `Learnings for "${row.codebase_name || 'unknown'}" are only ${Math.round(rate * 100)}% effective`,
        suggestion: `This codebase may need richer context bundles or different learning extraction strategies`,
      })
    }
  }

  // Consolidation health — are learnings being merged effectively?
  const [consolidationHealth] = await db`
    SELECT
      count(*) FILTER (WHERE absorbed_into IS NULL AND embedding IS NOT NULL)::int AS active_embedded,
      count(*) FILTER (WHERE absorbed_into IS NULL AND embedding IS NULL)::int AS active_unembedded,
      count(*) FILTER (WHERE absorbed_into IS NOT NULL AND created_at > now() - interval '7 days')::int AS recently_absorbed
    FROM factory_learnings
  `.catch(() => [{}])

  if ((consolidationHealth?.active_unembedded || 0) > 10) {
    insights.push({
      type: 'consolidation_backlog',
      detail: `${consolidationHealth.active_unembedded} learnings are unembedded — semantic search can't find them`,
      suggestion: 'Trigger a consolidation cycle to embed pending learnings',
    })
  }

  return insights
}

/**
 * Run a goal review — assess progress, suggest adjustments.
 */
async function reviewGoals() {
  const goalService = require('./goalService')
  const goals = await goalService.getActiveGoals()
  const updates = []

  for (const goal of goals) {
    const age = Date.now() - new Date(goal.created_at).getTime()
    const ageDays = Math.round(age / 86400000)
    const attempts = Array.isArray(goal.attempts) ? goal.attempts.length : 0

    // Stale goal detection: active for 7+ days with no progress
    if (ageDays >= 7 && goal.progress === 0 && attempts === 0) {
      updates.push({
        goalId: goal.id,
        recommendation: 'dormant',
        reason: `Goal "${goal.title}" has been active for ${ageDays} days with zero progress and zero attempts. Consider making dormant or abandoning.`,
      })
    }

    // Stuck goal detection: attempts made but no progress
    if (attempts >= 3 && goal.progress < 0.1) {
      updates.push({
        goalId: goal.id,
        recommendation: 'reassess',
        reason: `Goal "${goal.title}" has ${attempts} attempts but only ${Math.round(goal.progress * 100)}% progress. The approach may need to change.`,
      })
    }

    // Overdue goal
    if (goal.target_date && new Date(goal.target_date) < new Date()) {
      updates.push({
        goalId: goal.id,
        recommendation: 'overdue',
        reason: `Goal "${goal.title}" is past its target date.`,
      })
    }
  }

  return { totalGoals: goals.length, updates }
}

/**
 * Run a full introspection cycle. Called by the maintenance worker.
 * Returns a structured log entry that gets persisted.
 */
async function runFullIntrospection() {
  const cognitiveHealth = await assessCognitiveHealth()
  const metaLearning = await runMetaLearning()
  const goalReview = await reviewGoals()

  // Determine overall cognitive state
  const successRate = cognitiveHealth.decisionQuality?.successRate
  const learningRate = cognitiveHealth.learningEffectiveness?.effectivenessRate
  const approvalRate = cognitiveHealth.actionQueueIntelligence?.approvalRate

  let overallAssessment = 'healthy'
  const concerns = []

  if (successRate !== null && successRate < 0.5) {
    concerns.push(`Low session success rate (${Math.round(successRate * 100)}%)`)
    overallAssessment = 'degraded'
  }
  if (learningRate !== null && learningRate < 0.3) {
    concerns.push(`Low learning effectiveness (${Math.round(learningRate * 100)}%)`)
    overallAssessment = 'degraded'
  }
  if (approvalRate !== null && approvalRate < 0.3) {
    concerns.push(`Low action approval rate (${Math.round(approvalRate * 100)}%) — surfacing too many irrelevant actions`)
    overallAssessment = 'degraded'
  }
  if (metaLearning.length > 2) {
    concerns.push(`${metaLearning.length} meta-learning concerns identified`)
  }
  if (goalReview.updates.length > 0) {
    concerns.push(`${goalReview.updates.length} goals need attention`)
  }

  if (concerns.length >= 3) overallAssessment = 'concerning'

  const observations = {
    overallAssessment,
    concerns,
    cognitiveHealth,
    metaLearning,
    goalReview,
  }

  // Persist the introspection log
  const [log] = await db`
    INSERT INTO introspection_logs (log_type, observations, metrics)
    VALUES ('full_introspection', ${JSON.stringify(observations)}, ${JSON.stringify(cognitiveHealth)})
    RETURNING id
  `.catch(() => [{ id: null }])

  // Update self-model with findings
  const selfModelUpdates = await _updateSelfModelFromIntrospection(cognitiveHealth)

  if (log?.id && selfModelUpdates.length > 0) {
    await db`
      UPDATE introspection_logs
      SET self_model_updates = ${selfModelUpdates}
      WHERE id = ${log.id}
    `.catch(() => {})
  }

  logger.info(`Introspection: ${overallAssessment} — ${concerns.length} concerns, ${selfModelUpdates.length} self-model updates`)

  return { logId: log?.id, overallAssessment, concerns, selfModelUpdates }
}

/**
 * Update the self-model based on introspection findings.
 * This is how the organism LEARNS about itself from its own performance.
 */
async function _updateSelfModelFromIntrospection(metrics) {
  const selfModel = require('./selfModelService')
  const updatedIds = []

  // Update capability beliefs based on success rates
  if (metrics.decisionQuality?.successRate !== null) {
    const rate = metrics.decisionQuality.successRate
    const result = await selfModel.setBelief({
      aspect: 'capability',
      key: 'factory_session_success',
      value: `Factory sessions succeed ${Math.round(rate * 100)}% of the time (7d window)`,
      confidence: Math.min(0.95, 0.3 + rate * 0.6), // higher success = more confident in capability
      source: 'introspection',
      evidence: [{
        timestamp: new Date().toISOString(),
        observation: `${metrics.decisionQuality.totalSessions7d} sessions, ${Math.round(rate * 100)}% success`,
        delta: rate > 0.7 ? 0.05 : rate < 0.4 ? -0.1 : 0,
      }],
    })
    if (result?.id) updatedIds.push(result.id)
  }

  // Update confidence calibration belief
  const cal = metrics.confidenceCalibration
  if (cal?.high?.total > 0) {
    const highSuccessRate = cal.high.successRate
    const calibrationStatus = highSuccessRate >= 0.8 ? 'well-calibrated' : highSuccessRate >= 0.5 ? 'needs improvement' : 'poorly calibrated (overconfident)'
    const result = await selfModel.setBelief({
      aspect: 'capability',
      key: 'confidence_calibration',
      value: `My confidence calibration is ${calibrationStatus}: when I say high confidence, I'm right ${Math.round((highSuccessRate || 0) * 100)}% of the time`,
      confidence: Math.min(0.9, 0.3 + (cal.high.total / 20)), // more samples = more confident in assessment
      source: 'introspection',
    })
    if (result?.id) updatedIds.push(result.id)
  }

  // Update learning effectiveness belief
  if (metrics.learningEffectiveness?.effectivenessRate !== null) {
    const rate = metrics.learningEffectiveness.effectivenessRate
    const result = await selfModel.setBelief({
      aspect: 'capability',
      key: 'learning_effectiveness',
      value: `My learnings are ${Math.round(rate * 100)}% effective when verified against outcomes`,
      confidence: Math.min(0.9, 0.3 + rate * 0.5),
      source: 'introspection',
    })
    if (result?.id) updatedIds.push(result.id)
  }

  // Detect and record limitations from recurring errors
  for (const err of (metrics.recurringErrors || [])) {
    if (err.persistent) {
      const result = await selfModel.setBelief({
        aspect: 'limitation',
        key: `persistent_error_${err.message?.slice(0, 30).replace(/[^a-z0-9]/gi, '_').toLowerCase()}`,
        value: `Persistent error (${err.daysActive}d, ${err.occurrences}x): ${err.message}`,
        confidence: Math.min(0.9, 0.3 + (err.daysActive / 14) * 0.5),
        source: 'introspection',
      })
      if (result?.id) updatedIds.push(result.id)
    }
  }

  return updatedIds
}

/**
 * Build a compact introspection brief for the maintenance mind.
 */
async function buildIntrospectionBrief() {
  const [latest] = await db`
    SELECT observations, metrics, created_at
    FROM introspection_logs
    WHERE log_type = 'full_introspection'
    ORDER BY created_at DESC
    LIMIT 1
  `.catch(() => [null])

  if (!latest) return null

  const obs = typeof latest.observations === 'string' ? JSON.parse(latest.observations) : (latest.observations || {})
  const age = Math.round((Date.now() - new Date(latest.created_at).getTime()) / 3600000)

  const lines = [`Last introspection: ${age}h ago — ${obs.overallAssessment || 'unknown'}`]
  if (obs.concerns?.length > 0) {
    lines.push(`  Concerns: ${obs.concerns.join('; ')}`)
  }

  return lines.join('\n')
}

module.exports = {
  assessCognitiveHealth,
  runMetaLearning,
  reviewGoals,
  runFullIntrospection,
  buildIntrospectionBrief,
}
