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
 *
 * Provider fallback chain:
 *   1. Claude Max OAuth (primary, from ~/.claude.json)
 *   2. AWS Bedrock Opus 4.6 (on 429/usage-exhausted)
 *   3. AWS Bedrock Sonnet 4.6 (on Bedrock Opus daily limit)
 */

const fs = require('fs')
const path = require('path')
const db = require('../config/db')
const logger = require('../config/logger')
const env = require('../config/env')
const { broadcast } = require('../websocket/wsManager')
const secretSafety = require('./secretSafetyService')
const usageEnergy = require('./usageEnergyService')
const sessionMemory = require('./sessionMemoryService')

// Fire a quota-check on startup to get real usage % immediately
usageEnergy.refreshQuotaCheck()
  .then(() => usageEnergy.getEnergy())
  .then(e => logger.info('Claude energy on startup', { pctUsed: e.pctUsed, level: e.level }))
  .catch(() => {})


/**
 * Load MCP servers from .mcp.json in the given cwd and return them in the shape
 * the Agent SDK expects. Passing mcpServers programmatically bypasses the CLI
 * trust prompt that otherwise appears on every new project directory.
 */
function loadMcpServersFromCwd(cwd) {
  try {
    const p = path.join(cwd, '.mcp.json')
    if (!fs.existsSync(p)) {
      logger.warn('No .mcp.json found in OS session cwd', { cwd })
      return {}
    }
    const raw = JSON.parse(fs.readFileSync(p, 'utf8'))
    const servers = raw.mcpServers || {}
    // Normalize: SDK accepts { type: 'stdio', command, args, env } entries
    const normalized = {}
    for (const [name, cfg] of Object.entries(servers)) {
      normalized[name] = {
        type: cfg.type || 'stdio',
        command: cfg.command,
        args: cfg.args || [],
        ...(cfg.env ? { env: cfg.env } : {}),
      }
    }
    logger.info('Loaded MCP servers for OS session', { count: Object.keys(normalized).length, names: Object.keys(normalized) })
    return normalized
  } catch (err) {
    logger.error('Failed to load .mcp.json for OS session', { cwd, error: err.message })
    return {}
  }
}

// Token tracking (informational only — the SDK handles its own compaction internally
// via compactionControl: { enabled: true }. We track tokens purely for the frontend
// usage bar display, NOT to trigger any custom compaction/handover.)
let handoverInProgress = false

// In-memory state
let activeQuery = null          // the running Query object from the SDK
let ccSessionId = null          // CC's internal session_id (for resume)
let sessionTokenUsage = { input: 0, output: 0 }
let usingAccount2 = false       // flipped true after account 1 exhausted → use CLAUDE_CONFIG_DIR_2
let usingBedrock = false        // flipped true after both accounts exhausted → use Bedrock Opus
let usingBedrockSonnet = false  // flipped true after Bedrock Opus daily limit → use Bedrock Sonnet

// Message queue — prevents concurrent sendMessage calls from racing and clobbering
// each other's queries. Each sendMessage waits for the previous one to finish.
let _sendQueue = Promise.resolve()

// Weekly reset detection: if it's a new week since we flipped to account2/bedrock,
// try falling back to account1 again automatically.
let _exhaustedAt = null  // timestamp when account1 was first marked exhausted

function _shouldRetryPrimary() {
  if (!_exhaustedAt) return false
  // Claude Max resets weekly. If it's been >7 days, try account1 again.
  return (Date.now() - _exhaustedAt) > 7 * 24 * 60 * 60 * 1000
}

function _resetToAccount1() {
  usingAccount2 = false
  usingBedrock = false
  usingBedrockSonnet = false
  _exhaustedAt = null
  usageEnergy.setProvider('claude_max')
  logger.info('OS Session: weekly reset detected — returning to account 1 (primary)')
  emitOutput({ type: 'system', content: 'Weekly reset detected — switching back to primary Claude Max account.' })
}

// Bedrock model IDs
// Bedrock cross-region inference profile IDs — override via .env if needed
// Format: us.anthropic.claude-{model}-{date}-v{n}:{revision}
const BEDROCK_OPUS_MODEL = process.env.OS_SESSION_BEDROCK_MODEL || 'us.anthropic.claude-opus-4-6-20250514-v1:0'
const BEDROCK_SONNET_MODEL = process.env.OS_SESSION_BEDROCK_SONNET_MODEL || 'us.anthropic.claude-sonnet-4-6-20250514-v1:0'

// Detect usage exhaustion / rate limit errors from any error string
function _isUsageExhausted(text) {
  const t = (text || '').toLowerCase()
  return t.includes('429') || t.includes('rate limit') || t.includes('overloaded') ||
    t.includes('capacity') || t.includes('out of extra usage') || t.includes('out of usage') ||
    t.includes('weekly') || t.includes('resets ') || t.includes('not logged in') ||
    t.includes('throttlingexception') || t.includes('too many requests') ||
    t.includes('daily token limit') || t.includes('quota')
}

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
//
// opts.suppressOutput = true: suppress WebSocket broadcast (used for internal handover brief generation)

// Internal implementation — callers use sendMessage() which serializes through _sendQueue
async function _sendMessageImpl(content, opts = {}) {
  const { suppressOutput = false } = opts
  const queryFn = await getQuery()

  // Kill any active query — SDK query() is one-shot, so each message needs a new call.
  // Session continuity is maintained via options.resume + ccSessionId.
  if (activeQuery) {
    try { activeQuery.close() } catch {}
    activeQuery = null
  }

  // Find or create the OS session (DB record)
  // IMPORTANT: Reuse existing rows even when cc_cli_session_id is missing.
  // Previously this created a new row when session ID was cleared (by stale retry,
  // provider switch, etc.), orphaning the old row and losing all context.
  let session = await getOSSession()
  let isResume = false

  if (session?.cc_cli_session_id) {
    isResume = true
    ccSessionId = session.cc_cli_session_id
  } else if (session) {
    // Row exists but no CC session ID — reuse it, start fresh CC session on same DB record
    ccSessionId = null
    await updateOSSession(session.id, { status: 'running' })
  } else {
    // No OS session row at all — create one
    session = await createOSSession()
  }

  const dbSessionId = session.id
  if (!suppressOutput) {
    emitStatus('streaming', { sessionId: dbSessionId })

    // Emit current energy level so frontend knows if thinking mode is active
    try {
      const energyNow = await usageEnergy.getEnergy()
      broadcast('os-session:energy', energyNow)
    } catch {}
  }

  // cwd must contain .mcp.json and CLAUDE.md
  const cwd = env.OS_SESSION_CWD || '/home/tate/ecodiaos'

  logger.info(`OS Session ${isResume ? 'resuming' : 'starting'}`, {
    sessionId: dbSessionId,
    ccSessionId,
    suppressOutput,
  })

  // Log user message
  await appendLog(dbSessionId, `[USER] ${content}`)
  if (!suppressOutput) emitOutput({ type: 'user', content })

  // Session memory auto-injection DISABLED 2026-04-09
  // Reason: When context window fills and SDK compresses, stale memory chunks
  // became the only "context" left — causing the model to hallucinate tasks from
  // previous sessions. Neo4j MCP tool is available for on-demand memory recall
  // instead of blind pre-injection.
  const promptWithMemory = content

  // Build SDK options
  const mcpServers = loadMcpServersFromCwd(cwd)

  // Energy-gated thinking: use extended thinking when credits are ample (full/healthy)
  // Bedrock doesn't support extended thinking — only Claude Max primary
  let energy = null
  try { energy = await usageEnergy.getEnergy() } catch {}
  const energyLevel = energy?.level || 'healthy'
  const canThink = !usingBedrock && !usingBedrockSonnet && (energyLevel === 'full' || energyLevel === 'healthy')

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
    // Enable SDK auto-compaction — it summarises older messages in-place, preserving
    // conversational continuity within the same session. Far better than a full session
    // handover which nukes all context.  Threshold is in tokens; with a 1M context window,
    // 800k gives plenty of room for the compacted summary + ongoing conversation.
    compactionControl: { enabled: true },
    // Extended thinking — enabled when energy level is full or healthy
    ...(canThink ? {
      thinking: {
        type: 'enabled',
        budget_tokens: energyLevel === 'full' ? 10000 : 5000,
      },
    } : {}),
    // Pass MCP servers programmatically — bypasses the .mcp.json trust prompt.
    // SDK-provided servers are implicitly trusted, so no per-project consent needed.
    mcpServers,
    // Allow all tools from all MCP servers without per-call approval.
    // SDK uses mcp__<serverName>__<toolName> format — wildcard per server grants all tools.
    allowedTools: Object.keys(mcpServers).length > 0
      ? Object.keys(mcpServers).map(name => `mcp__${name}__*`)
      : undefined,
  }

  // Resume existing session or start fresh
  if (isResume && ccSessionId) {
    options.resume = ccSessionId
  }

  // Provider selection — four-tier fallback:
  //   account1 (primary) → account2 (CLAUDE_CONFIG_DIR_2) → Bedrock Opus → Bedrock Sonnet
  //
  // Account switching uses CLAUDE_CONFIG_DIR in options.env — the SDK reads this
  // to locate ~/.claude/claude.json (OAuth token). Setting it to a different dir
  // points the session at a different logged-in account, no API key needed.

  // Auto-reset: if it's been >7 days since account1 was exhausted, retry it
  if (_shouldRetryPrimary()) _resetToAccount1()

  const canBedrock = env.AWS_ACCESS_KEY_ID && env.AWS_SECRET_ACCESS_KEY
  const hasAccount2 = !!(env.CLAUDE_CONFIG_DIR_2)
  const shouldUseBedrock = usingBedrock || (!env.ANTHROPIC_API_KEY && !hasAccount2 && canBedrock)
  const shouldUseAccount2 = !usingBedrock && usingAccount2 && hasAccount2

  // Keep energy service in sync
  const currentProvider = shouldUseBedrock && canBedrock
    ? (usingBedrockSonnet ? 'bedrock_sonnet' : 'bedrock_opus')
    : shouldUseAccount2 ? 'claude_max_2' : 'claude_max'
  usageEnergy.setProvider(currentProvider)

  if (shouldUseBedrock && canBedrock) {
    const bedrockModel = usingBedrockSonnet ? BEDROCK_SONNET_MODEL : BEDROCK_OPUS_MODEL
    options.model = bedrockModel
    options.settings = {
      ...(typeof options.settings === 'object' ? options.settings : {}),
      apiProvider: 'bedrock',
      env: {
        AWS_ACCESS_KEY_ID: env.AWS_ACCESS_KEY_ID,
        AWS_SECRET_ACCESS_KEY: env.AWS_SECRET_ACCESS_KEY,
        AWS_REGION: env.AWS_REGION || 'us-east-1',
        CLAUDE_CODE_USE_BEDROCK: '1',
      },
    }
    const bedrockEnv = { ...process.env }
    delete bedrockEnv.ANTHROPIC_API_KEY
    bedrockEnv.AWS_ACCESS_KEY_ID = env.AWS_ACCESS_KEY_ID
    bedrockEnv.AWS_SECRET_ACCESS_KEY = env.AWS_SECRET_ACCESS_KEY
    bedrockEnv.AWS_REGION = env.AWS_REGION || 'us-east-1'
    bedrockEnv.CLAUDE_CODE_USE_BEDROCK = '1'
    options.env = bedrockEnv
    delete options.resume
    logger.info('OS Session using AWS Bedrock provider', {
      model: bedrockModel,
      region: env.AWS_REGION || 'us-east-1',
      tier: usingBedrockSonnet ? 'sonnet-fallback' : 'opus',
    })
  } else if (shouldUseAccount2) {
    // Account 2 — different CLAUDE_CONFIG_DIR, same OAuth flow
    const sessionEnv = { ...process.env }
    if (env.ANTHROPIC_API_KEY) sessionEnv.ANTHROPIC_API_KEY = env.ANTHROPIC_API_KEY
    sessionEnv.CLAUDE_CONFIG_DIR = env.CLAUDE_CONFIG_DIR_2
    options.env = sessionEnv
    delete options.resume  // can't resume across config dirs
    logger.info('OS Session using Claude Max account 2', { configDir: env.CLAUDE_CONFIG_DIR_2 })
  } else {
    // Account 1 — primary (default CLAUDE_CONFIG_DIR from ~/.claude)
    const sessionEnv = { ...process.env }
    if (env.ANTHROPIC_API_KEY) sessionEnv.ANTHROPIC_API_KEY = env.ANTHROPIC_API_KEY
    if (env.CLAUDE_CONFIG_DIR_1) sessionEnv.CLAUDE_CONFIG_DIR = env.CLAUDE_CONFIG_DIR_1
    options.env = sessionEnv
  }

  const collectedText = []
  let newCcSessionId = ccSessionId

  try {
    const q = queryFn({ prompt: promptWithMemory, options })
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

          // ─── User message — contains tool_result blocks after tool calls ─
          case 'user': {
            const content = msg.message?.content
            if (!Array.isArray(content)) break
            for (const block of content) {
              if (block.type === 'tool_result') {
                // Extract readable result text (truncate large blobs)
                let resultText = ''
                if (typeof block.content === 'string') {
                  resultText = block.content
                } else if (Array.isArray(block.content)) {
                  resultText = block.content
                    .filter(b => b.type === 'text')
                    .map(b => b.text)
                    .join('\n')
                }
                if (resultText.length > 2000) resultText = resultText.slice(0, 2000) + '\n… (truncated)'
                if (!suppressOutput) {
                  emitOutput({
                    type: 'tool_result',
                    tool_use_id: block.tool_use_id,
                    content: resultText || '(no output)',
                  })
                }
              }
            }
            break
          }

          // ─── Full assistant message — extract text, broadcast ─
          case 'assistant': {
            const blocks = msg.message?.content || []

            if (!suppressOutput) {
              // Broadcast thinking blocks for the frontend reasoning display
              const thinkingBlocks = blocks.filter(b => b.type === 'thinking' && b.thinking)
              for (const tb of thinkingBlocks) {
                emitOutput({ type: 'thinking', content: tb.thinking })
              }
            }

            const text = extractTextFromContent(blocks)
            if (text) {
              const safeText = secretSafety.scrubSecrets(text)
              collectedText.push(safeText)
              await appendLog(dbSessionId, safeText)
              // Broadcast the full assistant text for the frontend
              if (!suppressOutput) emitOutput({ type: 'assistant_text', content: safeText })
            }

            if (!suppressOutput) {
              // Also broadcast tool_use blocks so frontend knows about tool calls
              const toolUses = blocks.filter(b => b.type === 'tool_use')
              if (toolUses.length > 0) {
                emitOutput({
                  type: 'tool_use',
                  tools: toolUses.map(t => ({ name: t.name, id: t.id })),
                })
              }
            }

            // Track usage from per-turn data (for activity history only, not for % calculation)
            if (msg.message?.usage) {
              const turnInput  = msg.message.usage.input_tokens  || 0
              const turnOutput = msg.message.usage.output_tokens || 0
              sessionTokenUsage.input  += turnInput
              sessionTokenUsage.output += turnOutput
              if (turnInput > 0 || turnOutput > 0) {
                const provider = usingBedrockSonnet ? 'bedrock_sonnet' : usingBedrock ? 'bedrock_opus' : 'claude_max'
                const model    = usingBedrockSonnet ? BEDROCK_SONNET_MODEL : usingBedrock ? BEDROCK_OPUS_MODEL : (env.OS_SESSION_MODEL || null)
                // Log for history/turns-this-week count (non-blocking)
                usageEnergy.logUsage({ sessionId: dbSessionId, source: 'os_session', provider, model, inputTokens: turnInput, outputTokens: turnOutput }).catch(() => {})
              }
            }
            break
          }

          // ─── Streaming partial — real-time text + thinking deltas ──
          case 'stream_event': {
            const event = msg.event
            if (!event) break

            if (!suppressOutput && event.type === 'content_block_delta' && event.delta) {
              if (event.delta.type === 'text_delta' && event.delta.text) {
                const safeText = secretSafety.scrubSecrets(event.delta.text)
                emitOutput({ type: 'text_delta', content: safeText })
              } else if (event.delta.type === 'thinking_delta' && event.delta.thinking) {
                // Real-time thinking stream — shown in collapsible panel
                emitOutput({ type: 'thinking_delta', content: event.delta.thinking })
              }
            }
            break
          }

          // ─── Result — session complete, capture final usage ───
          case 'result': {
            if (msg.usage) {
              // result.usage is cumulative — use only for the threshold/compaction check,
              // not for logging (individual turns already logged in 'assistant' case above)
              sessionTokenUsage.input  = msg.usage.input_tokens  || sessionTokenUsage.input
              sessionTokenUsage.output = msg.usage.output_tokens || sessionTokenUsage.output
            }

            // Check for rate-limit / usage-exhaustion errors in the result
            // Fallback chain: account1 → account2 → Bedrock Opus → Bedrock Sonnet
            if (msg.is_error) {
              const errTexts = (msg.errors || []).join(' ') + ' ' + (msg.result || '') + ' ' + (msg.stop_reason || '')

              // Stale resume ID — CC CLI no longer has this session (e.g. after PM2 restart).
              // Clear it and retry fresh, once.
              if (!opts._staleCleaned && (
                errTexts.includes('No conversation found') ||
                errTexts.includes('session') && errTexts.includes('not found') ||
                errTexts.includes('Invalid session')
              )) {
                logger.warn('OS Session: stale resume ID in result, starting fresh', { staleCcSessionId: ccSessionId })
                ccSessionId = null
                activeQuery = null
                await db`UPDATE cc_sessions SET cc_cli_session_id = NULL WHERE id = ${dbSessionId}`.catch(() => {})
                throw { _staleRetry: true, message: content }
              }

              if (_isUsageExhausted(errTexts)) {
                if (!usingAccount2 && !usingBedrock && hasAccount2) {
                  // Account 1 exhausted → switch to account 2
                  usingAccount2 = true
                  _exhaustedAt = Date.now()
                  ccSessionId = null
                  activeQuery = null
                  usageEnergy.setProvider('claude_max_2')
                  logger.warn('OS Session account 1 exhausted — switching to Claude Max account 2', { configDir: env.CLAUDE_CONFIG_DIR_2 })
                  emitOutput({ type: 'system', content: '⚡ Account 1 weekly limit hit — switching to account 2 (full Opus, full thinking).' })
                  throw { _bedrockRetry: true, message: content }
                } else if (!usingBedrock && canBedrock) {
                  // Account 2 also exhausted (or not configured) → Bedrock Opus
                  usingBedrock = true
                  ccSessionId = null
                  activeQuery = null
                  usageEnergy.setProvider('bedrock_opus')
                  logger.warn('OS Session usage exhausted — switching to Bedrock Opus', { errors: msg.errors })
                  emitOutput({ type: 'system', content: 'Both Claude Max accounts exhausted — switching to Bedrock Opus.' })
                  throw { _bedrockRetry: true, message: content }
                } else if (usingBedrock && !usingBedrockSonnet && canBedrock) {
                  // Bedrock Opus daily limit → Bedrock Sonnet
                  usingBedrockSonnet = true
                  ccSessionId = null
                  activeQuery = null
                  usageEnergy.setProvider('bedrock_sonnet')
                  logger.warn('OS Session Bedrock Opus limit hit — stepping down to Bedrock Sonnet', { errors: msg.errors })
                  emitOutput({ type: 'system', content: 'Bedrock Opus limit hit — stepping down to Sonnet 4.6.' })
                  throw { _bedrockRetry: true, message: content }
                }
              }
            }

            if (msg.result) {
              const safeResult = secretSafety.scrubSecrets(msg.result)
              if (!collectedText.includes(safeResult) && safeResult.length > 0) {
                collectedText.push(safeResult)
              }
            }
            // Broadcast token usage (skip for internal handover messages)
            if (!suppressOutput) {
              const totalTokens = sessionTokenUsage.input + sessionTokenUsage.output
              broadcast('os-session:tokens', {
                input: sessionTokenUsage.input,
                output: sessionTokenUsage.output,
                total: totalTokens,
              })
            }
            break
          }

          default:
            // Other message types (user replay, compact_boundary, etc.) — ignore
            break
        }
      } catch (msgErr) {
        if (msgErr._bedrockRetry) throw msgErr  // let sentinel propagate to outer catch
        logger.debug('OS Session message processing error', { error: msgErr.message })
      }
    }

    // Session complete — refresh real usage % from Anthropic headers
    activeQuery = null
    await updateOSSession(dbSessionId, { ccCliSessionId: ccSessionId, status: 'complete' })
    if (!suppressOutput) {
      emitStatus('complete', { sessionId: dbSessionId, code: 0 })
      broadcast('os-session:complete', { sessionId: dbSessionId, code: 0 })
    }

    // Quota check fires in background — updates energy state from real headers
    usageEnergy.refreshQuotaCheck()
      .then(() => usageEnergy.getEnergy())
      .then(energy => { if (!suppressOutput) broadcast('os-session:energy', energy) })
      .catch(() => {})

    // Ingest current session transcript into persistent memory (fire-and-forget, recent files only)
    // Full backlog scan runs in the codebase index worker cycle.
    sessionMemory.ingestProjectDir(undefined, { recentHours: 2 })
      .catch(err => logger.debug('Session memory ingest skipped', { error: err.message }))

    const totalTokens = sessionTokenUsage.input + sessionTokenUsage.output
    logger.info('OS Session exchange complete', { sessionId: dbSessionId, ccSessionId, totalTokens })

    // Auto-handover DISABLED — was nuking full session context and replacing it with
    // a lossy brief summary. SDK compaction (re-enabled above) handles context management
    // by summarising older messages in-place within the same session, preserving continuity.
    // The autoHandover() function is kept below for reference but no longer fires.

    return {
      sessionId: dbSessionId,
      ccCliSessionId: ccSessionId,
      code: 0,
      text: collectedText.join('\n\n'),
    }

  } catch (err) {
    activeQuery = null

    // Sentinel from the result handler — flags already set, just retry
    if (err._bedrockRetry) {
      return sendMessage(err.message, opts)
    }

    // Stale session ID sentinel — cc_cli_session_id cleared, retry fresh
    if (err._staleRetry) {
      return sendMessage(err.message, { ...opts, _staleCleaned: true })
    }

    const errMsg = err.message || ''

    // Stale resume ID (e.g. after PM2 restart — CC CLI no longer has the session).
    // Clear the stored session ID and retry as a fresh session, once.
    if (!opts._staleCleaned && (
      errMsg.includes('No conversation found') ||
      errMsg.includes('session') && errMsg.includes('not found') ||
      errMsg.includes('Invalid session')
    )) {
      logger.warn('OS Session: stale resume ID detected, starting fresh', { staleCcSessionId: ccSessionId })
      ccSessionId = null
      // Clear the stale cc_cli_session_id in DB so next lookup doesn't try to resume it
      if (session?.id) {
        await db`UPDATE cc_sessions SET cc_cli_session_id = NULL WHERE id = ${session.id}`.catch(() => {})
      }
      return sendMessage(content, { ...opts, _staleCleaned: true })
    }

    const exhausted = _isUsageExhausted(errMsg)
    const hasAccount2Catch = !!(env.CLAUDE_CONFIG_DIR_2)
    logger.warn('OS Session catch block', { errMsg: errMsg.slice(0, 200), exhausted, hasAccount2: hasAccount2Catch, canBedrock: !!canBedrock, usingAccount2, usingBedrock, usingBedrockSonnet })

    // On usage exhaustion — step through the fallback chain: account1 → account2 → Bedrock Opus → Bedrock Sonnet
    if (exhausted) {
      if (!usingAccount2 && !usingBedrock && hasAccount2Catch) {
        usingAccount2 = true
        _exhaustedAt = Date.now()
        ccSessionId = null
        usageEnergy.setProvider('claude_max_2')
        logger.warn('OS Session account 1 exhausted — switching to Claude Max account 2', { configDir: env.CLAUDE_CONFIG_DIR_2 })
        emitOutput({ type: 'system', content: '⚡ Account 1 weekly limit hit — switching to account 2 (full Opus, full thinking).' })
        return sendMessage(content)
      } else if (!usingBedrock && canBedrock) {
        usingBedrock = true
        ccSessionId = null
        usageEnergy.setProvider('bedrock_opus')
        logger.warn('OS Session all Claude Max accounts exhausted — switching to Bedrock Opus', { error: errMsg })
        emitOutput({ type: 'system', content: 'Both Claude Max accounts exhausted — switching to Bedrock Opus.' })
        return sendMessage(content)
      } else if (usingBedrock && !usingBedrockSonnet && canBedrock) {
        usingBedrockSonnet = true
        ccSessionId = null
        usageEnergy.setProvider('bedrock_sonnet')
        logger.warn('OS Session Bedrock Opus limit — stepping down to Bedrock Sonnet', { error: errMsg })
        emitOutput({ type: 'system', content: 'Bedrock Opus limit hit — stepping down to Sonnet 4.6.' })
        return sendMessage(content)
      }
    }

    // All providers exhausted or non-quota error
    logger.error('OS Session SDK error', { error: errMsg, stack: err.stack, usingBedrock, usingBedrockSonnet })

    emitOutput({ type: 'error', content: errMsg })
    emitStatus('error', { error: errMsg })
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

// Serialized wrapper — all sendMessage calls queue through this so they never
// race or clobber each other's queries. This prevents scheduler crons, factory
// completions, and user messages from interrupting each other mid-stream.
async function sendMessage(content, opts = {}) {
  const promise = _sendQueue.then(() => _sendMessageImpl(content, opts))
  // Always chain even on error so the queue doesn't stall
  _sendQueue = promise.catch(() => {})
  return promise
}

// ── Get current session status ──

async function getStatus() {
  const session = await getOSSession()
  const provider = usingBedrockSonnet ? 'bedrock-sonnet' : usingBedrock ? 'bedrock-opus' : 'anthropic'
  return {
    active: !!activeQuery,
    sessionId: session?.id || null,
    ccCliSessionId: session?.cc_cli_session_id || null,
    status: activeQuery ? 'streaming' : (session?.status || 'idle'),
    startedAt: session?.started_at,
    provider,
  }
}

// ── Restart — kill current, start fresh ──

async function restart() {
  if (activeQuery) {
    try { activeQuery.close() } catch {}
    activeQuery = null
  }
  ccSessionId = null
  usingBedrock = false        // reset — try primary again on restart
  usingBedrockSonnet = false
  usageEnergy.setProvider('claude_max')
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

// DEPRECATED — SDK native compaction handles context management internally.
// This function DESTROYS the current session and starts fresh with a summary,
// losing all conversation history. Only kept for the /compact endpoint backwards compat.
async function compact(summary) {
  logger.warn('compact() called — this is DEPRECATED and destroys session context. Use SDK compaction instead.')
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

// ── Auto-handover — self-initiated seamless session transition ──
//
// Design goals:
//  1. Only fires at end of a complete turn (natural pause in conversation)
//  2. Asks the current session to write its own detailed handover brief
//  3. Warms the new session with that brief + instructs it to read CLAUDE.md/docs
//  4. Signals frontend with last-N messages so UI can do a seamless dissolve
//  5. Never interrupts an active stream — deferred until turn completes

async function autoHandover(recentMessages) {
  if (handoverInProgress) return
  handoverInProgress = true

  try {
    logger.info('OS Session: auto-handover triggered (DEPRECATED — SDK compaction handles this)', {
      tokens: sessionTokenUsage.input + sessionTokenUsage.output,
    })

    // Signal frontend: handover is starting. Pass last 6 messages for continuity display.
    broadcast('os-session:handover', {
      phase: 'preparing',
      recentMessages: (recentMessages || []).slice(-6),
      tokens: sessionTokenUsage.input + sessionTokenUsage.output,
    })

    // Ask current session to write its own handover brief.
    // This runs in the CURRENT session context so it has full conversation history.
    const briefRequest = `[SYSTEM: Context refresh needed — session approaching token limit]

Please write a comprehensive handover brief for a fresh session that will continue this conversation. The brief must be detailed enough that the new session can continue seamlessly without the user noticing any gap.

Format the brief exactly as follows:

## HANDOVER BRIEF

### Active conversation context
[What we are currently discussing, what the user is trying to accomplish, current state of any in-progress work]

### Key decisions made
[Any decisions, plans, or conclusions reached in this session]

### Current task state
[If any code/system work is in progress: what's done, what's next, what files were changed]

### Personality & tone notes
[How this conversation has been going — user's communication style, any preferences expressed]

### Critical context
[Anything else the new session MUST know to continue without confusion]

### Last few exchanges (verbatim if important)
[The most recent 2-3 turns summarised precisely]

Write this now. Be thorough — this brief is the only continuity between sessions.`

    emitStatus('handover_preparing', { phase: 'generating_brief' })
    // Suppress output during brief generation — this is an internal turn, not a user-visible response
    const briefResult = await sendMessage(briefRequest, { suppressOutput: true })
    const brief = briefResult.text || ''

    if (!brief || brief.length < 100) {
      logger.warn('OS Session: handover brief too short, aborting handover')
      handoverInProgress = false
      broadcast('os-session:handover', { phase: 'cancelled', reason: 'brief_too_short' })
      return
    }

    // Signal frontend: brief ready, warming new session
    broadcast('os-session:handover', { phase: 'warming', briefLength: brief.length })
    emitStatus('handover_warming', { phase: 'warming_new_session' })

    // Kill current session state and create new session
    if (activeQuery) {
      try { activeQuery.close() } catch {}
      activeQuery = null
    }
    const newSession = await createOSSession()
    sessionTokenUsage = { input: 0, output: 0 }
    ccSessionId = null

    const cwd = env.OS_SESSION_CWD || '/home/tate/ecodiaos'

    // Warm message: brief + instruction to read CLAUDE.md and relevant docs
    const warmMessage = `[NEW SESSION — HANDOVER BRIEF FROM PREVIOUS SESSION]

${brief}

[END HANDOVER BRIEF]

You are a fresh session continuing the above conversation. Before responding to the user:

1. Read CLAUDE.md in the current working directory (${cwd}) for your identity, capabilities, and OS context
2. Quickly scan the relevant spec files in .claude/ for any system context that applies to the current work
3. Then continue the conversation as if there was no interruption — the user should not notice the session transition at all

The handover is complete when you've read the docs and are ready to continue. Do NOT mention the session transition unless directly asked.`

    logger.info('OS Session: warming new session with handover brief', {
      newSessionId: newSession.id,
      briefLength: brief.length,
    })

    // Run the warm message — starts the new session, loads CLAUDE.md/docs.
    // Suppressed from frontend: this is an internal context-loading turn, not a chat response.
    const warmResult = await sendMessage(warmMessage, { suppressOutput: true })

    // Signal frontend: handover complete, new session ready to receive user messages.
    // Also send a final 'complete' so the frontend status resets to idle.
    emitStatus('complete', { sessionId: newSession.id, code: 0 })
    broadcast('os-session:complete', { sessionId: newSession.id, code: 0 })
    broadcast('os-session:handover', {
      phase: 'complete',
      newSessionId: newSession.id,
      briefPreview: brief.slice(0, 500),
    })
    emitStatus('handover_complete', { sessionId: newSession.id })

    logger.info('OS Session: handover complete', { newSessionId: newSession.id })
    return warmResult

  } catch (err) {
    logger.error('OS Session: auto-handover failed', { error: err.message })
    broadcast('os-session:handover', { phase: 'failed', error: err.message })
    handoverInProgress = false
  } finally {
    handoverInProgress = false
  }
}

// ── Get token usage ──

function getTokenUsage() {
  return {
    ...sessionTokenUsage,
    total: sessionTokenUsage.input + sessionTokenUsage.output,
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

module.exports = { sendMessage, getStatus, restart, getHistory, compact, getTokenUsage, recoverResponse, autoHandover }
