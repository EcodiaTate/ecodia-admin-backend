/**
 * OS Cortex Service — practical operations assistant.
 * Completely separate from organism cortexService.js.
 * Zero organism imports. Uses only: callDeepSeek, capabilityRegistry, db, logger, wsManager.
 *
 * The Command workspace runs an orchestration engine inspired by Claude Code:
 * - Unlimited reasoning steps (think blocks)
 * - Parallel delegations to multiple departments simultaneously
 * - Mid-plan questions to the human
 * - Adaptive replanning based on intermediate results
 * - Direct capability execution (no delegation needed for simple actions)
 * - Real-time WebSocket streaming of orchestration progress
 */

const { callDeepSeek } = require('./deepseekService')
const registry = require('./capabilityRegistry')
const db = require('../config/db')
const logger = require('../config/logger')
const { broadcast } = require('../websocket/wsManager')
const { getWorkspace, listWorkspaces } = require('./osWorkspaceDefinitions')

const MAX_HISTORY_TURNS = parseInt(process.env.OS_MAX_HISTORY_TURNS || '20')
const TASK_TIMEOUT_MS = parseInt(process.env.OS_TASK_TIMEOUT_MS || '280000') // under nginx 300s
const COMMAND_MAX_ROUNDS = parseInt(process.env.COMMAND_MAX_ROUNDS || '50') // command gets way more rounds

// ═══════════════════════════════════════════════════════════════════════
// PROMPT BUILDING — focused, small, workspace-scoped
// ═══════════════════════════════════════════════════════════════════════

async function getCoreContext() {
  const rows = await db`SELECT facts FROM os_core_context LIMIT 1`
  if (!rows.length) return []
  const facts = rows[0].facts
  if (Array.isArray(facts)) return facts
  if (facts && typeof facts === 'object') return Object.entries(facts).map(([key, value]) => ({ key, value }))
  return []
}

async function loadDocs(docKeys) {
  if (!docKeys || docKeys.length === 0) return []
  const docs = await db`SELECT key, title, content FROM os_docs WHERE key = ANY(${docKeys})`
  return docs
}

async function runStateQueries(queries) {
  const results = {}
  for (const [label, sql] of Object.entries(queries || {})) {
    try {
      const rows = await db.unsafe(sql)
      if (rows.length === 1 && rows[0].count !== undefined) {
        results[label] = rows[0].count
      } else if (rows.length <= 10) {
        results[label] = rows
      } else {
        results[label] = rows.slice(0, 10)
      }
    } catch (err) {
      results[label] = `(query failed: ${err.message})`
    }
  }
  return results
}

function formatCapabilities(domains) {
  const lines = []
  for (const domain of domains) {
    const desc = registry.describeForAI({ domain, tier: 'write' })
    if (desc) lines.push(desc)
    const readDesc = registry.describeForAI({ domain, tier: 'read' })
    if (readDesc) lines.push(readDesc)
  }
  return lines.join('\n')
}

async function listAllDocs(workspace) {
  if (workspace) {
    return db`SELECT key, title, workspace, updated_by, updated_at FROM os_docs WHERE workspace = ${workspace} OR workspace IS NULL ORDER BY workspace NULLS LAST, key`
  }
  return db`SELECT key, title, workspace, updated_by, updated_at FROM os_docs ORDER BY workspace NULLS LAST, key`
}

async function buildSystemPrompt(workspaceName) {
  let ws = workspaceName ? getWorkspace(workspaceName) : null

  // Load core facts always
  const coreFacts = await getCoreContext()
  const factsBlock = coreFacts.map(f => `${f.key}: ${f.value}`).join('\n')

  // If no workspace specified, default to "command" — the boss mode with all capabilities
  if (!ws) {
    ws = getWorkspace('command')
    if (!ws) {
      // Fallback if command workspace somehow doesn't exist
      const workspaceList = listWorkspaces().map(w => `- ${w.name}: ${w.description}`).join('\n')
      return `You are a practical operations assistant for Ecodia Pty Ltd. Switch to a workspace for focused tools:\n${workspaceList}`
    }
  }

  // Workspace-activated prompt
  const [stateResults, allDocs] = await Promise.all([
    runStateQueries(ws.stateQueries),
    listAllDocs(ws.name),
  ])

  const stateLines = Object.entries(stateResults).map(([label, val]) => {
    if (typeof val === 'number' || typeof val === 'string') return `${label}: ${val}`
    if (Array.isArray(val)) {
      // Compact row format: pick key fields, skip nulls
      const compact = val.map(r => {
        const parts = Object.entries(r).filter(([, v]) => v != null && v !== '').map(([k, v]) => `${k}=${v}`)
        return '  ' + parts.join(' | ')
      })
      return `${label}:\n${compact.join('\n')}`
    }
    return `${label}: ${JSON.stringify(val)}`
  }).join('\n')

  // All docs listed as on-demand — no auto-loading into prompt
  const docList = allDocs.length > 0
    ? `Docs (use need_doc to load): ${allDocs.map(d => d.key).join(', ')}`
    : ''

  const capsBlock = formatCapabilities(ws.domains)

  return `You are a practical operations assistant. Execute tasks by returning JSON blocks. Be direct — do the work, don't explain what you could do.

${factsBlock ? `FACTS: ${factsBlock}` : ''}

WORKSPACE: ${ws.label}
${ws.systemPromptAddition}

STATE:
${stateLines || '(no live state)'}

${docList}

ACTIONS:
${capsBlock}

FORMAT: JSON array of blocks. Types:
  think: {"type":"think","content":"..."} — your reasoning process, visible to human as live thinking
  text: {"type":"text","content":"..."} — response to human
  action: {"type":"action_card","action":"name","params":{...}} — execute a capability
  delegate: {"type":"delegate","workspace":"name","prompt":"task description"} — runs a sub-task in another workspace (multiple delegations run in parallel)
  load doc: {"type":"need_doc","docKey":"..."}
  save doc: {"type":"update_doc","docKey":"...","title":"...","content":"...","workspace":"..."}
  update fact: {"type":"update_context","key":"...","value":"..."}
  ask human: {"type":"question","content":"..."} — pauses and asks the human
  done: {"type":"done","summary":"..."} — signals task completion

Return ONLY the JSON array. Execute immediately. Multiple actions + delegations per response OK. After results come back, continue or signal done.`
}

// ═══════════════════════════════════════════════════════════════════════
// BLOCK PARSING — same robust strategy as cortex, no dependency on it
// ═══════════════════════════════════════════════════════════════════════

function parseBlocks(raw) {
  if (!raw || typeof raw !== 'string') return [{ type: 'text', content: String(raw || '') }]
  const trimmed = raw.trim()
  const isBlock = (v) => v && typeof v === 'object' && typeof v.type === 'string'
  const isBlockArray = (v) => Array.isArray(v) && v.length > 0 && v.every(isBlock)

  // 1. Pure JSON — most common success path
  try {
    const parsed = JSON.parse(trimmed)
    if (isBlockArray(parsed)) return parsed
    if (parsed?.blocks && isBlockArray(parsed.blocks)) return parsed.blocks
    if (isBlock(parsed)) return [parsed]
  } catch { /* not pure JSON */ }

  // 2. Fenced JSON
  const fenceMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/)
  if (fenceMatch) {
    try {
      const parsed = JSON.parse(fenceMatch[1].trim())
      if (isBlockArray(parsed)) return parsed
      if (isBlock(parsed)) return [parsed]
    } catch { /* fall through */ }
  }

  // 3. Extract JSON array with proper bracket matching
  const arrayStart = trimmed.indexOf('[')
  if (arrayStart !== -1) {
    let depth = 0, inStr = false, esc = false
    for (let i = arrayStart; i < trimmed.length; i++) {
      const ch = trimmed[i]
      if (esc) { esc = false; continue }
      if (ch === '\\') { esc = true; continue }
      if (ch === '"') { inStr = !inStr; continue }
      if (inStr) continue
      if (ch === '[') depth++
      else if (ch === ']') {
        depth--
        if (depth === 0) {
          try {
            const parsed = JSON.parse(trimmed.slice(arrayStart, i + 1))
            if (isBlockArray(parsed)) return parsed
          } catch { /* try next bracket */ }
          break
        }
      }
    }
  }

  // 4. Find individual JSON objects with "type" field scattered in prose
  const blocks = []
  const proseChunks = []
  let lastEnd = 0
  const objPattern = /\{[^{}]*"type"\s*:\s*"[^"]+"/g
  let match
  while ((match = objPattern.exec(trimmed)) !== null) {
    const start = match.index
    let depth = 0, inStr = false, esc = false, end = -1
    for (let i = start; i < trimmed.length; i++) {
      const ch = trimmed[i]
      if (esc) { esc = false; continue }
      if (ch === '\\') { esc = true; continue }
      if (ch === '"') { inStr = !inStr; continue }
      if (inStr) continue
      if (ch === '{') depth++
      else if (ch === '}') {
        depth--
        if (depth === 0) { end = i; break }
      }
    }
    if (end === -1) continue
    try {
      const parsed = JSON.parse(trimmed.slice(start, end + 1))
      if (isBlock(parsed)) {
        const prose = trimmed.slice(lastEnd, start).trim()
        if (prose) proseChunks.push(prose)
        blocks.push(parsed)
        lastEnd = end + 1
      }
    } catch { /* not valid JSON at this position */ }
  }

  if (blocks.length > 0) {
    const trailing = trimmed.slice(lastEnd).trim()
    if (trailing) proseChunks.push(trailing)
    if (proseChunks.length > 0) {
      blocks.unshift({ type: 'text', content: proseChunks.join('\n\n') })
    }
    return blocks
  }

  // 5. Nothing parsed — return as text
  return [{ type: 'text', content: trimmed }]
}

// ═══════════════════════════════════════════════════════════════════════
// TASK SESSION PERSISTENCE
// ═══════════════════════════════════════════════════════════════════════

async function loadTaskSession(taskId) {
  if (!taskId) return null
  const rows = await db`SELECT * FROM os_task_sessions WHERE id = ${taskId}`
  return rows[0] || null
}

async function createTaskSession(workspace, title) {
  const [row] = await db`
    INSERT INTO os_task_sessions (workspace, title, status, history)
    VALUES (${workspace}, ${title || null}, 'active', '[]'::jsonb)
    RETURNING *`
  return row
}

async function persistTurn(taskId, turn) {
  await db`
    UPDATE os_task_sessions
    SET history = history || ${JSON.stringify([turn])}::jsonb,
        updated_at = now()
    WHERE id = ${taskId}`
}

async function updateTaskStatus(taskId, status, title) {
  const updates = { status, updated_at: new Date() }
  if (title) updates.title = title
  await db`UPDATE os_task_sessions SET ${db(updates)} WHERE id = ${taskId}`
}

// ═══════════════════════════════════════════════════════════════════════
// DOC MANAGEMENT
// ═══════════════════════════════════════════════════════════════════════

async function getDoc(key) {
  const rows = await db`SELECT * FROM os_docs WHERE key = ${key}`
  return rows[0] || null
}

async function upsertDoc(key, title, content, workspace, updatedBy = 'ai') {
  await db`
    INSERT INTO os_docs (key, title, content, workspace, updated_by, updated_at)
    VALUES (${key}, ${title}, ${content}, ${workspace || null}, ${updatedBy}, now())
    ON CONFLICT (key) DO UPDATE SET
      title = EXCLUDED.title,
      content = EXCLUDED.content,
      updated_by = EXCLUDED.updated_by,
      updated_at = now()`
}

async function updateCoreContextFact(key, value) {
  // Atomic: update the fact in the JSONB array, or add if not present
  const ctx = await getCoreContext()
  const idx = ctx.findIndex(f => f.key === key)
  if (idx >= 0) ctx[idx].value = value
  else ctx.push({ key, value })
  await db`UPDATE os_core_context SET facts = ${JSON.stringify(ctx)}::jsonb, updated_at = now()`
}

// ═══════════════════════════════════════════════════════════════════════
// WEBSOCKET PROGRESS STREAMING — live updates to frontend
// ═══════════════════════════════════════════════════════════════════════

function emitProgress(taskId, event, data) {
  try {
    broadcast('os:progress', { taskId, event, ...data, ts: Date.now() })
  } catch { /* WS failure must never crash the task */ }
}

// ═══════════════════════════════════════════════════════════════════════
// DELEGATION EXECUTION — runs sub-tasks, supports parallel execution
// ═══════════════════════════════════════════════════════════════════════

async function executeDelegation(del, taskId) {
  const targetWs = del.workspace
  const targetPrompt = del.prompt
  if (!targetWs || !targetPrompt) {
    return { type: 'delegate_result', workspace: targetWs, success: false, error: 'Missing workspace or prompt' }
  }

  try {
    logger.info(`OS Cortex delegating to ${targetWs}: ${targetPrompt.slice(0, 80)}`)
    emitProgress(taskId, 'delegation_start', { workspace: targetWs, prompt: targetPrompt.slice(0, 200) })

    const subResult = await runTask(null, [{ role: 'user', content: targetPrompt }], { workspace: targetWs })
    const subBlocks = subResult.blocks || []
    const textContent = subBlocks
      .filter(b => b.type === 'text' || b.type === 'done')
      .map(b => b.content || b.summary || '')
      .join('\n')
    const actionResults = subBlocks
      .filter(b => b.type === 'action_result')
      .map(b => `${b.action}: ${b.success ? JSON.stringify(b.result).slice(0, 500) : b.error}`)
      .join('\n')

    const result = {
      type: 'delegate_result',
      workspace: targetWs,
      prompt: targetPrompt.slice(0, 200),
      success: true,
      result: textContent || actionResults || '(no output)',
      rounds: subResult.rounds,
    }
    emitProgress(taskId, 'delegation_complete', { workspace: targetWs, success: true, rounds: subResult.rounds })
    return result
  } catch (err) {
    logger.warn(`OS Cortex delegation to ${targetWs} failed`, { error: err.message })
    emitProgress(taskId, 'delegation_complete', { workspace: targetWs, success: false, error: err.message })
    return { type: 'delegate_result', workspace: targetWs, prompt: targetPrompt.slice(0, 200), success: false, error: err.message }
  }
}

// ═══════════════════════════════════════════════════════════════════════
// ACTION EXECUTION — run capability registry actions with dedup
// ═══════════════════════════════════════════════════════════════════════

async function executeActions(actions, failedActions, taskId) {
  const resultParts = []
  const resultBlocks = []
  const seenThisRound = new Set()

  for (const action of actions) {
    const actionKey = `${action.action}:${JSON.stringify(action.params || {})}`

    if (seenThisRound.has(actionKey)) {
      resultParts.push(`⊘ ${action.action}: skipped duplicate`)
      continue
    }
    seenThisRound.add(actionKey)

    const priorFailures = failedActions.get(actionKey) || 0
    if (priorFailures >= 1) {
      resultParts.push(`⊘ ${action.action}: skipped — already failed. Try different params or approach.`)
      resultBlocks.push({ type: 'action_result', action: action.action, success: false, error: 'Already failed — skipped retry' })
      continue
    }

    emitProgress(taskId, 'action_start', { action: action.action })

    try {
      const result = await registry.execute(action.action, action.params, { source: 'os' })
      if (result && result.success === false) {
        failedActions.set(actionKey, priorFailures + 1)
        resultParts.push(`✗ ${action.action}: ${result.error || 'failed'}`)
        resultBlocks.push({ type: 'action_result', action: action.action, success: false, error: result.error || 'failed' })
      } else {
        resultParts.push(`✓ ${action.action}: ${JSON.stringify(result.result || result).slice(0, 500)}`)
        resultBlocks.push({ type: 'action_result', action: action.action, success: true, result: result.result || result })
      }
    } catch (err) {
      failedActions.set(actionKey, priorFailures + 1)
      resultParts.push(`✗ ${action.action}: ${err.message}`)
      resultBlocks.push({ type: 'action_result', action: action.action, success: false, error: err.message })
    }
  }

  return { resultParts, resultBlocks }
}

// ═══════════════════════════════════════════════════════════════════════
// MAIN EXECUTION LOOP — orchestration engine for Command, standard loop for others
// ═══════════════════════════════════════════════════════════════════════

async function runTask(taskId, userMessages, { workspace }) {
  const startTime = Date.now()
  const isCommand = workspace === 'command'

  // Load or create task session
  let session = taskId ? await loadTaskSession(taskId) : null
  if (!session) {
    session = await createTaskSession(workspace || 'general', null)
    taskId = session.id
  }

  // Build system prompt
  const systemPrompt = await buildSystemPrompt(workspace)

  // Reconstruct message history from session (last N turns)
  const history = (session.history || []).slice(-MAX_HISTORY_TURNS)
  const validHistory = history
    .filter(t => t.role && t.content && (t.role === 'user' || t.role === 'assistant'))
    .map(t => ({ role: t.role, content: typeof t.content === 'string' ? t.content : JSON.stringify(t.content) }))
  const messages = [
    { role: 'system', content: systemPrompt },
    ...validHistory,
    ...userMessages.filter(m => m.role && m.content),
  ]

  // Persist user turn
  for (const msg of userMessages) {
    await persistTurn(taskId, { ts: new Date().toISOString(), role: msg.role, content: msg.content })
  }

  const allBlocks = []
  const failedActions = new Map()
  let rounds = 0
  let taskStatus = 'active'
  const MAX_ROUNDS = isCommand ? COMMAND_MAX_ROUNDS : 20

  if (isCommand) {
    emitProgress(taskId, 'orchestration_start', { workspace })
  }

  while (Date.now() - startTime < TASK_TIMEOUT_MS && rounds < MAX_ROUNDS) {
    rounds++
    logger.info(`OS Cortex round ${rounds}`, { taskId, workspace, messageCount: messages.length })

    if (isCommand) {
      emitProgress(taskId, 'round_start', { round: rounds })
    }

    // Call LLM — Command gets higher temperature for creative orchestration
    const raw = await callDeepSeek(messages, {
      module: 'os',
      skipRetrieval: true,
      skipLogging: true,
      temperature: isCommand ? 0.3 : 0.1,
    })

    const blocks = parseBlocks(raw)

    // Extract block types
    const thinkBlocks = blocks.filter(b => b.type === 'think')
    const actions = blocks.filter(b => b.type === 'action_card')
    const delegations = blocks.filter(b => b.type === 'delegate')
    const docRequests = blocks.filter(b => b.type === 'need_doc')
    const docUpdates = blocks.filter(b => b.type === 'update_doc')
    const contextUpdates = blocks.filter(b => b.type === 'update_context')
    const questions = blocks.filter(b => b.type === 'question')
    const doneBlocks = blocks.filter(b => b.type === 'done')
    const textBlocks = blocks.filter(b => b.type === 'text')

    // Stream think blocks to frontend immediately (Command only)
    if (isCommand && thinkBlocks.length > 0) {
      for (const t of thinkBlocks) {
        allBlocks.push(t)
        emitProgress(taskId, 'think', { content: t.content })
      }
    }

    // Stream text blocks immediately
    for (const t of textBlocks) {
      allBlocks.push(t)
      if (isCommand) emitProgress(taskId, 'text', { content: t.content })
    }

    // Handle doc updates
    for (const du of docUpdates) {
      try {
        await upsertDoc(du.docKey, du.title || du.docKey, du.content, du.workspace || workspace)
        logger.info('OS Cortex: AI updated doc', { docKey: du.docKey })
      } catch (err) {
        logger.warn('OS Cortex: doc update failed', { docKey: du.docKey, error: err.message })
      }
    }

    // Handle context updates
    for (const cu of contextUpdates) {
      try {
        await updateCoreContextFact(cu.key, cu.value)
        logger.info('OS Cortex: AI updated core fact', { key: cu.key })
      } catch (err) {
        logger.warn('OS Cortex: context update failed', { key: cu.key, error: err.message })
      }
    }

    // If AI asked a question — pause, return to human
    if (questions.length > 0) {
      allBlocks.push(...questions)
      taskStatus = 'paused'
      if (isCommand) emitProgress(taskId, 'question', { content: questions[0].content })
      break
    }

    // If AI signaled done
    if (doneBlocks.length > 0) {
      allBlocks.push(...doneBlocks)
      taskStatus = 'completed'
      const title = doneBlocks[0].summary || null
      if (title) await updateTaskStatus(taskId, 'completed', title)
      if (isCommand) emitProgress(taskId, 'done', { summary: doneBlocks[0].summary })
      break
    }

    // ── PARALLEL DELEGATIONS (Command's superpower) ──
    // Run ALL delegations in parallel — this is what makes Command fast
    const delegationResults = []
    if (delegations.length > 0) {
      allBlocks.push(...delegations.map(d => ({ type: 'delegate', workspace: d.workspace, prompt: d.prompt })))

      if (isCommand && delegations.length > 1) {
        emitProgress(taskId, 'parallel_start', {
          count: delegations.length,
          workspaces: delegations.map(d => d.workspace),
        })
      }

      // Run all delegations concurrently with Promise.allSettled
      const delegationPromises = delegations.map(del => executeDelegation(del, taskId))
      const settled = await Promise.allSettled(delegationPromises)

      for (const result of settled) {
        if (result.status === 'fulfilled') {
          delegationResults.push(result.value)
          allBlocks.push(result.value)
        } else {
          const failResult = { type: 'delegate_result', workspace: '?', success: false, error: result.reason?.message || 'Unknown error' }
          delegationResults.push(failResult)
          allBlocks.push(failResult)
        }
      }

      if (isCommand && delegations.length > 1) {
        emitProgress(taskId, 'parallel_complete', {
          count: delegations.length,
          successes: delegationResults.filter(r => r.success).length,
        })
      }
    }

    // ── DIRECT ACTIONS (Command can also execute capabilities directly) ──
    const actionResultData = { resultParts: [], resultBlocks: [] }
    if (actions.length > 0) {
      allBlocks.push(...actions)
      const { resultParts, resultBlocks } = await executeActions(actions, failedActions, taskId)
      actionResultData.resultParts = resultParts
      actionResultData.resultBlocks = resultBlocks
      allBlocks.push(...resultBlocks)
    }

    // ── LOAD DOCS ──
    const docResultParts = []
    for (const req of docRequests) {
      const doc = await getDoc(req.docKey)
      if (doc) {
        docResultParts.push(`[Document loaded: ${doc.title}]\n${doc.content}`)
      } else {
        docResultParts.push(`[Document "${req.docKey}" not found]`)
      }
    }

    // If nothing actionable happened, AI is done
    if (actions.length === 0 && docRequests.length === 0 && delegations.length === 0) {
      break
    }

    // If every action this round was skipped or failed and no delegations, break
    if (actions.length > 0 && delegations.length === 0 &&
        actionResultData.resultParts.length > 0 &&
        actionResultData.resultParts.every(r => r.startsWith('✗') || r.startsWith('⊘'))) {
      break
    }

    // Persist assistant turn
    const assistantContent = blocks.filter(b => b.type === 'text' || b.type === 'think').map(b => b.content).join('\n')
    await persistTurn(taskId, {
      ts: new Date().toISOString(),
      role: 'assistant',
      content: assistantContent || JSON.stringify(blocks),
      blocks,
    })

    // Build comprehensive feedback for the next round
    const delegationFeedback = delegationResults
      .map(b => `[${b.workspace}] ${b.success ? b.result : `ERROR: ${b.error}`}`)

    const feedbackParts = [
      ...actionResultData.resultParts,
      ...delegationFeedback,
      ...docResultParts,
    ].filter(Boolean)

    const feedbackContent = feedbackParts.join('\n\n')
    messages.push({ role: 'assistant', content: assistantContent || 'Executing...' })
    if (feedbackContent) {
      messages.push({ role: 'user', content: `Results:\n${feedbackContent}\n\nContinue working or signal done.` })
    }

    // Cap message count to prevent context overflow
    const MAX_MESSAGES = isCommand ? 60 : 40
    if (messages.length > MAX_MESSAGES) {
      const system = messages[0]
      const recent = messages.slice(-(MAX_MESSAGES - 1))
      messages.length = 0
      messages.push(system, ...recent)
    }

    await persistTurn(taskId, {
      ts: new Date().toISOString(),
      role: 'user',
      content: `[system] Action results:\n${feedbackContent}`,
    })
  }

  // Persist final assistant turn if we have text blocks
  const finalText = allBlocks.filter(b => b.type === 'text').map(b => b.content).join('\n')
  if (finalText && rounds === 1) {
    await persistTurn(taskId, {
      ts: new Date().toISOString(),
      role: 'assistant',
      content: finalText,
      blocks: allBlocks,
    })
  }

  // Update task status
  if (taskStatus !== 'completed') {
    await updateTaskStatus(taskId, taskStatus)
  }

  // Auto-generate title from first user message if none set
  if (!session.title && userMessages.length > 0) {
    const firstMsg = userMessages[0].content.slice(0, 100)
    await updateTaskStatus(taskId, taskStatus, firstMsg)
  }

  if (isCommand) {
    emitProgress(taskId, 'orchestration_complete', { rounds, status: taskStatus })
  }

  // Order blocks chronologically — preserve the narrative flow of the orchestration
  // Don't reorder for command — the think→delegate→result→text sequence IS the story
  if (!isCommand) {
    const actionBlks = allBlocks.filter(b => b.type === 'action_card' || b.type === 'action_result')
    const textBlks = allBlocks.filter(b => b.type === 'text')
    const controlBlks = allBlocks.filter(b => b.type === 'done' || b.type === 'question')
    const otherBlks = allBlocks.filter(b =>
      b.type !== 'action_card' && b.type !== 'action_result' &&
      b.type !== 'text' && b.type !== 'done' && b.type !== 'question'
    )
    const reordered = [...actionBlks, ...textBlks, ...otherBlks, ...controlBlks]
    return { blocks: reordered, taskId, status: taskStatus, rounds }
  }

  return { blocks: allBlocks, taskId, status: taskStatus, rounds }
}

// ═══════════════════════════════════════════════════════════════════════
// EXPORTS
// ═══════════════════════════════════════════════════════════════════════

module.exports = {
  runTask,
  buildSystemPrompt,
  loadTaskSession,
  createTaskSession,
  getCoreContext,
  getDoc,
  upsertDoc,
  updateCoreContextFact,
}
