/**
 * OS Session Service — manages a persistent Claude Code session as the OS brain.
 *
 * Uses the Agent SDK (query()) instead of spawning CLI processes.
 * The SDK gives us:
 * - Real-time streaming via SDKMessage events (no more buffered --print output)
 * - Proper session resume via session_id
 * - Built-in MCP server management
 * - CLAUDE.md loaded via settingSources
 *
 * Messages stream to the frontend via WebSocket in real-time as they arrive.
 */

const db = require('../config/db')
const logger = require('../config/logger')
const env = require('../config/env')
const { broadcast } = require('../websocket/wsManager')
const secretSafety = require('./secretSafetyService')

// Token tracking
const COMPACT_THRESHOLD = parseInt(env.OS_SESSION_COMPACT_THRESHOLD || '150000', 10)

// In-memory state
let activeQuery = null          // the running Query object from the SDK
let ccSessionId = null          // CC's internal session_id (for resume)
let sessionTokenUsage = { input: 0, output: 0 }

// We lazy-import the ESM Agent SDK since the backend is CJS
let _query = null
async function getQuery() {
  if (!_query) {
    const sdk = await import('@anthropic-ai/claude-agent-sdk')
    _query = sdk.query
  }
  return _query
}

// ── Session DB operations ──

async function getOSSession() {
  const rows = await db`
    SELECT id, cc_cli_session_id, status, started_at
    FROM cc_sessions
    WHERE triggered_by = 'cortex' AND trigger_source = 'cortex' AND initial_prompt = 'OS Session'
    ORDER BY started_at DESC
    LIMIT 1
  `
  return rows[0] || null
}

async function createOSSession() {
  const [row] = await db`
    INSERT INTO cc_sessions (
      triggered_by, trigger_source, status, pipeline_stage,
      initial_prompt, started_at
    ) VALUES (
      'cortex', 'cortex', 'running', 'executing',
      'OS Session', now()
    ) RETURNING id, cc_cli_session_id, status
  `
  return row
}

async function updateOSSession(sessionId, updates) {
  const { ccCliSessionId, status } = updates
  if (ccCliSessionId) {
    await db`UPDATE cc_sessions SET cc_cli_session_id = ${ccCliSessionId}, status = ${status || 'complete'} WHERE id = ${sessionId}`
  } else if (status) {
    await db`UPDATE cc_sessions SET status = ${status} WHERE id = ${sessionId}`
  }
}

async function appendLog(sessionId, content) {
  await db`
    INSERT INTO cc_session_logs (session_id, content, created_at)
    VALUES (${sessionId}, ${content.slice(0, 10000)}, now())
  `.catch(() => {}) // non-critical
}

// ── WebSocket broadcasting ──

function emitOutput(data) {
  broadcast('os-session:output', { data })
}

function emitStatus(status, meta = {}) {
  broadcast('os-session:status', { status, ...meta })
}

// ── Extract text from an assistant message's content blocks ──

function extractTextFromContent(content) {
  if (!content || !Array.isArray(content)) return ''
  return content
    .filter(b => b.type === 'text' && b.text)
    .map(b => b.text)
    .join('\n\n')
}

// ── Main: send a message to the OS session ──

async function sendMessage(content) {
  const queryFn = await getQuery()

  // Kill any active query
  if (activeQuery) {
    try { activeQuery.close() } catch {}
    activeQuery = null
  }

  // Find or create the OS session (DB record)
  let session = await getOSSession()
  let isResume = false

  if (session?.cc_cli_session_id) {
    isResume = true
    ccSessionId = session.cc_cli_session_id
  } else {
    session = await createOSSession()
  }

  const dbSessionId = session.id
  emitStatus('streaming', { sessionId: dbSessionId })

  // cwd must contain .mcp.json and CLAUDE.md
  const cwd = env.OS_SESSION_CWD || '/home/tate/ecodiaos'

  logger.info(`OS Session ${isResume ? 'resuming' : 'starting'}`, {
    sessionId: dbSessionId,
    ccSessionId,
  })

  // Log user message
  await appendLog(dbSessionId, `[USER] ${content}`)
  emitOutput({ type: 'user', content })

  // Build SDK options
  const options = {
    cwd,
    permissionMode: 'bypassPermissions',
    allowDangerouslySkipPermissions: true,
    settingSources: ['project'],       // loads CLAUDE.md from cwd
    includePartialMessages: true,      // stream_event messages for real-time text
    systemPrompt: {
      type: 'preset',
      preset: 'claude_code',           // use CC's full system prompt (includes CLAUDE.md)
    },
    model: env.OS_SESSION_MODEL || undefined,
  }

  // Resume existing session or start fresh
  if (isResume && ccSessionId) {
    options.resume = ccSessionId
  }

  // Set ANTHROPIC_API_KEY in env if available
  if (env.ANTHROPIC_API_KEY) {
    options.env = { ...process.env, ANTHROPIC_API_KEY: env.ANTHROPIC_API_KEY }
  }

  const collectedText = []
  let newCcSessionId = ccSessionId

  try {
    const q = queryFn({ prompt: content, options })
    activeQuery = q

    // Stream all messages from the SDK
    for await (const msg of q) {
      try {
        // Log raw message type for debugging
        logger.debug('OS Session SDK message', { type: msg.type, subtype: msg.subtype })

        switch (msg.type) {
          // ─── System init — capture session_id ────────────────
          case 'system': {
            if (msg.subtype === 'init' && msg.session_id) {
              newCcSessionId = msg.session_id
              if (newCcSessionId !== ccSessionId) {
                ccSessionId = newCcSessionId
                await updateOSSession(dbSessionId, { ccCliSessionId: ccSessionId, status: 'running' })
              }
            }
            break
          }

          // ─── Full assistant message — extract text, broadcast ─
          case 'assistant': {
            const text = extractTextFromContent(msg.message?.content)
            if (text) {
              const safeText = secretSafety.scrubSecrets(text)
              collectedText.push(safeText)
              await appendLog(dbSessionId, safeText)
              // Broadcast the full assistant text for the frontend
              emitOutput({ type: 'assistant_text', content: safeText })
            }

            // Also broadcast tool_use blocks so frontend knows about tool calls
            const toolUses = (msg.message?.content || []).filter(b => b.type === 'tool_use')
            if (toolUses.length > 0) {
              emitOutput({
                type: 'tool_use',
                tools: toolUses.map(t => ({ name: t.name, id: t.id })),
              })
            }

            // Track usage from per-turn data
            if (msg.message?.usage) {
              sessionTokenUsage.input = msg.message.usage.input_tokens || sessionTokenUsage.input
              sessionTokenUsage.output = msg.message.usage.output_tokens || sessionTokenUsage.output
            }
            break
          }

          // ─── Streaming partial — real-time text deltas ────────
          case 'stream_event': {
            const event = msg.event
            if (!event) break

            if (event.type === 'content_block_delta' && event.delta) {
              if (event.delta.type === 'text_delta' && event.delta.text) {
                const safeText = secretSafety.scrubSecrets(event.delta.text)
                // Broadcast each text delta for live streaming in the UI
                emitOutput({ type: 'text_delta', content: safeText })
              }
            }
            break
          }

          // ─── Result — session complete, capture usage ─────────
          case 'result': {
            if (msg.usage) {
              sessionTokenUsage.input = msg.usage.input_tokens || sessionTokenUsage.input
              sessionTokenUsage.output = msg.usage.output_tokens || sessionTokenUsage.output
            }
            if (msg.result) {
              const safeResult = secretSafety.scrubSecrets(msg.result)
              if (!collectedText.includes(safeResult) && safeResult.length > 0) {
                collectedText.push(safeResult)
              }
            }
            // Broadcast token usage
            const totalTokens = sessionTokenUsage.input + sessionTokenUsage.output
            broadcast('os-session:tokens', {
              input: sessionTokenUsage.input,
              output: sessionTokenUsage.output,
              total: totalTokens,
              threshold: COMPACT_THRESHOLD,
              needsCompaction: totalTokens > COMPACT_THRESHOLD,
            })
            break
          }

          default:
            // Other message types (user replay, compact_boundary, etc.) — ignore
            break
        }
      } catch (msgErr) {
        logger.debug('OS Session message processing error', { error: msgErr.message })
      }
    }

    // Session complete
    activeQuery = null
    await updateOSSession(dbSessionId, { ccCliSessionId: ccSessionId, status: 'complete' })
    emitStatus('complete', { sessionId: dbSessionId, code: 0 })
    broadcast('os-session:complete', { sessionId: dbSessionId, code: 0 })

    logger.info('OS Session exchange complete', { sessionId: dbSessionId, ccSessionId })

    return {
      sessionId: dbSessionId,
      ccCliSessionId: ccSessionId,
      code: 0,
      text: collectedText.join('\n\n'),
    }

  } catch (err) {
    activeQuery = null
    logger.error('OS Session SDK error', { error: err.message, stack: err.stack })

    emitOutput({ type: 'error', content: err.message })
    emitStatus('error', { error: err.message })
    broadcast('os-session:complete', { sessionId: dbSessionId, code: 1 })

    await updateOSSession(dbSessionId, { ccCliSessionId: ccSessionId, status: 'error' })

    return {
      sessionId: dbSessionId,
      ccCliSessionId: ccSessionId,
      code: 1,
      text: `Error: ${err.message}`,
    }
  }
}

// ── Get current session status ──

async function getStatus() {
  const session = await getOSSession()
  return {
    active: !!activeQuery,
    sessionId: session?.id || null,
    ccCliSessionId: session?.cc_cli_session_id || null,
    status: activeQuery ? 'streaming' : (session?.status || 'idle'),
    startedAt: session?.started_at,
  }
}

// ── Restart — kill current, start fresh ──

async function restart() {
  if (activeQuery) {
    try { activeQuery.close() } catch {}
    activeQuery = null
  }
  ccSessionId = null
  const session = await createOSSession()
  emitStatus('idle', { sessionId: session.id, restarted: true })
  return { sessionId: session.id }
}

// ── Get session history (recent logs) ──

async function getHistory(limit = 100) {
  const session = await getOSSession()
  if (!session) return []
  const logs = await db`
    SELECT content, created_at
    FROM cc_session_logs
    WHERE session_id = ${session.id}
    ORDER BY created_at DESC
    LIMIT ${limit}
  `
  return logs.reverse()
}

// ── Compact — seamlessly transition to a new session with context ──

async function compact(summary) {
  // Kill any active query
  if (activeQuery) {
    try { activeQuery.close() } catch {}
    activeQuery = null
  }

  // Create a new session
  const newSession = await createOSSession()

  // Reset token tracking and session ID
  sessionTokenUsage = { input: 0, output: 0 }
  ccSessionId = null

  // Send the summary as the first message to establish context in the new session
  const contextMessage = `[CONTEXT FROM PREVIOUS SESSION]\n\n${summary}\n\n[END CONTEXT]\n\nYou are continuing an ongoing conversation. The above is a summary of what was discussed and decided. Continue seamlessly — the human should not notice the session transition.`

  logger.info('OS Session compacting', { newSessionId: newSession.id, summaryLength: summary.length })

  const result = await sendMessage(contextMessage)

  emitStatus('compacted', { sessionId: newSession.id, previousTokens: sessionTokenUsage })

  return { sessionId: newSession.id, ...result }
}

// ── Get token usage ──

function getTokenUsage() {
  return {
    ...sessionTokenUsage,
    total: sessionTokenUsage.input + sessionTokenUsage.output,
    threshold: COMPACT_THRESHOLD,
    needsCompaction: (sessionTokenUsage.input + sessionTokenUsage.output) > COMPACT_THRESHOLD,
  }
}

// ── Recover missed response — returns assistant text after a timestamp ──

async function recoverResponse(sinceTs) {
  const session = await getOSSession()
  if (!session) return { found: false, text: '', status: 'idle', streaming: false }

  const streaming = !!activeQuery

  const since = sinceTs ? new Date(sinceTs) : new Date(Date.now() - 600_000)
  const logs = await db`
    SELECT content, created_at
    FROM cc_session_logs
    WHERE session_id = ${session.id} AND created_at > ${since}
    ORDER BY created_at ASC
  `

  // Collect assistant text from logs (now stored as plain text, not NDJSON)
  const textParts = []
  for (const log of logs) {
    const line = log.content
    if (line.startsWith('[USER]')) continue
    // Lines are now plain text from assistant responses
    if (line.trim()) textParts.push(line)
  }

  return {
    found: textParts.length > 0,
    text: textParts.join('\n\n'),
    chunks: [],  // no longer using NDJSON chunks
    status: session.status,
    streaming,
    sessionId: session.id,
  }
}

module.exports = { sendMessage, getStatus, restart, getHistory, compact, getTokenUsage, recoverResponse }
