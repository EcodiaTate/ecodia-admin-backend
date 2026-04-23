/**
 * Rescue Runner — PM2 entry point for the `ecodia-rescue` process.
 *
 * Deliberately minimal. This process exists to stay alive when main is
 * compromised and still be able to drive a Claude Code session that can
 * read logs, run pm2 commands, git operations, and edit the repo.
 *
 * Design choices, intentional:
 *   - NO subagents, NO domain MCP tools (comms/finance/CRM/bookkeeping).
 *     Rescue is for infra and code, not business work.
 *   - NO memory injection, NO session_memory_chunks, NO recent-exchange
 *     block. Rescue starts fresh every process boot.
 *   - NO handoff / autoHandover / compaction. When it hits context limits
 *     Tate decides to reset by restarting the ecodia-rescue process.
 *   - NO scheduler, NO heartbeat. It only runs when invoked.
 *   - NO route wiring on this process. All HTTP routes are served by
 *     ecodia-api; this process only consumes Redis messages.
 *
 * Conversation continuity:
 *   First message starts a fresh CC session. The SDK emits a `system:init`
 *   event with `session_id` — we capture that into `ccSessionId` and pass
 *   it as `options.resume` on every subsequent message. This gives rescue
 *   real multi-turn conversations, not one-shot isolated prompts.
 *
 * Lifecycle:
 *   boot → publishReady() → idle
 *   first message arrives via rescue:message:send
 *     → start CC session (no resume)
 *     → capture session_id from system:init event
 *     → stream output via rescue:output, status via rescue:status
 *   subsequent messages
 *     → query() with options.resume = ccSessionId
 *     → same conversation, carrying history
 *   ecodia-rescue restart (or manual reset) = fresh conversation
 */
const logger = require('../config/logger')
const bridge = require('../services/rescueBridge')

const SESSION_IDLE_TIMEOUT_MS = parseInt(process.env.RESCUE_IDLE_TIMEOUT_MS || (60 * 60 * 1000).toString(), 10)

// ─── Auth selection ──────────────────────────────────────────────────
function _pickOAuthToken() {
  return process.env.CLAUDE_CODE_OAUTH_TOKEN_RESCUE
      || process.env.CLAUDE_CODE_OAUTH_TOKEN_CODE
      || process.env.CLAUDE_CODE_OAUTH_TOKEN_TATE
      || process.env.CLAUDE_CODE_OAUTH_TOKEN
      || null
}

// ─── Lazy SDK import ──────────────────────────────────────────────────
let _query = null
async function getQuery() {
  if (!_query) {
    const sdk = await import('@anthropic-ai/claude-agent-sdk')
    _query = sdk.query
  }
  return _query
}

// ─── System prompt ────────────────────────────────────────────────────
const RESCUE_SYSTEM_PROMPT = `You are EcodiaOS Rescue — a narrow, focused instance of the OS whose only job is to diagnose and fix the main EcodiaOS instance when it's broken.

You run in a separate process (ecodia-rescue) that stays alive even when main (ecodia-api) is wedged or crash-looping. You have VPS shell access, git, gh CLI, pm2, filesystem read/write, and (if Tate uses the Invoke button) a pre-composed crisis brief prepended to your first message.

Your rules:
1. You do not do normal OS work. You do not send emails, update the CRM, run bookkeeping, talk to clients, post to social, or run Factory dispatch for feature work. If Tate asks you to, politely decline and tell him to ask main OS once it's back.
2. You DO read logs, inspect process state, grep code, check git state, run diagnostics, fix code issues, restart services, and deploy code fixes.
3. Your escape hatches are: (a) \`git reset --hard <known-good-sha>\` + \`pm2 restart ecodia-api\` for "this PR broke main"; (b) \`pm2 restart ecodia-api\` alone for "it just needs a kick"; (c) Ask Tate to intervene if you need human judgment.
4. Report progress frequently. Tate is watching the rescue UI. Announce what you're investigating before you investigate it. Announce what you're fixing before you fix it.
5. When main is back healthy, write a brief \`[RESCUE_REPORT] …\` line summarizing what you found and what you did.
6. Do not recurse into your own process. If ecodia-rescue itself is sick, you can't fix yourself — escalate to Tate.
7. Do not rewrite systems. You are a surgeon, not an architect. The smallest correct change wins. If a proper fix would be large, apply the minimum patch that restores main and file the rest as a followup for main OS.

Your available tools are scoped to infra and code. You do NOT have access to CRM, bookkeeping, email, calendar, finance, social, or Factory background dispatch. Do not ask about them.`

// ─── Session state ────────────────────────────────────────────────────
let activeQuery = null
let ccSessionId = null          // captured from system:init event, used for resume
let idleTimer = null

// Per-turn inactivity watchdog. If the SDK produces no messages for this
// long, force-abort. Mirrors osSessionService's 90s rule. Catches silent
// hangs from stuck tool calls or wedged SDK state.
const TURN_INACTIVITY_TIMEOUT_MS = parseInt(process.env.RESCUE_TURN_INACTIVITY_MS || (120 * 1000).toString(), 10)
// Hard ceiling on total turn time, independent of activity. A runaway tool
// loop could keep tickling the inactivity timer forever otherwise.
const TURN_MAX_MS = parseInt(process.env.RESCUE_TURN_MAX_MS || (20 * 60 * 1000).toString(), 10)

let _inactivityTimer = null
let _turnHardTimer = null

function _armIdleTimer() {
  if (idleTimer) clearTimeout(idleTimer)
  idleTimer = setTimeout(() => {
    logger.info('rescueRunner: idle timeout — clearing session (next message starts fresh)')
    ccSessionId = null
    if (activeQuery) _abortActive('idle_timeout')
  }, SESSION_IDLE_TIMEOUT_MS)
  if (typeof idleTimer.unref === 'function') idleTimer.unref()
}

function _abortActive(reason) {
  const q = activeQuery
  activeQuery = null
  if (_inactivityTimer) { clearTimeout(_inactivityTimer); _inactivityTimer = null }
  if (_turnHardTimer)   { clearTimeout(_turnHardTimer);   _turnHardTimer = null }
  if (q) {
    Promise.resolve().then(() => q.close?.()).catch(() => {})
  }
  bridge.publishStatus('idle', { abortReason: reason })
}

function _buildOptions() {
  const options = {
    cwd: process.env.RESCUE_REPO_PATH || '/home/tate/ecodiaos',
    permissionMode: 'bypassPermissions',
    allowDangerouslySkipPermissions: true,
    includePartialMessages: true,
    systemPrompt: RESCUE_SYSTEM_PROMPT,
    model: process.env.RESCUE_MODEL || 'claude-opus-4-7',
    thinking: { type: 'enabled', budget_tokens: 8000 },
    // No MCP servers — rescue uses only built-in CC tools. MCP servers are
    // often the thing that might be broken in the first place.
    mcpServers: {},
    allowedTools: ['Bash', 'Read', 'Edit', 'Write', 'Grep', 'Glob', 'WebFetch'],
    agents: {},
  }
  if (ccSessionId) options.resume = ccSessionId
  return options
}

function _resetInactivityTimer() {
  if (_inactivityTimer) clearTimeout(_inactivityTimer)
  _inactivityTimer = setTimeout(() => {
    logger.error('rescueRunner: inactivity timeout — aborting turn')
    _abortActive('inactivity_timeout')
  }, TURN_INACTIVITY_TIMEOUT_MS)
  if (typeof _inactivityTimer.unref === 'function') _inactivityTimer.unref()
}

function _clearTurnTimers() {
  if (_inactivityTimer) { clearTimeout(_inactivityTimer); _inactivityTimer = null }
  if (_turnHardTimer)   { clearTimeout(_turnHardTimer);   _turnHardTimer = null }
}

async function _runTurn(messageContent) {
  bridge.publishStatus('streaming', { resume: !!ccSessionId })

  // Arm both timers for the turn.
  _resetInactivityTimer()
  _turnHardTimer = setTimeout(() => {
    logger.error('rescueRunner: hard turn ceiling reached — aborting')
    _abortActive('turn_max_ms')
  }, TURN_MAX_MS)
  if (typeof _turnHardTimer.unref === 'function') _turnHardTimer.unref()

  try {
    const queryFn = await getQuery()
    const options = _buildOptions()
    const token = _pickOAuthToken()
    if (token) process.env.CLAUDE_CODE_OAUTH_TOKEN = token

    const q = queryFn({ prompt: messageContent, options })
    activeQuery = q

    for await (const msg of q) {
      if (!activeQuery) break // aborted
      _resetInactivityTimer()

      try {
        // Capture session_id on first init so subsequent turns can resume.
        if (msg.type === 'system' && msg.subtype === 'init' && msg.session_id) {
          if (msg.session_id !== ccSessionId) {
            ccSessionId = msg.session_id
            logger.info('rescueRunner: captured cc session_id for resume', { ccSessionId })
          }
          continue
        }

        if (msg.type === 'stream_event') {
          const ev = msg.event
          if (ev?.type === 'content_block_delta' && ev?.delta?.type === 'text_delta') {
            bridge.publishOutput({ type: 'text_delta', content: ev.delta.text || '' })
          } else if (ev?.type === 'content_block_delta' && ev?.delta?.type === 'thinking_delta') {
            bridge.publishOutput({ type: 'thinking_delta', content: ev.delta.thinking || '' })
          } else if (ev?.type === 'content_block_start' && ev?.content_block?.type === 'tool_use') {
            bridge.publishOutput({
              type: 'tool_use_starting',
              tool_use_id: ev.content_block.id,
              tool_name: ev.content_block.name,
            })
          }
        } else if (msg.type === 'assistant') {
          for (const block of msg.message?.content || []) {
            if (block.type === 'tool_use') {
              bridge.publishOutput({
                type: 'tool_use_input_complete',
                tool_use_id: block.id,
                tool_name: block.name,
                input: block.input,
              })
            }
          }
        } else if (msg.type === 'user') {
          for (const block of msg.message?.content || []) {
            if (block.type === 'tool_result') {
              const content = Array.isArray(block.content)
                ? block.content.map(c => c.text || '').join('')
                : String(block.content || '')
              bridge.publishOutput({
                type: 'tool_result',
                tool_use_id: block.tool_use_id,
                content: content.slice(0, 5000),
                is_error: block.is_error || false,
              })
            }
          }
        } else if (msg.type === 'result') {
          bridge.publishOutput({
            type: 'turn_complete',
            subtype: msg.subtype,
            total_cost_usd: msg.total_cost_usd,
            duration_ms: msg.duration_ms,
          })
        }
      } catch (err) {
        logger.warn('rescueRunner: event relay error (non-fatal)', { error: err.message })
      }
    }

    activeQuery = null
    _clearTurnTimers()
    bridge.publishStatus('idle', { resume: !!ccSessionId })
  } catch (err) {
    logger.error('rescueRunner: turn failed', { error: err.message, stack: err.stack })
    bridge.publishOutput({ type: 'error', content: `Rescue turn failed: ${err.message}` })
    bridge.publishStatus('error', { error: err.message })
    activeQuery = null
    _clearTurnTimers()
    // If the failure was a stale/invalid resume, drop it so the next message
    // starts a fresh session instead of re-failing the same way.
    if (ccSessionId && /resume|session.*not.*found|unknown.*session/i.test(err.message || '')) {
      logger.warn('rescueRunner: dropping ccSessionId after likely-stale resume failure')
      ccSessionId = null
    }
  }
}

// ─── Message queue — serialize turns ─────────────────────────────────
let sendQueue = Promise.resolve()
function _enqueueTurn(content) {
  _armIdleTimer()
  sendQueue = sendQueue
    .then(() => _runTurn(content))
    .catch(err => logger.error('rescueRunner: queued turn failed', { error: err.message }))
  return sendQueue
}

// ─── Reset handler ────────────────────────────────────────────────────
// Drop session_id so next message starts fresh. Doesn't abort an active
// turn — that's a separate action via MESSAGE_ABORT.
function _resetSession(reason) {
  logger.info('rescueRunner: session reset', { reason, hadSessionId: !!ccSessionId })
  ccSessionId = null
}

// ─── Boot ────────────────────────────────────────────────────────────
async function main() {
  logger.info('rescueRunner: booting', {
    cwd: process.cwd(),
    repoPath: process.env.RESCUE_REPO_PATH || '/home/tate/ecodiaos',
    model: process.env.RESCUE_MODEL || 'claude-opus-4-7',
    hasToken: !!_pickOAuthToken(),
    idleTimeoutMs: SESSION_IDLE_TIMEOUT_MS,
  })

  bridge.subscribeToApiEvents({
    [bridge.CHANNELS.MESSAGE_SEND]: (data) => {
      logger.info('rescueRunner: incoming message', {
        len: (data.content || '').length, hasResume: !!ccSessionId,
      })
      _enqueueTurn(data.content || '')
    },
    [bridge.CHANNELS.MESSAGE_ABORT]: (data) => {
      logger.info('rescueRunner: abort requested', { reason: data.reason })
      // Special reason 'reset_session' also clears ccSessionId so next
      // message starts fresh. Used by POST /api/rescue/reset.
      if (data.reason === 'reset_session') _resetSession('api_reset')
      _abortActive(data.reason || 'user_abort')
    },
    [bridge.CHANNELS.HEALTH_PING]: () => {
      bridge.publishHealthPong()
    },
  })

  bridge.publishReady()
  bridge.publishStatus('idle', { booted: true })
  logger.info('rescueRunner: ready')
}

// Crash-safe startup
main().catch(err => {
  logger.error('rescueRunner: fatal boot error', { error: err.message, stack: err.stack })
  process.exit(1)
})

// Graceful shutdown
process.on('SIGTERM', () => {
  logger.info('rescueRunner: SIGTERM — shutting down')
  _abortActive('shutdown')
  bridge.publishExit('sigterm')
  setTimeout(() => process.exit(0), 500).unref()
})

// Also handle uncaught exceptions so PM2's crash signal is clean.
process.on('uncaughtException', (err) => {
  logger.error('rescueRunner: uncaught exception', { error: err.message, stack: err.stack })
  process.exit(1)
})
process.on('unhandledRejection', (reason) => {
  logger.error('rescueRunner: unhandled rejection', {
    reason: reason && reason.message ? reason.message : String(reason),
  })
  // Don't exit on unhandled rejections — they're usually SDK quirks or
  // transient Redis hiccups that we don't want to take the whole process
  // down for.
})
