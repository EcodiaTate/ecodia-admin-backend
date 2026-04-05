const db = require('../config/db')
const logger = require('../config/logger')

// ═══════════════════════════════════════════════════════════════════════
// CODE REQUEST SERVICE — Bridge between intake (email/CRM/Cortex) and Factory
//
// Every code request from any source flows through here. Creates a
// code_requests row, decides whether to auto-dispatch or surface for
// human confirmation, and links the resulting CC session back.
// ═══════════════════════════════════════════════════════════════════════

async function createFromEmail({ threadId, clientId, summary, factoryPrompt, codeWorkType, confidence, surfaceToHuman }) {
  // Resolve project from client if available
  let projectId = null
  let codebaseId = null
  if (clientId) {
    const [project] = await db`
      SELECT p.id, cb.id AS codebase_id
      FROM projects p
      LEFT JOIN codebases cb ON cb.project_id = p.id
      WHERE p.client_id = ${clientId} AND p.status = 'active'
      ORDER BY p.created_at DESC LIMIT 1
    `
    if (project) {
      projectId = project.id
      codebaseId = project.codebase_id
    }
  }

  const needsConfirmation = surfaceToHuman || confidence < 0.7

  const [request] = await db`
    INSERT INTO code_requests (
      source, source_ref_id, client_id, project_id, codebase_id,
      summary, raw_prompt, code_work_type, confidence,
      needs_confirmation, status
    ) VALUES (
      'gmail', ${threadId}, ${clientId || null}, ${projectId},
      ${codebaseId}, ${summary}, ${factoryPrompt},
      ${codeWorkType || null}, ${confidence || null},
      ${needsConfirmation}, ${needsConfirmation ? 'pending' : 'confirmed'}
    )
    RETURNING *
  `

  logger.info(`Code request created from email: ${request.id}`, {
    threadId, clientId, codeWorkType, confidence, needsConfirmation,
  })

  if (needsConfirmation) {
    // Surface to action queue for human review
    const actionQueue = require('./actionQueueService')
    await actionQueue.enqueue({
      source: 'gmail',
      sourceRefId: threadId,
      actionType: 'confirm_code_request',
      title: `Code request: ${summary.slice(0, 80)}`,
      summary: `${codeWorkType || 'Code work'} — confidence ${((confidence || 0) * 100).toFixed(0)}%`,
      preparedData: {
        codeRequestId: request.id,
        prompt: factoryPrompt,
        codeWorkType,
        codebaseId,
      },
      context: { source: 'gmail', threadId },
      priority: confidence >= 0.5 ? 'medium' : 'low',
    }).catch(err => logger.debug('Failed to enqueue code request', { error: err.message }))
  } else {
    // High confidence — auto-dispatch
    await _dispatch(request)
  }

  return request
}

async function createFromCRM({ clientId, projectId, codebaseId, summary, prompt, sessionId }) {
  const [request] = await db`
    INSERT INTO code_requests (
      source, source_ref_id, client_id, project_id, codebase_id,
      summary, raw_prompt, code_work_type, status, session_id
    ) VALUES (
      'crm', ${clientId}, ${clientId || null}, ${projectId || null},
      ${codebaseId || null}, ${summary}, ${prompt},
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

async function createFromCortex({ summary, prompt, codebaseId, codebaseName, clientId, projectId }) {
  const [request] = await db`
    INSERT INTO code_requests (
      source, client_id, project_id, codebase_id,
      summary, raw_prompt, code_work_type, status
    ) VALUES (
      'cortex', ${clientId || null}, ${projectId || null},
      ${codebaseId || null}, ${summary || prompt?.slice(0, 200)},
      ${prompt}, 'feature', 'confirmed'
    )
    RETURNING *
  `

  logger.info(`Code request created from Cortex: ${request.id}`)
  await _dispatch(request)
  return request
}

async function confirmAndDispatch(codeRequestId, promptOverride) {
  const [request] = await db`
    SELECT * FROM code_requests WHERE id = ${codeRequestId}
  `
  if (!request) throw new Error(`Code request not found: ${codeRequestId}`)
  if (request.status === 'dispatched') throw new Error('Already dispatched')

  if (promptOverride) {
    await db`UPDATE code_requests SET raw_prompt = ${promptOverride} WHERE id = ${codeRequestId}`
    request.raw_prompt = promptOverride
  }

  await db`UPDATE code_requests SET status = 'confirmed' WHERE id = ${codeRequestId}`
  request.status = 'confirmed'

  return _dispatch(request)
}

async function _dispatch(request) {
  try {
    const triggers = require('./factoryTriggerService')

    // Resolve codebase if not already set
    let codebaseId = request.codebase_id
    if (!codebaseId) {
      codebaseId = await triggers.resolveCodebase({ prompt: request.raw_prompt })
    }

    const session = await triggers.dispatchFromCortex(request.raw_prompt, {
      codebaseId,
      triggerSource: request.source,
      triggerRefId: request.source_ref_id || request.id,
      projectId: request.project_id,
      clientId: request.client_id,
    })

    if (session) {
      await linkSession(request.id, session.id)
      logger.info(`Code request ${request.id} dispatched → session ${session.id}`)
    } else {
      // Dispatch suppressed (dedup or rate limit) — mark pending so it can be retried
      await db`UPDATE code_requests SET status = 'pending', needs_confirmation = true WHERE id = ${request.id}`
      logger.info(`Code request ${request.id} dispatch suppressed — reverted to pending`)
    }

    return session
  } catch (err) {
    logger.error(`Code request dispatch failed: ${request.id}`, { error: err.message })
    await db`UPDATE code_requests SET status = 'pending', needs_confirmation = true WHERE id = ${request.id}`
    return null
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

module.exports = {
  createFromEmail,
  createFromCRM,
  createFromCortex,
  confirmAndDispatch,
  linkSession,
  markCompleted,
  getActive,
}
