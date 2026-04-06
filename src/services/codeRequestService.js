const db = require('../config/db')
const logger = require('../config/logger')
const kgHooks = require('./kgIngestionHooks')

// ═══════════════════════════════════════════════════════════════════════
// CODE REQUEST SERVICE — Bridge between intake (email/CRM/Cortex) and Factory
//
// Every code request from any source flows through here. Creates a
// code_requests row, resolves the target codebase with full context,
// enriches the factory prompt with codebase intelligence, and dispatches.
//
// Context chain:
//   1. Resolve client → project(s) → codebase(s)
//   2. If ambiguous, surface for human disambiguation
//   3. Enrich prompt with codebase structure, recent sessions, KG context
//   4. Dispatch through standard Factory pipeline
//
// Hardened against:
//   - Duplicate code requests (unique constraint + pre-INSERT check)
//   - Dispatch failures (retry path via action queue)
//   - Null/undefined inputs from malformed AI responses
//   - Enrichment failures (graceful degradation)
//   - Stuck states (dispatch_attempts tracking)
// ═══════════════════════════════════════════════════════════════════════

const VALID_CODE_WORK_TYPES = new Set(['feature', 'bugfix', 'update', 'investigation', 'refactor', 'deployment'])
const MAX_DISPATCH_ATTEMPTS = 3

function _sanitizeCodeWorkType(raw) {
  if (!raw || typeof raw !== 'string') return null
  const normalized = raw.toLowerCase().trim().replace(/-/g, '')
  // Map common AI variants
  if (normalized === 'bug' || normalized === 'bugfix' || normalized === 'bug_fix') return 'bugfix'
  if (normalized === 'feat' || normalized === 'feature') return 'feature'
  if (VALID_CODE_WORK_TYPES.has(normalized)) return normalized
  return null  // Unknown type — store null rather than garbage
}

function _validateConfidence(raw) {
  if (raw === null || raw === undefined) return null
  const num = typeof raw === 'number' ? raw : parseFloat(raw)
  if (isNaN(num)) return null
  return Math.max(0, Math.min(1, num))  // Clamp to [0, 1]
}

async function createFromEmail({ threadId, clientId, summary, factoryPrompt, codeWorkType, suggestedCodebase, confidence, surfaceToHuman }) {
  // ─── Input validation ──────────────────────────────────────────────
  if (!factoryPrompt || typeof factoryPrompt !== 'string' || factoryPrompt.trim().length < 10) {
    logger.warn('Code request rejected: factoryPrompt too short or missing', { threadId })
    return null
  }
  if (!summary || typeof summary !== 'string') {
    summary = factoryPrompt.slice(0, 200)
  }

  confidence = _validateConfidence(confidence)
  codeWorkType = _sanitizeCodeWorkType(codeWorkType)

  // ─── Dedup check: prevent duplicate code requests from same email ──
  if (threadId) {
    const [existing] = await db`
      SELECT id, status FROM code_requests
      WHERE source = 'gmail' AND source_ref_id = ${threadId}
        AND status NOT IN ('rejected', 'completed')
      LIMIT 1
    `
    if (existing) {
      logger.info(`Duplicate code request for thread ${threadId} — existing ${existing.id} (${existing.status})`)
      return existing
    }
  }

  // ─── Resolve project + codebase from client context ───────────────
  let projectId = null
  let codebaseId = null
  let disambiguationNeeded = false

  if (clientId) {
    const projects = await db`
      SELECT p.id, p.name, p.description, cb.id AS codebase_id, cb.name AS codebase_name, cb.language
      FROM projects p
      LEFT JOIN codebases cb ON cb.project_id = p.id
      WHERE p.client_id = ${clientId} AND p.status = 'active'
    `

    if (projects.length === 1) {
      // Single project — use it directly
      projectId = projects[0].id
      codebaseId = projects[0].codebase_id
    } else if (projects.length > 1) {
      // Multiple projects — try to disambiguate using suggestedCodebase from triage
      if (suggestedCodebase && typeof suggestedCodebase === 'string') {
        const normalized = suggestedCodebase.toLowerCase().trim()
        const match = projects.find(p =>
          p.codebase_name?.toLowerCase() === normalized ||
          p.name?.toLowerCase() === normalized
        )
        if (match) {
          projectId = match.id
          codebaseId = match.codebase_id
          logger.info(`Multi-project client: matched "${suggestedCodebase}" → ${match.codebase_name || match.name}`)
        }
      }

      // If suggestedCodebase didn't match, use AI to pick
      if (!codebaseId) {
        const resolved = await _aiResolveFromProjects(projects, factoryPrompt, summary)
        if (resolved) {
          projectId = resolved.projectId
          codebaseId = resolved.codebaseId
        } else {
          // AI couldn't resolve — surface for human
          disambiguationNeeded = true
          surfaceToHuman = true
          // Still pick the most active project as a suggestion
          projectId = projects[0].id
          codebaseId = projects[0].codebase_id
        }
      }
    }
  }

  // If no codebase from client context, try resolving from suggestedCodebase or prompt
  if (!codebaseId) {
    codebaseId = await _resolveCodebaseWithContext(suggestedCodebase, factoryPrompt, clientId)
  }

  const needsConfirmation = surfaceToHuman || (confidence !== null && confidence < 0.7) || disambiguationNeeded

  let request
  try {
    const [row] = await db`
      INSERT INTO code_requests (
        source, source_ref_id, client_id, project_id, codebase_id,
        summary, raw_prompt, code_work_type, confidence,
        needs_confirmation, status, metadata
      ) VALUES (
        'gmail', ${threadId}, ${clientId || null}, ${projectId},
        ${codebaseId}, ${summary}, ${factoryPrompt},
        ${codeWorkType}, ${confidence},
        ${needsConfirmation},
        ${needsConfirmation ? 'pending' : 'confirmed'},
        ${JSON.stringify({
          suggestedCodebase: suggestedCodebase || null,
          disambiguationNeeded,
        })}::jsonb
      )
      RETURNING *
    `
    request = row
  } catch (err) {
    // Unique constraint violation = duplicate (race condition with concurrent triage)
    if (err.code === '23505' && threadId) {
      const [existing] = await db`
        SELECT * FROM code_requests WHERE source = 'gmail' AND source_ref_id = ${threadId} LIMIT 1
      `
      if (existing) {
        logger.info(`Concurrent duplicate code request for thread ${threadId} — returning existing ${existing.id}`)
        return existing
      }
    }
    throw err
  }

  logger.info(`Code request created from email: ${request.id}`, {
    threadId, clientId, codeWorkType, confidence, needsConfirmation, codebaseId,
    suggestedCodebase, disambiguationNeeded,
  })

  if (needsConfirmation) {
    const actionQueue = require('./actionQueueService')
    await actionQueue.enqueue({
      source: 'gmail',
      sourceRefId: threadId,
      actionType: 'confirm_code_request',
      title: `Code request: ${summary.slice(0, 80)}`,
      summary: disambiguationNeeded
        ? `Multiple codebases — needs disambiguation. ${codeWorkType || 'Code work'}, confidence ${((confidence || 0) * 100).toFixed(0)}%`
        : `${codeWorkType || 'Code work'} — confidence ${((confidence || 0) * 100).toFixed(0)}%`,
      preparedData: {
        codeRequestId: request.id,
        prompt: factoryPrompt,
        codeWorkType,
        codebaseId,
        suggestedCodebase,
      },
      context: { source: 'gmail', threadId },
      priority: confidence >= 0.5 ? 'medium' : 'low',
    }).catch(err => {
      // Action queue failure is serious — the request becomes invisible to humans
      logger.error('CRITICAL: Failed to enqueue code request for human review', {
        codeRequestId: request.id, error: err.message,
      })
      // Mark it as needing attention so it shows up in dashboard queries
      db`UPDATE code_requests SET metadata = metadata || '{"actionQueueFailed": true}'::jsonb WHERE id = ${request.id}`.catch(() => {})
    })
  } else {
    await _dispatch(request)
  }

  return request
}

async function createFromSocial({ source, sourceRefId, clientId, summary, factoryPrompt, codeWorkType, suggestedCodebase, confidence, surfaceToHuman, replyContext }) {
  if (!factoryPrompt || typeof factoryPrompt !== 'string' || factoryPrompt.trim().length < 10) {
    logger.warn('Social code request rejected: factoryPrompt too short or missing', { source, sourceRefId })
    return null
  }
  if (!summary || typeof summary !== 'string') {
    summary = factoryPrompt.slice(0, 200)
  }
  if (!source || typeof source !== 'string') {
    logger.warn('Social code request rejected: source required')
    return null
  }

  confidence = _validateConfidence(confidence)
  codeWorkType = _sanitizeCodeWorkType(codeWorkType)

  // Dedup: prevent duplicate code requests from same source item
  if (sourceRefId) {
    const [existing] = await db`
      SELECT id, status FROM code_requests
      WHERE source = ${source} AND source_ref_id = ${String(sourceRefId)}
        AND status NOT IN ('rejected', 'completed')
      LIMIT 1
    `
    if (existing) {
      logger.info(`Duplicate social code request for ${source}/${sourceRefId} — existing ${existing.id} (${existing.status})`)
      return existing
    }
  }

  // Resolve project + codebase from client context (same logic as createFromEmail)
  let projectId = null
  let codebaseId = null
  let disambiguationNeeded = false

  if (clientId) {
    const projects = await db`
      SELECT p.id, p.name, p.description, cb.id AS codebase_id, cb.name AS codebase_name, cb.language
      FROM projects p
      LEFT JOIN codebases cb ON cb.project_id = p.id
      WHERE p.client_id = ${clientId} AND p.status = 'active'
    `

    if (projects.length === 1) {
      projectId = projects[0].id
      codebaseId = projects[0].codebase_id
    } else if (projects.length > 1) {
      if (suggestedCodebase && typeof suggestedCodebase === 'string') {
        const normalized = suggestedCodebase.toLowerCase().trim()
        const match = projects.find(p =>
          p.codebase_name?.toLowerCase() === normalized ||
          p.name?.toLowerCase() === normalized
        )
        if (match) {
          projectId = match.id
          codebaseId = match.codebase_id
        }
      }

      if (!codebaseId) {
        const resolved = await _aiResolveFromProjects(projects, factoryPrompt, summary)
        if (resolved) {
          projectId = resolved.projectId
          codebaseId = resolved.codebaseId
        } else {
          disambiguationNeeded = true
          surfaceToHuman = true
          projectId = projects[0].id
          codebaseId = projects[0].codebase_id
        }
      }
    }
  }

  if (!codebaseId) {
    codebaseId = await _resolveCodebaseWithContext(suggestedCodebase, factoryPrompt, clientId)
  }

  const needsConfirmation = surfaceToHuman || (confidence !== null && confidence < 0.7) || disambiguationNeeded

  let request
  try {
    const [row] = await db`
      INSERT INTO code_requests (
        source, source_ref_id, client_id, project_id, codebase_id,
        summary, raw_prompt, code_work_type, confidence,
        needs_confirmation, status, metadata, reply_context
      ) VALUES (
        ${source}, ${sourceRefId ? String(sourceRefId) : null}, ${clientId || null}, ${projectId},
        ${codebaseId}, ${summary}, ${factoryPrompt},
        ${codeWorkType}, ${confidence},
        ${needsConfirmation},
        ${needsConfirmation ? 'pending' : 'confirmed'},
        ${JSON.stringify({ suggestedCodebase: suggestedCodebase || null, disambiguationNeeded })}::jsonb,
        ${JSON.stringify(replyContext || {})}::jsonb
      )
      RETURNING *
    `
    request = row
  } catch (err) {
    if (err.code === '23505' && sourceRefId) {
      const [existing] = await db`
        SELECT * FROM code_requests WHERE source = ${source} AND source_ref_id = ${String(sourceRefId)} LIMIT 1
      `
      if (existing) return existing
    }
    throw err
  }

  logger.info(`Code request created from ${source}: ${request.id}`, {
    sourceRefId, clientId, codeWorkType, confidence, needsConfirmation, codebaseId,
  })

  // KG ingestion for code request creation
  kgHooks.onCodeRequestCreated({ request, source }).catch(() => {})

  if (needsConfirmation) {
    const actionQueue = require('./actionQueueService')
    await actionQueue.enqueue({
      source,
      sourceRefId: sourceRefId ? String(sourceRefId) : null,
      actionType: 'confirm_code_request',
      title: `Code request (${source}): ${summary.slice(0, 80)}`,
      summary: disambiguationNeeded
        ? `Multiple codebases — needs disambiguation. ${codeWorkType || 'Code work'}, confidence ${((confidence || 0) * 100).toFixed(0)}%`
        : `${codeWorkType || 'Code work'} — confidence ${((confidence || 0) * 100).toFixed(0)}%`,
      preparedData: {
        codeRequestId: request.id,
        prompt: factoryPrompt,
        codeWorkType,
        codebaseId,
        suggestedCodebase,
      },
      context: { source, sourceRefId },
      priority: confidence >= 0.5 ? 'medium' : 'low',
    }).catch(err => {
      logger.error('CRITICAL: Failed to enqueue social code request for human review', {
        codeRequestId: request.id, error: err.message,
      })
      db`UPDATE code_requests SET metadata = metadata || '{"actionQueueFailed": true}'::jsonb WHERE id = ${request.id}`.catch(() => {})
    })
  } else {
    await _dispatch(request)
  }

  return request
}

async function createFromCRM({ clientId, projectId, codebaseId, summary, prompt, sessionId }) {
  // Dedup: check for existing active request from same client with same session
  if (sessionId) {
    const [existing] = await db`
      SELECT id FROM code_requests WHERE source = 'crm' AND session_id = ${sessionId} LIMIT 1
    `
    if (existing) return existing
  }

  const [request] = await db`
    INSERT INTO code_requests (
      source, source_ref_id, client_id, project_id, codebase_id,
      summary, raw_prompt, code_work_type, status, session_id
    ) VALUES (
      'crm', ${clientId}, ${clientId || null}, ${projectId || null},
      ${codebaseId || null}, ${summary || prompt?.slice(0, 200) || 'CRM code request'}, ${prompt},
      'update', ${sessionId ? 'dispatched' : 'confirmed'},
      ${sessionId || null}
    )
    RETURNING *
  `

  logger.info(`Code request created from CRM: ${request.id}`, { clientId, projectId })

  if (!sessionId) {
    await _dispatch(request)
  }

  return request
}

async function createFromCortex({ summary, prompt, codebaseId, codebaseName, clientId, projectId, skipDispatch }) {
  if (!prompt || typeof prompt !== 'string' || prompt.trim().length < 5) {
    throw new Error('Cortex code request requires a non-empty prompt')
  }

  const [request] = await db`
    INSERT INTO code_requests (
      source, client_id, project_id, codebase_id,
      summary, raw_prompt, code_work_type, status
    ) VALUES (
      'cortex', ${clientId || null}, ${projectId || null},
      ${codebaseId || null}, ${summary || prompt?.slice(0, 200)},
      ${prompt}, 'feature', ${skipDispatch ? 'confirmed' : 'confirmed'}
    )
    RETURNING *
  `

  logger.info(`Code request created from Cortex: ${request.id}`)

  // When called from dispatchFromCortex, the session is already created — don't dispatch again
  if (!skipDispatch) {
    await _dispatch(request)
  }

  return request
}

async function confirmAndDispatch(codeRequestId, promptOverride) {
  const [request] = await db`
    SELECT * FROM code_requests WHERE id = ${codeRequestId}
  `
  if (!request) throw new Error(`Code request not found: ${codeRequestId}`)
  if (request.status === 'dispatched') throw new Error('Already dispatched')

  if (promptOverride && typeof promptOverride === 'string' && promptOverride.trim().length > 0) {
    await db`UPDATE code_requests SET raw_prompt = ${promptOverride} WHERE id = ${codeRequestId}`
    request.raw_prompt = promptOverride
  }

  await db`UPDATE code_requests SET status = 'confirmed', dispatch_attempts = 0 WHERE id = ${codeRequestId}`
  request.status = 'confirmed'

  return _dispatch(request)
}

// ─── AI Resolution: Pick codebase from multiple projects ────────────

async function _aiResolveFromProjects(projects, prompt, summary) {
  try {
    const { callDeepSeek } = require('./deepseekService')
    const projectList = projects.map(p =>
      `- Project "${p.name}" → codebase "${p.codebase_name || 'none'}" (${p.language || '?'})${p.description ? `: ${p.description.slice(0, 120)}` : ''}`
    ).join('\n')

    const response = await callDeepSeek([{
      role: 'user',
      content: `A code request has arrived but the client has multiple active projects. Which one is the target?

Projects:
${projectList}

Task summary: ${summary || ''}
Task prompt: ${(prompt || '').slice(0, 800)}

Respond with ONLY the exact project name that best matches the task, or "ambiguous" if you genuinely cannot tell. One word/phrase, nothing else.`,
    }], { module: 'code_request_resolution', skipRetrieval: true, temperature: 0.1 })

    const resolved = response.trim().replace(/['"]/g, '').toLowerCase()
    if (resolved === 'ambiguous' || resolved === 'none' || resolved.length === 0) return null

    const match = projects.find(p =>
      p.name.toLowerCase() === resolved ||
      p.codebase_name?.toLowerCase() === resolved
    )

    if (match) {
      logger.info(`AI project resolution: "${resolved}" → project ${match.name}`)
      return { projectId: match.id, codebaseId: match.codebase_id }
    }

    // Fuzzy fallback: check if the AI response contains any project name
    const fuzzyMatch = projects.find(p =>
      resolved.includes(p.name.toLowerCase()) ||
      (p.codebase_name && resolved.includes(p.codebase_name.toLowerCase()))
    )
    if (fuzzyMatch) {
      logger.info(`AI project resolution (fuzzy): "${resolved}" → project ${fuzzyMatch.name}`)
      return { projectId: fuzzyMatch.id, codebaseId: fuzzyMatch.codebase_id }
    }

    logger.debug(`AI project resolution returned unrecognized value: "${resolved}"`)
    return null
  } catch (err) {
    logger.warn('AI project resolution failed', { error: err.message })
    return null
  }
}

// ─── Codebase Resolution with Context ────────────────────────────────

async function _resolveCodebaseWithContext(suggestedCodebase, prompt, clientId) {
  const triggers = require('./factoryTriggerService')

  // Try the suggested codebase name first (from triage AI)
  if (suggestedCodebase && typeof suggestedCodebase === 'string' && suggestedCodebase.trim().length > 0) {
    const [cb] = await db`SELECT id FROM codebases WHERE name ILIKE ${suggestedCodebase.trim()} LIMIT 1`
    if (cb) {
      logger.info(`Codebase resolved from triage suggestion: "${suggestedCodebase}"`)
      return cb.id
    }
  }

  // Fall back to the standard AI resolver with richer context
  return triggers.resolveCodebase({ prompt, codebaseName: suggestedCodebase, clientId })
}

// ─── Pre-Dispatch Prompt Enrichment ──────────────────────────────────
//
// Before the prompt hits CC, enrich it with:
//   - Codebase name, language, tech stack
//   - Recent session outcomes in this codebase (what worked, what failed)
//   - Relevant code structure summary (from codebase intelligence)
//   - KG context about the client/project
//
// This ensures CC starts with orientation, not a cold search.
// IMPORTANT: Enrichment failures must never block dispatch.

async function _enrichPrompt(rawPrompt, codebaseId, clientId) {
  const sections = []

  try {
    if (codebaseId) {
      // Codebase identity
      const [codebase] = await db`SELECT name, language, repo_path, meta FROM codebases WHERE id = ${codebaseId}`
      if (codebase) {
        sections.push(`Target codebase: ${codebase.name} (${codebase.language || 'unknown'}, ${codebase.repo_path || 'no path'})`)
      }

      // Recent session history — what succeeded and failed in this codebase
      const recentSessions = await db`
        SELECT initial_prompt, status, confidence_score, pipeline_stage,
               files_changed, error_message
        FROM cc_sessions
        WHERE codebase_id = ${codebaseId}
          AND started_at > now() - interval '14 days'
        ORDER BY started_at DESC LIMIT 5
      `
      if (recentSessions.length > 0) {
        const sessionLines = recentSessions.map(s => {
          const files = Array.isArray(s.files_changed) ? s.files_changed.length : 0
          const conf = s.confidence_score != null ? ` (${(s.confidence_score * 100).toFixed(0)}% confidence)` : ''
          return `  [${s.status}${conf}] ${(s.initial_prompt || '').slice(0, 100)}${files > 0 ? ` — ${files} files changed` : ''}${s.error_message ? ` — ERROR: ${s.error_message.slice(0, 80)}` : ''}`
        })
        sections.push(`Recent sessions in this codebase (14d):\n${sessionLines.join('\n')}`)
      }

      // Codebase structure summary (from codebase intelligence)
      try {
        const codebaseIntelligence = require('./codebaseIntelligenceService')
        const structure = await codebaseIntelligence.getCodebaseStructure(codebaseId)
        if (structure?.summary) {
          sections.push(`Codebase structure:\n${structure.summary.slice(0, 1500)}`)
        }
      } catch (err) {
        logger.debug('Codebase intelligence not available for enrichment', { error: err.message })
      }

      // Relevant learnings for this codebase
      const learnings = await db`
        SELECT pattern_description, confidence, pattern_type
        FROM factory_learnings
        WHERE absorbed_into IS NULL
          AND codebase_id = ${codebaseId}
          AND confidence >= 0.5
          AND pattern_type IN ('success_template', 'constraint')
        ORDER BY confidence DESC LIMIT 3
      `.catch(err => {
        logger.debug('Failed to fetch factory learnings for enrichment', { error: err.message })
        return []
      })
      if (learnings.length > 0) {
        sections.push(`Known patterns for this codebase:\n${learnings.map(l =>
          `  [${l.pattern_type}] ${(l.pattern_description || '').slice(0, 120)}`
        ).join('\n')}`)
      }
    }

    // Client context (if known)
    if (clientId) {
      const clients = await db`
        SELECT c.name, c.status, p.name AS project_name, p.description AS project_desc
        FROM clients c
        LEFT JOIN projects p ON p.client_id = c.id AND p.status = 'active'
        WHERE c.id = ${clientId}
        ORDER BY p.created_at DESC LIMIT 1
      `.catch(err => {
        logger.debug('Failed to fetch client context for enrichment', { error: err.message })
        return []
      })
      const client = clients[0]
      if (client) {
        sections.push(`Client: ${client.name}, status: ${client.status}${client.project_name ? `, project: ${client.project_name}` : ''}`)
      }
    }
  } catch (err) {
    // Enrichment must NEVER block dispatch — return raw prompt on any failure
    logger.warn('Prompt enrichment failed, dispatching with raw prompt', { error: err.message })
    return rawPrompt
  }

  if (sections.length === 0) return rawPrompt

  return `${rawPrompt}

--- CONTEXT (pre-assembled by code request service) ---
${sections.join('\n\n')}
--- END CONTEXT ---`
}

// ─── Dispatch ────────────────────────────────────────────────────────

async function _dispatch(request) {
  try {
    const triggers = require('./factoryTriggerService')

    // Track dispatch attempts
    await db`
      UPDATE code_requests
      SET dispatch_attempts = COALESCE(dispatch_attempts, 0) + 1
      WHERE id = ${request.id}
    `.catch(() => {})

    // Check max attempts
    const currentAttempts = (request.dispatch_attempts || 0) + 1
    if (currentAttempts > MAX_DISPATCH_ATTEMPTS) {
      logger.error(`Code request ${request.id} exceeded max dispatch attempts (${MAX_DISPATCH_ATTEMPTS})`)
      await db`
        UPDATE code_requests
        SET status = 'pending', needs_confirmation = true,
            last_error = 'Exceeded max dispatch attempts',
            metadata = metadata || '{"dispatchFailed": true}'::jsonb
        WHERE id = ${request.id}
      `
      await _enqueueDispatchFailure(request, 'Exceeded max dispatch attempts')
      return null
    }

    // Resolve codebase if not already set
    let codebaseId = request.codebase_id
    if (!codebaseId) {
      codebaseId = await _resolveCodebaseWithContext(
        request.metadata?.suggestedCodebase,
        request.raw_prompt,
        request.client_id
      )
    }

    // Enrich the prompt with codebase intelligence before dispatch
    const enrichedPrompt = await _enrichPrompt(request.raw_prompt, codebaseId, request.client_id)

    // Update the stored prompt so oversight/learnings see the enriched version
    if (enrichedPrompt !== request.raw_prompt) {
      await db`UPDATE code_requests SET raw_prompt = ${enrichedPrompt} WHERE id = ${request.id}`
    }

    const session = await triggers.dispatchFromCortex(enrichedPrompt, {
      codebaseId,
      triggerSource: request.source,
      triggerRefId: request.source_ref_id || request.id,
      projectId: request.project_id,
      clientId: request.client_id,
    })

    if (session) {
      await linkSession(request.id, session.id)
      logger.info(`Code request ${request.id} dispatched → session ${session.id}`, { codebaseId })
    } else {
      // Dispatch was suppressed (dedup) — mark as pending for human review
      await db`
        UPDATE code_requests
        SET status = 'pending', needs_confirmation = true,
            last_error = 'Dispatch suppressed by dedup gate'
        WHERE id = ${request.id}
      `
      await _enqueueDispatchFailure(request, 'Dispatch suppressed — similar session exists or failure pattern matched')
      logger.info(`Code request ${request.id} dispatch suppressed — surfaced for review`)
    }

    return session
  } catch (err) {
    const errorMsg = err.message || 'Unknown dispatch error'
    logger.error(`Code request dispatch failed: ${request.id}`, { error: errorMsg })
    await db`
      UPDATE code_requests
      SET status = 'pending', needs_confirmation = true,
          last_error = ${errorMsg.slice(0, 500)}
      WHERE id = ${request.id}
    `.catch(() => {})

    // Surface the failure to human review so it doesn't get lost
    await _enqueueDispatchFailure(request, errorMsg)
    return null
  }
}

// ─── Surface dispatch failures to action queue ──────────────────────

async function _enqueueDispatchFailure(request, errorMsg) {
  try {
    const actionQueue = require('./actionQueueService')
    await actionQueue.enqueue({
      source: request.source || 'factory',
      sourceRefId: request.source_ref_id || request.id,
      actionType: 'confirm_code_request',
      title: `Dispatch failed: ${(request.summary || '').slice(0, 60)}`,
      summary: `${request.code_work_type || 'Code work'} dispatch failed: ${(errorMsg || '').slice(0, 150)}. Needs manual review/retry.`,
      preparedData: {
        codeRequestId: request.id,
        prompt: request.raw_prompt,
        codeWorkType: request.code_work_type,
        codebaseId: request.codebase_id,
        error: errorMsg,
      },
      context: { source: request.source, dispatchFailed: true },
      priority: 'medium',
    })
  } catch (err) {
    logger.error('CRITICAL: Failed to enqueue dispatch failure for human review', {
      codeRequestId: request.id, error: err.message,
    })
  }
}

async function linkSession(codeRequestId, sessionId) {
  await db`
    UPDATE code_requests
    SET session_id = ${sessionId}, status = 'dispatched'
    WHERE id = ${codeRequestId}
  `
}

async function markCompleted(codeRequestId) {
  await db`
    UPDATE code_requests
    SET status = 'completed', resolved_at = now()
    WHERE id = ${codeRequestId}
  `
}

async function getActive(status) {
  if (status) {
    return db`
      SELECT cr.*, c.name AS client_name, p.name AS project_name, cb.name AS codebase_name
      FROM code_requests cr
      LEFT JOIN clients c ON cr.client_id = c.id
      LEFT JOIN projects p ON cr.project_id = p.id
      LEFT JOIN codebases cb ON cr.codebase_id = cb.id
      WHERE cr.status = ${status}
      ORDER BY cr.created_at DESC LIMIT 50
    `
  }
  return db`
    SELECT cr.*, c.name AS client_name, p.name AS project_name, cb.name AS codebase_name
    FROM code_requests cr
    LEFT JOIN clients c ON cr.client_id = c.id
    LEFT JOIN projects p ON cr.project_id = p.id
    LEFT JOIN codebases cb ON cr.codebase_id = cb.id
    ORDER BY cr.created_at DESC LIMIT 50
  `
}

// ─── Recover stuck requests ─────────────────────────────────────────
// Called by maintenance worker to find and retry stuck code requests

async function recoverStuckRequests() {
  // Find requests stuck in 'confirmed' for >5 min (should have been dispatched)
  const stuck = await db`
    SELECT * FROM code_requests
    WHERE status = 'confirmed'
      AND session_id IS NULL
      AND created_at < now() - interval '5 minutes'
      AND COALESCE(dispatch_attempts, 0) < ${MAX_DISPATCH_ATTEMPTS}
    ORDER BY created_at ASC LIMIT 5
  `

  if (stuck.length === 0) return { recovered: 0 }

  let recovered = 0
  for (const request of stuck) {
    logger.info(`Recovering stuck code request: ${request.id} (created ${request.created_at})`)
    const session = await _dispatch(request)
    if (session) recovered++
  }

  return { recovered, total: stuck.length }
}

module.exports = {
  createFromEmail,
  createFromSocial,
  createFromCRM,
  createFromCortex,
  confirmAndDispatch,
  linkSession,
  markCompleted,
  getActive,
  recoverStuckRequests,
}
