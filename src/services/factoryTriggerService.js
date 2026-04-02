const db = require('../config/db')
const logger = require('../config/logger')

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
  // 1. Explicit ID — trust it
  if (codebaseId) {
    const [cb] = await db`SELECT id FROM codebases WHERE id = ${codebaseId} LIMIT 1`
    if (cb) return cb.id
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
        content: `Given this task description, which codebase should it target? If no specific codebase is mentioned or implied, respond with "none".

Available codebases:
${codebaseList}

Task: ${prompt.slice(0, 500)}

Respond with ONLY the exact codebase name (e.g. "wattleos") or "none". Nothing else.`,
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

async function dispatchFromCRM({ clientId, previousStage, newStage }) {
  if (newStage !== 'development') return null

  // Look up the project for this client
  const [project] = await db`
    SELECT p.id, p.name, cb.id AS codebase_id
    FROM projects p
    LEFT JOIN codebases cb ON cb.project_id = p.id
    WHERE p.client_id = ${clientId} AND p.status = 'active'
    ORDER BY p.created_at DESC LIMIT 1
  `

  return createAndStartSession({
    codebaseId: project?.codebase_id || null,
    prompt: `Client moved to development stage. Project: ${project?.name || 'Unknown'}. Set up the initial development environment and scaffolding based on the project requirements.`,
    triggeredBy: 'crm_stage',
    triggerSource: 'crm_stage',
    triggerRefId: clientId,
    projectId: project?.id || null,
    clientId,
  })
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

module.exports = {
  resolveCodebase,
  dispatchFromCortex,
  dispatchFromCRM,
  dispatchFromSimula,
  dispatchFromThymos,
  dispatchFromSchedule,
  dispatchFromKGInsight,
  dispatchFromCapabilityRequest,
}
