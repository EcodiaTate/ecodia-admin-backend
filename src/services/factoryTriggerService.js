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

async function resolveCodebase({ codebaseId, codebaseName, prompt }) {
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

    const codebaseList = allCodebases.map(cb => `- ${cb.name} (${cb.language || 'unknown'}, ${cb.repo_path})`).join('\n')

    try {
      const { callDeepSeek } = require('./deepseekService')
      const response = await callDeepSeek([{
        role: 'user',
        content: `Which codebase does this task target? Respond with the exact name or "none".

Available codebases:
${codebaseList}

Task: ${prompt.slice(0, 500)}`,
      }], { module: 'factory_dispatch', skipRetrieval: true })

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

async function createAndStartSession({ codebaseId, prompt, triggeredBy, triggerSource, triggerRefId, projectId, clientId }) {
  const ccService = require('./ccService')

  // Reject scheduled/automated dispatches when CLI is rate-limited
  const rlStatus = ccService.getRateLimitStatus()
  if (rlStatus.limited && (triggeredBy === 'scheduled' || triggerSource === 'scheduled')) {
    const resetsIn = Math.ceil((rlStatus.resetsAt - new Date()) / 60000)
    logger.warn(`Factory dispatch blocked — CLI rate-limited, resets in ${resetsIn}min`, { triggerSource })
    throw new Error(`CLI rate-limited — resets in ${resetsIn}min`)
  }

  const [session] = await db`
    INSERT INTO cc_sessions (
      codebase_id, initial_prompt, triggered_by, trigger_source,
      trigger_ref_id, project_id, client_id, pipeline_stage
    ) VALUES (
      ${codebaseId || null}, ${prompt}, ${triggeredBy || 'manual'},
      ${triggerSource || 'manual'}, ${triggerRefId || null},
      ${projectId || null}, ${clientId || null}, 'queued'
    )
    RETURNING *
  `

  logger.info(`Factory dispatch: ${triggerSource} → session ${session.id}`, { codebaseId, triggeredBy })

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

  // Start async (fire-and-forget)
  ccService.startSession(session).catch(err => {
    logger.error(`Factory session ${session.id} failed to start`, { error: err.message })
    db`UPDATE cc_sessions SET status = 'error', error_message = ${err.message}, completed_at = now(), pipeline_stage = 'failed'
       WHERE id = ${session.id}`.catch(() => {})
  })

  return session
}

// ─── Trigger: Cortex (user command) ─────────────────────────────────

async function dispatchFromCortex(description, params = {}) {
  const codebaseId = await resolveCodebase({
    codebaseId: params.codebaseId,
    codebaseName: params.codebaseName,
    prompt: description,
  })

  return createAndStartSession({
    codebaseId,
    prompt: description,
    triggeredBy: 'cortex',
    triggerSource: 'cortex',
    projectId: params.projectId || null,
  })
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
    const { callDeepSeek } = require('./deepseekService')
    const response = await callDeepSeek([{
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
    }], { module: 'factory_dispatch', skipRetrieval: true })

    const parsed = JSON.parse(response.replace(/```json?\s*/g, '').replace(/```/g, '').trim())
    if (!parsed.shouldTrigger) {
      logger.info(`CRM stage change ${previousStage}→${newStage}: AI decided no CC session needed (${parsed.reasoning})`)
      return null
    }

    return createAndStartSession({
      codebaseId: project?.codebase_id || null,
      prompt: parsed.prompt || `Client ${clientName || 'Unknown'} moved from ${previousStage} to ${newStage}. Project: ${project?.name || 'Unknown'}. Take appropriate action.`,
      triggeredBy: 'crm_stage',
      triggerSource: 'crm_stage',
      triggerRefId: clientId,
      projectId: project?.id || null,
      clientId,
    })
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
    prompt: `URGENT: Organism Immune System (Thymos) Incident Report\n\nSeverity: ${incident.severity || 'unknown'}\nSystem: ${incident.affected_system || 'unknown'}\nError: ${incident.error_message || incident.description || 'No details'}\nStack Trace:\n${(incident.stack_trace || '').slice(0, 3000)}\n\nDiagnose the root cause and implement a fix. Run tests to verify the fix works.`,
    triggeredBy: 'thymos',
    triggerSource: 'thymos_incident',
    triggerRefId: incident.id,
  })
}

// ─── Trigger: Scheduled Maintenance ─────────────────────────────────

async function dispatchFromSchedule(config) {
  return createAndStartSession({
    codebaseId: config.codebaseId,
    prompt: config.prompt || `Scheduled maintenance: ${config.task || 'dependency audit'}`,
    triggeredBy: 'scheduled',
    triggerSource: 'scheduled',
  })
}

// ─── Trigger: KG Insight ────────────────────────────────────────────

async function dispatchFromKGInsight(insight) {
  return createAndStartSession({
    codebaseId: insight.codebaseId || null,
    prompt: `Knowledge Graph Insight:\n\n${insight.description}\n\nContext: ${insight.context || 'N/A'}\nSuggested Action: ${insight.suggestedAction || 'Investigate and address'}`,
    triggeredBy: 'manual',
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
// Defaults are sane non-zero values. 0 = unlimited (opt-in only).
const SELF_MOD_DAILY_CAP = parseInt(env.SELF_MOD_DAILY_CAP || '5', 10)
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
  const windowCount = await _getSlidingWindowCount('self_modification')

  if (SELF_MOD_DAILY_CAP > 0 && windowCount >= SELF_MOD_DAILY_CAP) {
    logger.warn(`Factory self-modification sliding-window cap reached (${windowCount}/${SELF_MOD_DAILY_CAP} in last 24h)`)
    return null
  }

  // Resolve to Factory's own codebase
  const [factoryCb] = await db`SELECT id, repo_path FROM codebases WHERE name = 'ecodiaos-backend' LIMIT 1`
  if (!factoryCb) {
    logger.warn('Factory self-modification: cannot find ecodiaos-backend codebase')
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
  })

  // Mark as self-modification so oversight applies higher threshold
  if (session) {
    await db`UPDATE cc_sessions SET self_modification = true WHERE id = ${session.id}`.catch(() => {})
    await _logDispatch('self_modification', session.id, { description: (spec.description || '').slice(0, 200) })
  }

  logger.info(`Factory self-modification dispatched: ${(spec.description || '').slice(0, 80)} (${windowCount + 1}/${SELF_MOD_DAILY_CAP} in 24h window)`)

  return session
}

// ─── Trigger: Prediction-Based (KG Phase 6 actionable predictions) ──

const PREDICTION_DAILY_CAP = parseInt(env.PREDICTION_SESSION_DAILY_CAP || '10', 10)

async function dispatchFromPrediction(prediction) {
  const windowCount = await _getSlidingWindowCount('prediction')

  if (PREDICTION_DAILY_CAP > 0 && windowCount >= PREDICTION_DAILY_CAP) {
    logger.debug(`Prediction dispatch sliding-window cap reached (${windowCount}/${PREDICTION_DAILY_CAP} in last 24h)`)
    return null
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

module.exports = {
  resolveCodebase,
  dispatchFromCortex,
  dispatchFromCRM,
  dispatchFromSimula,
  dispatchFromThymos,
  dispatchFromSchedule,
  dispatchFromKGInsight,
  dispatchFromCapabilityRequest,
  dispatchSelfModification,
  dispatchFromPrediction,
  dispatchIntegrationScaffold,
}
