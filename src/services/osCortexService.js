/**
 * OS Cortex Service — practical operations assistant.
 * Completely separate from organism cortexService.js.
 * Zero organism imports. Uses only: callDeepSeek, capabilityRegistry, db, logger.
 */

const { callDeepSeek } = require('./deepseekService')
const registry = require('./capabilityRegistry')
const db = require('../config/db')
const logger = require('../config/logger')
const { getWorkspace } = require('./osWorkspaceDefinitions')

const MAX_HISTORY_TURNS = parseInt(process.env.OS_MAX_HISTORY_TURNS || '20')
const TASK_TIMEOUT_MS = parseInt(process.env.OS_TASK_TIMEOUT_MS || '280000') // under nginx 300s

// ═══════════════════════════════════════════════════════════════════════
// PROMPT BUILDING — focused, small, workspace-scoped
// ═══════════════════════════════════════════════════════════════════════

async function getCoreContext() {
  const rows = await db`SELECT facts FROM os_core_context LIMIT 1`
  if (!rows.length) return []
  return rows[0].facts || []
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
      } else if (rows.length <= 5) {
        results[label] = rows
      } else {
        results[label] = `${rows.length} rows`
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

async function buildSystemPrompt(workspaceName) {
  const ws = getWorkspace(workspaceName)
  if (!ws) throw new Error(`Unknown workspace: ${workspaceName}`)

  // Load everything in parallel
  const [coreFacts, docs, stateResults] = await Promise.all([
    getCoreContext(),
    loadDocs(ws.autoLoadDocs),
    runStateQueries(ws.stateQueries),
  ])

  // Core facts section
  const factsBlock = coreFacts.map(f => `${f.key}: ${f.value}`).join('\n')

  // State section
  const stateLines = Object.entries(stateResults).map(([label, val]) => {
    if (typeof val === 'number' || typeof val === 'string') return `${label}: ${val}`
    if (Array.isArray(val)) return `${label}:\n${val.map(r => '  ' + JSON.stringify(r)).join('\n')}`
    return `${label}: ${JSON.stringify(val)}`
  }).join('\n')

  // Docs section
  const docsBlock = docs.map(d => `[${d.title}]\n${d.content}`).join('\n\n')

  // Capabilities
  const capsBlock = formatCapabilities(ws.domains)

  return `You are a practical operations assistant. Execute tasks by returning JSON blocks. Be direct — do the work, don't explain what you could do.

--- CORE FACTS ---
${factsBlock}

--- WORKSPACE: ${ws.label} ---
${ws.systemPromptAddition}

Current state:
${stateLines || '(no state queries configured)'}

${docsBlock ? `--- REFERENCE DOCS ---\n${docsBlock}\n--- END DOCS ---` : ''}

Available actions:
${capsBlock}

RESPONSE FORMAT: Return a JSON array of blocks. Each block has a "type" field.
Block types:
  {"type":"text","content":"..."} — message to the human
  {"type":"action_card","action":"capability_name","params":{...}} — execute an action
  {"type":"need_doc","docKey":"..."} — request a reference doc to be loaded
  {"type":"update_doc","docKey":"...","title":"...","content":"..."} — create/update a reference doc
  {"type":"update_context","key":"...","value":"..."} — update a core fact
  {"type":"question","content":"..."} — pause and ask the human a question
  {"type":"done","summary":"..."} — signal task completion

Rules:
- Execute actions immediately, don't ask permission unless genuinely ambiguous
- When you need more info from a doc, use need_doc to load it
- Return ONLY the JSON array, no markdown fences, no prose outside the array
- Multiple actions can be in one response
- After action results come back, continue working or signal done`
}

// ═══════════════════════════════════════════════════════════════════════
// BLOCK PARSING — same robust strategy as cortex, no dependency on it
// ═══════════════════════════════════════════════════════════════════════

function parseBlocks(raw) {
  const isBlockArray = (v) => Array.isArray(v) && v.length > 0 && v.every(b => b && typeof b.type === 'string')

  try {
    const parsed = JSON.parse(raw)
    if (isBlockArray(parsed)) return parsed
    if (parsed.blocks && isBlockArray(parsed.blocks)) return parsed.blocks
    if (parsed && typeof parsed.type === 'string') return [parsed]
  } catch { /* not pure JSON */ }

  const fenceMatch = raw.match(/```(?:json)?\s*([\s\S]*?)```/)
  if (fenceMatch) {
    try {
      const parsed = JSON.parse(fenceMatch[1].trim())
      if (isBlockArray(parsed)) return parsed
      if (parsed && typeof parsed.type === 'string') return [parsed]
    } catch { /* fall through */ }
  }

  const jsonArrayStart = raw.indexOf('[{')
  if (jsonArrayStart !== -1) {
    const lastBracket = raw.lastIndexOf(']')
    if (lastBracket > jsonArrayStart) {
      try {
        const parsed = JSON.parse(raw.slice(jsonArrayStart, lastBracket + 1))
        if (isBlockArray(parsed)) return parsed
      } catch { /* fall through */ }
    }
  }

  return [{ type: 'text', content: raw }]
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
// MAIN EXECUTION LOOP — no round limits, runs until done
// ═══════════════════════════════════════════════════════════════════════

async function runTask(taskId, userMessages, { workspace }) {
  const startTime = Date.now()

  // Load or create task session
  let session = taskId ? await loadTaskSession(taskId) : null
  if (!session) {
    session = await createTaskSession(workspace, null)
    taskId = session.id
  }

  // Build system prompt
  const systemPrompt = await buildSystemPrompt(workspace)

  // Reconstruct message history from session (last N turns)
  const history = (session.history || []).slice(-MAX_HISTORY_TURNS)
  const messages = [
    { role: 'system', content: systemPrompt },
    ...history.map(t => ({ role: t.role, content: t.content })),
    ...userMessages,
  ]

  // Persist user turn
  for (const msg of userMessages) {
    await persistTurn(taskId, { ts: new Date().toISOString(), role: msg.role, content: msg.content })
  }

  const allBlocks = []
  let rounds = 0
  let taskStatus = 'active'

  while (Date.now() - startTime < TASK_TIMEOUT_MS) {
    rounds++
    logger.info(`OS Cortex round ${rounds}`, { taskId, workspace, messageCount: messages.length })

    // Call LLM
    const raw = await callDeepSeek(messages, {
      module: 'os',
      skipRetrieval: true,
      skipLogging: true,
      temperature: 0.1,
    })

    const blocks = parseBlocks(raw)
    allBlocks.push(...blocks)

    // Process special blocks
    const actions = blocks.filter(b => b.type === 'action_card')
    const docRequests = blocks.filter(b => b.type === 'need_doc')
    const docUpdates = blocks.filter(b => b.type === 'update_doc')
    const contextUpdates = blocks.filter(b => b.type === 'update_context')
    const questions = blocks.filter(b => b.type === 'question')
    const doneBlocks = blocks.filter(b => b.type === 'done')

    // Handle doc updates (fire-and-forget-ish)
    for (const du of docUpdates) {
      try {
        await upsertDoc(du.docKey, du.title || du.docKey, du.content, workspace)
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
      taskStatus = 'paused'
      break
    }

    // If AI signaled done
    if (doneBlocks.length > 0) {
      taskStatus = 'completed'
      const title = doneBlocks[0].summary || null
      if (title) await updateTaskStatus(taskId, 'completed', title)
      break
    }

    // If no actions and no doc requests — AI is done talking
    if (actions.length === 0 && docRequests.length === 0) {
      break
    }

    // Execute actions
    const resultParts = []
    for (const action of actions) {
      try {
        const result = await registry.execute(action.action, action.params, { source: 'os' })
        resultParts.push(`✓ ${action.action}: ${JSON.stringify(result.result || result).slice(0, 500)}`)
        allBlocks.push({ type: 'action_result', action: action.action, success: true, result: result.result || result })
      } catch (err) {
        resultParts.push(`✗ ${action.action}: ${err.message}`)
        allBlocks.push({ type: 'action_result', action: action.action, success: false, error: err.message })
      }
    }

    // Load requested docs
    for (const req of docRequests) {
      const doc = await getDoc(req.docKey)
      if (doc) {
        resultParts.push(`[Document loaded: ${doc.title}]\n${doc.content}`)
      } else {
        resultParts.push(`[Document "${req.docKey}" not found]`)
      }
    }

    // Persist assistant turn
    const assistantContent = blocks.filter(b => b.type === 'text').map(b => b.content).join('\n')
    await persistTurn(taskId, {
      ts: new Date().toISOString(),
      role: 'assistant',
      content: assistantContent || JSON.stringify(blocks),
      blocks,
    })

    // Feed results back
    const feedbackContent = resultParts.join('\n\n')
    messages.push({ role: 'assistant', content: assistantContent || 'Executing actions...' })
    messages.push({ role: 'user', content: `Action results:\n${feedbackContent}\n\nContinue working or signal done.` })

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
