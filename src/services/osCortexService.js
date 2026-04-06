/**
 * OS Cortex Service — practical operations assistant.
 * Completely separate from organism cortexService.js.
 * Zero organism imports. Uses only: callDeepSeek, capabilityRegistry, db, logger.
 */

const { callDeepSeek } = require('./deepseekService')
const registry = require('./capabilityRegistry')
const db = require('../config/db')
const logger = require('../config/logger')
const { getWorkspace, listWorkspaces } = require('./osWorkspaceDefinitions')

const MAX_HISTORY_TURNS = parseInt(process.env.OS_MAX_HISTORY_TURNS || '20')
const TASK_TIMEOUT_MS = parseInt(process.env.OS_TASK_TIMEOUT_MS || '280000') // under nginx 300s

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
  const ws = workspaceName ? getWorkspace(workspaceName) : null

  // Load core facts always
  const coreFacts = await getCoreContext()
  const factsBlock = coreFacts.map(f => `${f.key}: ${f.value}`).join('\n')

  // If no workspace, build a general prompt with workspace options
  if (!ws) {
    const workspaceList = listWorkspaces().map(w => `- ${w.name}: ${w.description}`).join('\n')
    const allDocs = await listAllDocs()
    const docList = allDocs.map(d => `- ${d.key} (${d.workspace || 'global'}) — ${d.title}`).join('\n')

    return `You are a practical operations assistant for Ecodia Pty Ltd. You can chat generally or activate a workspace for focused work.

--- CORE FACTS ---
${factsBlock}

Available workspaces (tell the human to switch if they need focused tools):
${workspaceList}

Available reference docs (use need_doc to load any):
${docList || '(none yet)'}

RESPONSE FORMAT: Return a JSON array of blocks.
  {"type":"text","content":"..."} — message to the human
  {"type":"need_doc","docKey":"..."} — load a reference doc
  {"type":"question","content":"..."} — ask the human a question
  {"type":"update_doc","docKey":"...","title":"...","content":"..."} — create/update a doc
  {"type":"update_context","key":"...","value":"..."} — update a core fact

You have no action tools in general mode. If the human needs to run actions (bookkeeping, email, etc.), suggest they switch to the relevant workspace.
Return ONLY the JSON array, no markdown fences, no prose outside the array.`
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
  text: {"type":"text","content":"..."}
  action: {"type":"action_card","action":"name","params":{...}}
  load doc: {"type":"need_doc","docKey":"..."}
  save doc: {"type":"update_doc","docKey":"...","title":"...","content":"...","workspace":"..."}
  update fact: {"type":"update_context","key":"...","value":"..."}
  ask human: {"type":"question","content":"..."}
  done: {"type":"done","summary":"..."}

Return ONLY the JSON array. Execute immediately. Multiple actions per response OK. After results come back, continue or signal done.`
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
// MAIN EXECUTION LOOP — no round limits, runs until done
// ═══════════════════════════════════════════════════════════════════════

async function runTask(taskId, userMessages, { workspace }) {
  const startTime = Date.now()

  // Load or create task session
  let session = taskId ? await loadTaskSession(taskId) : null
  if (!session) {
    session = await createTaskSession(workspace || 'general', null)
    taskId = session.id
  }

  // Build system prompt
  const systemPrompt = await buildSystemPrompt(workspace)

  // Reconstruct message history from session (last N turns)
  // Filter: only valid role+content pairs — drop corrupt or system entries
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
  const failedActions = new Map() // track failed action+params to prevent retries
  let rounds = 0
  let taskStatus = 'active'
  const MAX_ROUNDS = 20 // safety net — prevents infinite loops

  while (Date.now() - startTime < TASK_TIMEOUT_MS && rounds < MAX_ROUNDS) {
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

    // Execute actions — dedup + skip previously failed actions
    const resultParts = []
    const seenThisRound = new Set()
    for (const action of actions) {
      const actionKey = `${action.action}:${JSON.stringify(action.params || {})}`

      // Skip duplicates within the same round
      if (seenThisRound.has(actionKey)) {
        resultParts.push(`⊘ ${action.action}: skipped duplicate`)
        continue
      }
      seenThisRound.add(actionKey)

      // Skip if this exact action+params already failed — don't burn rounds retrying
      const priorFailures = failedActions.get(actionKey) || 0
      if (priorFailures >= 1) {
        resultParts.push(`⊘ ${action.action}: skipped — already failed with these params. Try different params or a different approach.`)
        allBlocks.push({ type: 'action_result', action: action.action, success: false, error: 'Already failed — skipped retry' })
        continue
      }

      try {
        const result = await registry.execute(action.action, action.params, { source: 'os' })
        if (result && result.success === false) {
          failedActions.set(actionKey, priorFailures + 1)
          resultParts.push(`✗ ${action.action}: ${result.error || 'failed'}`)
          allBlocks.push({ type: 'action_result', action: action.action, success: false, error: result.error || 'failed' })
        } else {
          resultParts.push(`✓ ${action.action}: ${JSON.stringify(result.result || result).slice(0, 500)}`)
          allBlocks.push({ type: 'action_result', action: action.action, success: true, result: result.result || result })
        }
      } catch (err) {
        failedActions.set(actionKey, priorFailures + 1)
        resultParts.push(`✗ ${action.action}: ${err.message}`)
        allBlocks.push({ type: 'action_result', action: action.action, success: false, error: err.message })
      }
    }

    // If every action this round was skipped or failed, break — nothing useful left
    if (resultParts.length > 0 && resultParts.every(r => r.startsWith('✗') || r.startsWith('⊘'))) {
      break
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

    // Feed results back — but cap total message count to prevent context overflow
    const feedbackContent = resultParts.join('\n\n')
    messages.push({ role: 'assistant', content: assistantContent || 'Executing actions...' })
    messages.push({ role: 'user', content: `Action results:\n${feedbackContent}\n\nContinue working or signal done.` })

    // If messages are getting too long, trim oldest non-system messages
    const MAX_MESSAGES = 40
    if (messages.length > MAX_MESSAGES) {
      const system = messages[0] // preserve system prompt
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
