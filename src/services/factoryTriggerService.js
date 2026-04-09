const db = require('../config/db')
const logger = require('../config/logger')
const env = require('../config/env')

// ═══════════════════════════════════════════════════════════════════════
// FACTORY TRIGGER SERVICE — Central Dispatch
//
// Normalizes all trigger sources into CC sessions. Every path through
// here ends with a cc_sessions row and a call to ccService.startSession.
// ═══════════════════════════════════════════════════════════════════════

// ─── Universal Codebase Resolution ─────────────────────────────────
//
// Single function used by every entry point. Resolves a codebase from
// whatever information is available: explicit ID, name, or free-text
// prompt. No fragile string matching — gives the full list to the AI
// when needed.
// ───────────────────────────────────────────────────────────────────

async function resolveCodebase({ codebaseId, codebaseName, prompt, clientId }) {
  // 1. Explicit ID — only query if it looks like a UUID
  if (codebaseId) {
    const isUUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(codebaseId)
    if (isUUID) {
      const [cb] = await db`SELECT id FROM codebases WHERE id = ${codebaseId} LIMIT 1`
      if (cb) return cb.id
    } else {
      // Treat non-UUID codebaseId as a name hint — fall through to name match
      if (!codebaseName) codebaseName = codebaseId
    }
  }

  // 2. Exact name match (case-insensitive)
  if (codebaseName) {
    const [cb] = await db`SELECT id FROM codebases WHERE name ILIKE ${codebaseName} LIMIT 1`
    if (cb) return cb.id
  }

  // 3. If we have a prompt, ask the AI which codebase it's about
  if (prompt) {
    const allCodebases = await db`SELECT id, name, language, repo_path FROM codebases ORDER BY name`
    if (allCodebases.length === 0) return null

    // Enrich the AI prompt with client context if available
    let clientHint = ''
    if (clientId) {
      const clientProjects = await db`
        SELECT p.name AS project_name, cb.name AS codebase_name
        FROM projects p
        LEFT JOIN codebases cb ON cb.project_id = p.id
        WHERE p.client_id = ${clientId} AND p.status = 'active'
      `.catch(err => { logger.debug('Failed to fetch client projects for codebase resolution', { error: err.message }); return [] })
      if (clientProjects.length > 0) {
        clientHint = `\nClient's projects: ${clientProjects.map(p =>
          `${p.project_name} (codebase: ${p.codebase_name || 'none'})`
        ).join(', ')}\n`
      }
    }

    // Enrich with recent session activity per codebase
    const activityHints = await db`
      SELECT cb.name, count(*)::int AS sessions_14d
      FROM cc_sessions cs
      JOIN codebases cb ON cs.codebase_id = cb.id
      WHERE cs.started_at > now() - interval '14 days'
      GROUP BY cb.name ORDER BY sessions_14d DESC
    `.catch(err => { logger.debug('Failed to fetch activity hints for codebase resolution', { error: err.message }); return [] })
    const activityStr = activityHints.length > 0
      ? `\nRecent activity: ${activityHints.map(a => `${a.name} (${a.sessions_14d} sessions)`).join(', ')}\n`
      : ''

    const codebaseList = allCodebases.map(cb => `- ${cb.name} (${cb.language || 'unknown'}, ${cb.repo_path})`).join('\n')

    try {
      const { callClaude } = require('./claudeService')
      const response = await callClaude([{
        role: 'user',
        content: `Which codebase does this task target? Respond with the exact name or "none".

Available codebases:
${codebaseList}
${clientHint}${activityStr}
Task: ${prompt.slice(0, 800)}`,
      }], { module: 'factory_dispatch', temperature: 0.1 })

      const resolved = response.trim().toLowerCase().replace(/['"]/g, '')
      if (resolved && resolved !== 'none') {
        const match = allCodebases.find(cb => cb.name.toLowerCase() === resolved)
        if (match) {
          logger.info(`Codebase resolved by AI: "${match.name}" from prompt`)
          return match.id
        }
      }
    } catch (err) {
      logger.debug('AI codebase resolution failed, proceeding without', { error: err.message })
    }
  }

  return null
}

// ─── Dispatch Dedup & Failure Memory Gate ──────────────────────────
//
// Before creating ANY session, check two things:
//   1. Has a similar session already run recently? (keyword overlap)
//   2. Do factory_learnings contain a dont_try/failure_pattern for this task?
//
// This prevents the system from endlessly retrying the same failing task.
// The cooldown window is configurable; failure learnings persist forever.

const DISPATCH_COOLDOWN_MS = parseInt(env.DISPATCH_DEDUP_COOLDOWN_MS || '7200000')  // 2h default

// Structural issues are inherent system behaviors (PM2 restarts → orphans,
// concurrent sessions → lock contention). These need much longer cooldowns
// because they recur naturally and can't be fixed by CC sessions.
const STRUCTURAL_COOLDOWN_MS = parseInt(env.DISPATCH_STRUCTURAL_COOLDOWN_MS || '86400000')  // 24h
const _STRUCTURAL_PATTERNS = [
  /orphan/i, /codebase.*lock/i, /lock.*codebase/i, /concurrent.*session/i,
  /session.*stale/i, /heartbeat/i, /process.*kill/i, /graceful.*shutdown/i,
  /pm2.*restart/i, /restart.*loop/i, /signal.*handling/i,
]

function _isStructuralIssue(text) {
  return _STRUCTURAL_PATTERNS.some(p => p.test(text || ''))
}

const _STOP_WORDS = new Set([
  'the', 'and', 'for', 'that', 'this', 'with', 'from', 'are', 'was', 'were', 'been',
  'have', 'has', 'had', 'not', 'but', 'what', 'when', 'where', 'how', 'why', 'which',
  'who', 'into', 'also', 'any', 'all', 'the', 'urgent', 'context', 'previous',
  'should', 'could', 'would', 'will', 'does', 'there', 'then', 'than', 'just', 'about',
  'being', 'other', 'some', 'these', 'those', 'such', 'each', 'every', 'more', 'most',
])

// Naive English stemmer — strips common suffixes so "orphaned"→"orphan",
// "sessions"→"session", "investigating"→"investigat", etc.
// Good enough for dedup without pulling in a dependency.
function _stem(word) {
  return word
    .replace(/ies$/, 'y')
    .replace(/ied$/, 'y')
    .replace(/ing$/, '')
    .replace(/tion$/, 't')
    .replace(/sion$/, 's')
    .replace(/ment$/, '')
    .replace(/ness$/, '')
    .replace(/able$/, '')
    .replace(/ible$/, '')
    .replace(/ated$/, 'at')
    .replace(/ised$/, 'is')
    .replace(/ized$/, 'iz')
    .replace(/ling$/, 'l')
    .replace(/lled$/, 'l')
    .replace(/ened$/, 'en')
    .replace(/ened$/, 'en')
    .replace(/ed$/, '')
    .replace(/ly$/, '')
    .replace(/er$/, '')
    .replace(/es$/, '')
    .replace(/s$/, '')
}

function _extractKeywords(text) {
  return [...new Set(
    (text || '')
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter(w => w.length > 3 && !_STOP_WORDS.has(w))
      .map(w => _stem(w))
      .filter(w => w.length > 2)
  )].slice(0, 12)
}

async function _shouldSuppressDispatch({ codebaseId, prompt, triggeredBy }) {
  try {
    const keywords = _extractKeywords(prompt)
    if (keywords.length === 0) return { suppress: false }

    // 1. Check recent sessions from ANY trigger source (not just 'scheduled')
    //    Structural issues (orphans, locks, restarts) use a much longer cooldown
    //    because they're inherent system behaviors, not actionable bugs.
    const isStructural = _isStructuralIssue(prompt)
    const effectiveCooldown = isStructural ? STRUCTURAL_COOLDOWN_MS : DISPATCH_COOLDOWN_MS
    const cooldownInterval = `${Math.ceil(effectiveCooldown / 60000)} minutes`
    const recentSessions = await db`
      SELECT id, initial_prompt, status, triggered_by, started_at
      FROM cc_sessions
      WHERE started_at > now() - ${cooldownInterval}::interval
        AND status IN ('complete', 'running', 'queued', 'error', 'initializing')
      ORDER BY started_at DESC
      LIMIT 30
    `

    for (const session of recentSessions) {
      const sessionWords = _extractKeywords(session.initial_prompt)
      if (sessionWords.length === 0) continue
      const matchCount = keywords.filter(kw => sessionWords.includes(kw)).length
      if (matchCount >= Math.ceil(keywords.length * 0.4)) {
        return {
          suppress: true,
          reason: `Similar session ${session.id} (${session.status}) exists from ${Math.round((Date.now() - new Date(session.started_at).getTime()) / 60000)}min ago (${matchCount}/${keywords.length} keyword match)`,
        }
      }
    }

    // 2. Check factory_learnings for dont_try / failure_pattern matching this task
    //    Only check if we have a codebase — learnings are codebase-scoped
    if (codebaseId) {
      const failureLearnings = await db`
        SELECT id, pattern_type, pattern_description, confidence, evidence
        FROM factory_learnings
        WHERE codebase_id = ${codebaseId}
          AND absorbed_into IS NULL
          AND pattern_type IN ('dont_try', 'failure_pattern', 'constraint')
          AND confidence >= 0.3
        ORDER BY confidence DESC
        LIMIT 20
      `

      for (const learning of failureLearnings) {
        // Check keyword overlap between learning evidence and this prompt
        const learningKeywords = [
          ..._extractKeywords(learning.pattern_description),
          ...((learning.evidence?.keywords || []).map(k => k.toLowerCase())),
        ]
        if (learningKeywords.length === 0) continue

        const matchCount = keywords.filter(kw => learningKeywords.includes(kw)).length
        if (matchCount >= Math.ceil(keywords.length * 0.4)) {
          return {
            suppress: true,
            reason: `Matching ${learning.pattern_type} learning (confidence: ${learning.confidence.toFixed(2)}): "${learning.pattern_description.slice(0, 100)}" — ${matchCount}/${keywords.length} keyword match`,
          }
        }
      }
    }

    // 3. Even without codebase, check for global failure patterns with high keyword overlap
    if (!codebaseId) {
      const globalFailures = await db`
        SELECT id, pattern_type, pattern_description, confidence, evidence
        FROM factory_learnings
        WHERE absorbed_into IS NULL
          AND pattern_type IN ('dont_try', 'failure_pattern')
          AND confidence >= 0.5
        ORDER BY confidence DESC
        LIMIT 10
      `

      for (const learning of globalFailures) {
        const learningKeywords = [
          ..._extractKeywords(learning.pattern_description),
          ...((learning.evidence?.keywords || []).map(k => k.toLowerCase())),
        ]
        if (learningKeywords.length === 0) continue

        const matchCount = keywords.filter(kw => learningKeywords.includes(kw)).length
        if (matchCount >= Math.ceil(keywords.length * 0.5)) {
          return {
            suppress: true,
            reason: `Global ${learning.pattern_type} learning (confidence: ${learning.confidence.toFixed(2)}): "${learning.pattern_description.slice(0, 100)}"`,
          }
        }
      }
    }

    return { suppress: false }
  } catch (err) {
    // Never block dispatch on dedup failure — but log at warn so it's visible
    logger.warn('Dispatch dedup check failed, allowing dispatch', { error: err.message })
    return { suppress: false }
  }
}

async function createAndStartSession({ codebaseId, prompt, triggeredBy, triggerSource, triggerRefId, projectId, clientId, workingDir, selfModification, streamSource, goalId }) {
  const bridge = require('./factoryBridge')

  // Reject scheduled/automated dispatches when CLI is rate-limited
  const rlStatus = await bridge.getRateLimitStatus()
  if (rlStatus.limited && (triggeredBy === 'scheduled' || triggerSource === 'scheduled')) {
    const resetsIn = Math.ceil((new Date(rlStatus.resetsAt) - new Date()) / 60000)
    logger.warn(`Factory dispatch blocked — CLI rate-limited, resets in ${resetsIn}min`, { triggerSource })
    throw new Error(`CLI rate-limited — resets in ${resetsIn}min`)
  }

  // ─── Dedup Gate: check recent sessions + failure learnings ────────
  // This is the SINGLE funnel every dispatch flows through. Without this
  // check the system spawns the same failing task endlessly because
  // learnings are recorded but never consulted before dispatch.
  const dedupResult = await _shouldSuppressDispatch({ codebaseId, prompt, triggeredBy })
  if (dedupResult.suppress) {
    logger.info(`Factory dispatch suppressed: ${dedupResult.reason}`, {
      triggerSource,
      prompt: prompt?.slice(0, 80),
    })
    return null
  }

  const [session] = await db`
    INSERT INTO cc_sessions (
      codebase_id, initial_prompt, triggered_by, trigger_source,
      trigger_ref_id, project_id, client_id, pipeline_stage, working_dir,
      self_modification, stream_source, goal_id
    ) VALUES (
      ${codebaseId || null}, ${prompt}, ${triggeredBy || 'manual'},
      ${triggerSource || 'manual'}, ${triggerRefId || null},
      ${projectId || null}, ${clientId || null}, 'queued', ${workingDir || null},
      ${!!selfModification}, ${streamSource || null}, ${goalId || null}
    )
    RETURNING *
  `

  logger.info(`Factory dispatch: ${triggerSource} → session ${session.id}`, { codebaseId, triggeredBy })

  // Log to CRM activity timeline for client-linked sessions
  if (clientId) {
    try {
      const crmService = require('./crmService')
      crmService.logActivity({
        clientId,
        projectId: projectId || null,
        activityType: 'session_dispatched',
        title: `Coding session: ${(prompt || '').slice(0, 80)}`,
        source: triggerSource || 'factory',
        sourceRefId: session.id,
        sourceRefType: 'cc_session',
        actor: 'system',
        metadata: { triggeredBy, codebaseId },
      }).catch(() => {})
    } catch {}
  }

  // Broadcast session creation to all clients
  const { broadcast } = require('../websocket/wsManager')
  broadcast('cc:session_created', {
    data: {
      id: session.id,
      prompt: session.initial_prompt?.slice(0, 120),
      triggered_by: session.triggered_by,
      codebase_id: session.codebase_id,
      status: session.status || 'initializing',
      pipeline_stage: session.pipeline_stage || 'queued',
    },
  })

  // Publish to Redis — factoryRunner picks it up and starts the CC session
  const published = bridge.publishSessionRequest(session)
  if (!published) {
    logger.error(`Factory session ${session.id} failed to publish — no Redis connection`)
    await db`
      UPDATE cc_sessions
      SET status = 'error',
          error_message = 'Failed to publish session request to factory runner (no Redis)',
          completed_at = now(),
          pipeline_stage = 'failed'
      WHERE id = ${session.id}
    `.catch(err => logger.error('Failed to mark unpublished session as error', { sessionId: session.id, error: err.message }))
    // Return null so callers know dispatch failed (not a valid session)
    return null
  }

  return session
}

// ─── Trigger: Cortex (user command) ─────────────────────────────────

async function dispatchFromCortex(description, params = {}) {
  const codebaseId = await resolveCodebase({
    codebaseId: params.codebaseId,
    codebaseName: params.codebaseName,
    prompt: description,
    clientId: params.clientId,
  })

  const session = await createAndStartSession({
    codebaseId,
    prompt: description,
    triggeredBy: params.triggeredBy || 'cortex',
    triggerSource: params.triggerSource || 'cortex',
    triggerRefId: params.triggerRefId || null,
    projectId: params.projectId || null,
    clientId: params.clientId || null,
    workingDir: params.workingDir || null,
  })

  // Track in code_requests so Cortex dispatches are visible in the coding workspace
  // alongside email/CRM dispatches — unified view of all code work
  if (session) {
    try {
      const codeRequestService = require('./codeRequestService')
      await codeRequestService.createFromCortex({
        summary: description.slice(0, 200),
        prompt: description,
        codebaseId,
        clientId: params.clientId,
        projectId: params.projectId,
        skipDispatch: true,  // Session already created above — don't double-dispatch
      }).then(cr => {
        // Link the code request to the session
        codeRequestService.linkSession(cr.id, session.id)
      })
    } catch (crErr) {
      logger.debug('Failed to create code request from Cortex dispatch (non-blocking)', { error: crErr.message })
    }
  }

  return session
}

// ─── Trigger: CRM Stage Change ──────────────────────────────────────

async function dispatchFromCRM({ clientId, previousStage, newStage, clientName }) {
  // Look up the project and client context for this client
  const [project] = await db`
    SELECT p.id, p.name, p.description, cb.id AS codebase_id
    FROM projects p
    LEFT JOIN codebases cb ON cb.project_id = p.id
    WHERE p.client_id = ${clientId} AND p.status = 'active'
    ORDER BY p.created_at DESC LIMIT 1
  `

  // Let the AI decide whether this stage change warrants a CC session
  try {
    const { callClaudeJSON } = require('./claudeService')
    const parsed = await callClaudeJSON([{
      role: 'user',
      content: `CRM client "${clientName || 'Unknown'}" just moved from "${previousStage}" to "${newStage}".
Project: ${project?.name || 'No active project'}
${project?.description ? `Description: ${project.description}` : ''}

Decide whether this stage transition warrants running a Factory code session. Consider: does the stage change imply work that needs to happen in the codebase? If yes, write a precise prompt for the session. If no, skip it.

Respond as JSON:
{
  "shouldTrigger": true,
  "prompt": "specific Factory session prompt — be concrete about what code work is needed",
  "reasoning": "brief rationale"
}
or
{
  "shouldTrigger": false,
  "reasoning": "why no code work is needed"
}`
    }], { module: 'factory_dispatch' }).catch(parseErr => {
      logger.warn('CRM dispatch: failed to get AI response', { error: parseErr.message })
      return null
    })
    if (!parsed || !parsed.shouldTrigger) {
      logger.info(`CRM stage change ${previousStage}→${newStage}: AI decided no CC session needed (${parsed.reasoning})`)
      return null
    }

    const prompt = parsed.prompt || `Client ${clientName || 'Unknown'} moved from ${previousStage} to ${newStage}. Project: ${project?.name || 'Unknown'}. Take appropriate action.`
    const session = await createAndStartSession({
      codebaseId: project?.codebase_id || null,
      prompt,
      triggeredBy: 'crm_stage',
      triggerSource: 'crm_stage',
      triggerRefId: clientId,
      projectId: project?.id || null,
      clientId,
    })

    // Track as a code request for the coding workspace
    if (session) {
      try {
        const codeRequestService = require('./codeRequestService')
        await codeRequestService.createFromCRM({
          clientId,
          projectId: project?.id,
          codebaseId: project?.codebase_id,
          summary: `CRM stage change: ${previousStage} → ${newStage} (${clientName || 'Unknown'})`,
          prompt,
          sessionId: session.id,
        })
      } catch (crErr) {
        logger.warn('Failed to create code request from CRM dispatch', { error: crErr.message, clientId })
      }

      // Log dispatch back to pipeline_events so CRM UI can see it
      await db`
        INSERT INTO pipeline_events (client_id, from_stage, to_stage, note)
        VALUES (
          ${clientId},
          ${newStage}, ${newStage},
          ${'Factory session dispatched: ' + (session.id || 'unknown') + ' — ' + (prompt || '').slice(0, 100)}
        )
      `.catch(err => logger.debug('Failed to log CRM dispatch to pipeline_events', { error: err.message }))
    }

    return session
  } catch (err) {
    logger.warn('AI CRM dispatch decision failed, skipping', { error: err.message })
    return null
  }
}

// ─── Trigger: Simula Proposal ───────────────────────────────────────

async function dispatchFromSimula(proposal) {
  const codebaseId = await resolveCodebase({
    codebaseName: proposal.codebase_name,
    prompt: proposal.description,
  })

  return createAndStartSession({
    codebaseId,
    prompt: `Organism Evolution Proposal (Simula):\n\nDescription: ${proposal.description}\nCategory: ${proposal.category || 'unknown'}\nExpected Benefit: ${proposal.expected_benefit || 'N/A'}\nRisk Assessment: ${proposal.risk_assessment || 'N/A'}\n\n${proposal.change_spec?.code_hint ? `Code Hint:\n${proposal.change_spec.code_hint}` : ''}`,
    triggeredBy: 'simula',
    triggerSource: 'simula_proposal',
    triggerRefId: proposal.id,
  })
}

// ─── Trigger: Thymos Incident ───────────────────────────────────────

async function dispatchFromThymos(incident) {
  const codebaseId = await resolveCodebase({
    codebaseName: incident.codebase_name || incident.affected_system,
    prompt: incident.description || incident.error_message,
  })

  return createAndStartSession({
    codebaseId,
    prompt: `Organism Immune System (Thymos) Incident Report\n\nSeverity: ${incident.severity || 'unknown'}\nSystem: ${incident.affected_system || 'unknown'}\nError: ${incident.error_message || incident.description || 'No details'}\nStack Trace:\n${(incident.stack_trace || '').slice(0, 3000)}`,
    triggeredBy: 'thymos',
    triggerSource: 'thymos_incident',
    triggerRefId: incident.id,
  })
}

// ─── Trigger: Scheduled Maintenance ─────────────────────────────────

async function dispatchFromSchedule(config) {
  const prompt = config.streamSource
    ? `[${config.streamSource} Stream] ${config.prompt || `Scheduled maintenance: ${config.task || 'dependency audit'}`}`
    : (config.prompt || `Scheduled maintenance: ${config.task || 'dependency audit'}`)

  return createAndStartSession({
    codebaseId: config.codebaseId,
    prompt,
    triggeredBy: 'scheduled',
    triggerSource: 'scheduled',
    streamSource: config.streamSource,
    goalId: config.goalId,
  })
}

// ─── Trigger: KG Insight ────────────────────────────────────────────

async function dispatchFromKGInsight(insight) {
  return createAndStartSession({
    codebaseId: insight.codebaseId || null,
    prompt: `Knowledge Graph Insight:\n\n${insight.description}\n\nContext: ${insight.context || 'N/A'}\nSuggested Action: ${insight.suggestedAction || 'Investigate and address'}`,
    triggeredBy: 'kg_insight',
    triggerSource: 'kg_insight',
    triggerRefId: insight.id,
  })
}

// ─── Trigger: Capability Request (organism wants new abilities) ─────

async function dispatchFromCapabilityRequest(request) {
  const codebaseId = await resolveCodebase({
    prompt: request.description || request.proposed_implementation,
  })

  return createAndStartSession({
    codebaseId,
    prompt: `Capability Request from the Organism:\n\n${request.description}\n\nProposed Implementation: ${request.proposed_implementation || 'Decide the best approach'}\nPriority: ${request.priority || 'medium'}\nEvidence: ${(request.evidence || []).join(', ') || 'N/A'}\n\nImplement this capability in the EcodiaOS admin hub codebase so the organism can use it.`,
    triggeredBy: 'simula',
    triggerSource: 'simula_proposal',
    triggerRefId: request.id,
  })
}

// ─── Trigger: Self-Modification (Factory modifies itself) ───────────

// Rate limits: DB-persisted sliding window.
// In-memory timestamps are a cache; DB is authoritative (survives PM2 restarts).
// 0 = unlimited (the default — the organism evolves without artificial caps).
const SELF_MOD_DAILY_CAP = parseInt(env.SELF_MOD_DAILY_CAP || '0', 10)
const SLIDING_WINDOW_MS = 24 * 60 * 60 * 1000

async function _getSlidingWindowCount(dispatchType) {
  try {
    const [row] = await db`
      SELECT count(*)::int AS count FROM factory_dispatch_log
      WHERE dispatch_type = ${dispatchType}
        AND dispatched_at > now() - interval '24 hours'
    `
    return row?.count || 0
  } catch {
    return 0
  }
}

async function _logDispatch(dispatchType, sessionId, metadata = {}) {
  try {
    await db`
      INSERT INTO factory_dispatch_log (dispatch_type, session_id, metadata)
      VALUES (${dispatchType}, ${sessionId}, ${JSON.stringify(metadata)})
    `
  } catch (err) {
    logger.debug('Failed to log dispatch', { error: err.message })
  }
}

async function dispatchSelfModification(spec) {
  // Atomic cap check: use advisory lock to prevent concurrent dispatches
  // from both reading the same count and exceeding the cap
  if (SELF_MOD_DAILY_CAP > 0) {
    const [lockResult] = await db`SELECT pg_try_advisory_lock(42, 1) AS acquired`
    try {
      const windowCount = await _getSlidingWindowCount('self_modification')
      if (windowCount >= SELF_MOD_DAILY_CAP) {
        logger.warn(`Factory self-modification sliding-window cap reached (${windowCount}/${SELF_MOD_DAILY_CAP} in last 24h)`)
        return null
      }
    } finally {
      if (lockResult?.acquired) {
        await db`SELECT pg_advisory_unlock(42, 1)`.catch(() => {})
      }
    }
  }

  // Resolve to Factory's own codebase — name is env-driven, not hardcoded
  const selfCodebaseName = env.FACTORY_SELF_CODEBASE_NAME || 'ecodiaos-backend'
  const [factoryCb] = await db`SELECT id, repo_path FROM codebases WHERE name = ${selfCodebaseName} LIMIT 1`
  if (!factoryCb) {
    logger.warn(`Factory self-modification: cannot find "${selfCodebaseName}" codebase`)
    return null
  }

  // Get current system state for context
  const migrationCount = await db`SELECT count(*)::int AS count FROM _migrations`
  // Discover workers dynamically from the workers directory (never hardcode)
  let workerList = 'unknown'
  try {
    const { readdirSync } = require('fs')
    const { join } = require('path')
    const workersDir = join(__dirname, '../workers')
    const files = readdirSync(workersDir).filter(f => f.endsWith('.js'))
    workerList = files.map(f => f.replace('.js', '')).join(', ')
  } catch (err) {
    logger.debug('Could not read workers directory for self-mod context', { error: err.message })
  }

  // selfModification: true is set on the INSERT (via createAndStartSession) — not
  // as a post-hoc UPDATE. createAndStartSession fires ccService.startSession as
  // fire-and-forget, so a post-hoc UPDATE races with the oversight pipeline reading
  // the flag. Setting it on INSERT eliminates the race.
  const session = await createAndStartSession({
    codebaseId: factoryCb.id,
    prompt: `SELF-MODIFICATION: ${spec.description || 'Improve Factory'}

${spec.change_spec ? `Proposed Changes:\n${spec.change_spec}` : ''}
${spec.motivation ? `Motivation: ${spec.motivation}` : ''}

CONTEXT (current Factory state):
- Applied migrations: ${migrationCount[0]?.count || 'unknown'}
- Workers: ${workerList}
- This is the live EcodiaOS backend. Changes deploy automatically via the oversight pipeline.
- Migration files: sequential numbering, tracked in \`_migrations\` table.

Implement the proposed changes.`,
    triggeredBy: 'self_modification',
    triggerSource: 'self_modification',
    triggerRefId: spec.id || null,
    selfModification: true,
  })

  if (session) {
    await _logDispatch('self_modification', session.id, { description: (spec.description || '').slice(0, 200) })
    const currentCount = await _getSlidingWindowCount('self_modification')
    logger.info(`Factory self-modification dispatched: ${(spec.description || '').slice(0, 80)} (${currentCount}/${SELF_MOD_DAILY_CAP || 'unlimited'} in 24h window)`)
  }

  return session
}

// ─── Trigger: Prediction-Based (KG Phase 6 actionable predictions) ──

const PREDICTION_DAILY_CAP = parseInt(env.PREDICTION_SESSION_DAILY_CAP || '0', 10)  // 0 = unlimited

async function dispatchFromPrediction(prediction) {
  const windowCount = await _getSlidingWindowCount('prediction')

  if (PREDICTION_DAILY_CAP > 0 && windowCount >= PREDICTION_DAILY_CAP) {
    logger.debug(`Prediction dispatch sliding-window cap reached (${windowCount}/${PREDICTION_DAILY_CAP} in last 24h)`)
    return null
  }

  // AI triage: let Claude decide whether this prediction is actionable code work
  // before burning a CC session on it. Behavioral/psychological predictions about
  // humans are valid KG output but not Factory work.
  try {
    const { callClaudeJSON } = require('./claudeService')
    const triage = await callClaudeJSON([{
      role: 'user',
      content: `A knowledge graph prediction was generated. Should this trigger a coding session?

Prediction: ${prediction.description}
Basis: ${prediction.basis || 'unknown'}
Confidence: ${prediction.confidence || 'N/A'}

A coding session can: modify code, add features, fix bugs, create migrations, update configs, improve infrastructure.
A coding session cannot: change human behavior, resolve emotional states, provide therapy, write articles.

Respond as JSON:
{ "actionable": true/false, "reason": "why or why not" }`
    }], { module: 'prediction_triage', temperature: 0.3 })
    if (!triage.actionable) {
      logger.info(`KG prediction skipped (not code-actionable): ${(prediction.description || '').slice(0, 80)} — ${triage.reason || 'AI decided'}`)
      return null
    }
  } catch (err) {
    // Triage failure is non-blocking — if we can't triage, proceed with dispatch
    logger.debug('Prediction triage failed, proceeding with dispatch', { error: err.message })
  }

  const codebaseId = prediction.codebaseId || await resolveCodebase({ prompt: prediction.description })

  logger.info(`KG prediction → Factory session: ${(prediction.description || '').slice(0, 80)} (${windowCount + 1}/${PREDICTION_DAILY_CAP} in 24h window)`)

  const session = await createAndStartSession({
    codebaseId,
    prompt: `Proactive: KG Prediction\n\nPrediction: ${prediction.description}\nBasis: ${prediction.basis || 'Pattern analysis'}\nConfidence: ${prediction.confidence || 'N/A'}\nTimeframe: ${prediction.timeframe || 'unknown'}\n\nThe Knowledge Graph's prediction engine identified this as likely to happen. Proactively prepare for it or address it now.`,
    triggeredBy: 'kg_prediction',
    triggerSource: 'kg_insight',
    triggerRefId: prediction.id || null,
  })

  if (session) {
    await _logDispatch('prediction', session.id, { description: (prediction.description || '').slice(0, 200) })
  }

  return session
}

// ─── Trigger: Integration Scaffold ──────────────────────────────────

async function dispatchIntegrationScaffold(discovery) {
  // Uses self-modification pathway since it modifies EcodiaOS
  return dispatchSelfModification({
    description: `Scaffold new integration: ${discovery.name || discovery.description}`,
    change_spec: `Create a new integration service following the established pattern:
1. Service file: src/services/${discovery.serviceName || 'newService'}Service.js (poll/webhook, process, KG hooks, action queue)
2. Route file: src/routes/${discovery.routeName || 'new'}.js (CRUD + manual sync endpoint)
3. KG hooks: Add ingestion hooks to kgIngestionHooks.js
4. Worker entry: Add polling to workspacePoller.js or create dedicated worker

Follow the pattern established by gmailService.js as the canonical example.

Integration target: ${discovery.description}
${discovery.apiUrl ? `API URL: ${discovery.apiUrl}` : ''}
${discovery.authType ? `Auth type: ${discovery.authType}` : ''}`,
    motivation: discovery.motivation || 'KG free association discovered an integration opportunity',
    id: discovery.id,
  })
}

// ─── Trigger: Self-Diagnosis (Factory investigates its own errors) ──

async function dispatchSelfDiagnosis(errorContext) {
  const selfCodebaseName = env.FACTORY_SELF_CODEBASE_NAME || 'ecodiaos-backend'
  const [factoryCb] = await db`SELECT id, repo_path FROM codebases WHERE name = ${selfCodebaseName} LIMIT 1`

  return createAndStartSession({
    codebaseId: factoryCb?.id || null,
    prompt: `SELF-DIAGNOSIS: The Factory detected an issue in its own operation.

${errorContext.description || 'An error occurred that needs investigation.'}

Error details:
${errorContext.error || 'N/A'}
${errorContext.stack ? `Stack trace:\n${errorContext.stack.slice(0, 3000)}` : ''}
${errorContext.service ? `Service: ${errorContext.service}` : ''}
${errorContext.sessionId ? `Related session: ${errorContext.sessionId}` : ''}

Investigate the root cause. Read the relevant source files, understand the control flow, identify the bug, and fix it.
If the fix requires a database migration, create one.
If the fix reveals other related issues, fix those too.`,
    triggeredBy: 'self_diagnosis',
    triggerSource: 'self_modification',
    triggerRefId: errorContext.id || null,
    selfModification: true,
  })
}

// ─── Trigger: Proactive Improvement (Factory improves code quality) ──

async function dispatchProactiveImprovement(spec) {
  const codebaseId = await resolveCodebase({
    codebaseId: spec.codebaseId,
    codebaseName: spec.codebaseName,
    prompt: spec.description,
  })

  return createAndStartSession({
    codebaseId,
    prompt: `PROACTIVE IMPROVEMENT: ${spec.description}

${spec.context ? `Context: ${spec.context}` : ''}
${spec.files ? `Files to examine: ${spec.files.join(', ')}` : ''}

Analyze the code, identify improvements, and implement them. This could include:
- Fixing bugs you discover during analysis
- Improving error handling that could cause silent failures
- Refactoring fragile patterns into robust ones
- Adding missing edge case handling
- Improving performance bottlenecks
- Strengthening type safety or validation

Make the changes. Run tests. Ensure nothing breaks.`,
    triggeredBy: spec.triggeredBy || 'proactive',
    triggerSource: spec.triggerSource || 'proactive_improvement',
    triggerRefId: spec.id || null,
  })
}

// ─── Dispatch from Email Code Request ────────────────────────────────
//
// Called by codeRequestService when an email triage detects code work.
// Resolves project/codebase from client context, dispatches through
// the standard dedup + oversight pipeline.

async function dispatchFromEmail({ codeRequestId, prompt, clientId, projectId, codebaseId, threadId }) {
  const resolvedCodebase = codebaseId || await resolveCodebase({ prompt })

  let resolvedProject = projectId
  if (!resolvedProject && clientId) {
    const [project] = await db`
      SELECT p.id FROM projects p
      WHERE p.client_id = ${clientId} AND p.status = 'active'
      ORDER BY p.created_at DESC LIMIT 1
    `
    resolvedProject = project?.id || null
  }

  return createAndStartSession({
    codebaseId: resolvedCodebase,
    prompt,
    triggeredBy: 'email',
    triggerSource: 'gmail',
    triggerRefId: threadId || codeRequestId,
    projectId: resolvedProject,
    clientId,
  })
}

module.exports = {
  resolveCodebase,
  dispatchFromCortex,
  dispatchFromCRM,
  dispatchFromEmail,
  dispatchFromSimula,
  dispatchFromThymos,
  dispatchFromSchedule,
  dispatchFromKGInsight,
  dispatchFromCapabilityRequest,
  dispatchSelfModification,
  dispatchFromPrediction,
  dispatchIntegrationScaffold,
  dispatchSelfDiagnosis,
  dispatchProactiveImprovement,
  _extractKeywords,  // shared with autonomousMaintenanceWorker for consistent dedup
  _isStructuralIssue,
}
