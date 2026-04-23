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
 *     block. Rescue starts fresh every session. It's not a conductor.
 *   - NO handoff / autoHandover / compaction. When it hits context limits
 *     it writes a final [RESCUE_REPORT] and exits; a new invocation starts
 *     a fresh session.
 *   - NO scheduler, NO heartbeat. It only runs when invoked.
 *   - NO route wiring on this process. All HTTP routes are served by
 *     ecodia-api; this process only consumes Redis messages.
 *
 * Lifecycle:
 *   boot → publishReady() → idle (no CC session yet)
 *   first message arrives via rescue:message:send
 *     → start CC session with custom system prompt
 *     → stream output via rescue:output
 *     → status via rescue:status
 *     → complete: session exits. Next message starts a NEW session.
 */
const logger = require('../config/logger')
const bridge = require('../services/rescueBridge')

const SESSION_MAX_TURNS = parseInt(process.env.RESCUE_MAX_TURNS || '20', 10)
const SESSION_IDLE_TIMEOUT_MS = parseInt(process.env.RESCUE_IDLE_TIMEOUT_MS || (20 * 60 * 1000).toString(), 10)

// ─── Auth selection ──────────────────────────────────────────────────
// Rescue's own token first, then fall back to background then tate tokens
// so the process has something to talk to Anthropic with even before you
// cut a dedicated rescue token.
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

You run in a separate process (ecodia-rescue) that stays alive even when main (ecodia-api) is wedged or crash-looping. You have VPS shell access, git, gh CLI, pm2, filesystem read/write, and a pre-composed crisis brief prepended to your first message.

Your rules:
1. You do not do normal OS work. You do not send emails, update the CRM, run bookkeeping, talk to clients, post to social, or run Factory dispatch for feature work. If Tate asks you to, politely decline and tell him to ask main OS once it's back.
2. You DO read logs, inspect process state, grep code, check git state, run diagnostics, fix code issues, restart services, and deploy code fixes.
3. Your escape hatches are: (a) \`git reset --hard <known-good-sha>\` + \`pm2 restart ecodia-api\` for "this PR broke main"; (b) \`pm2 restart ecodia-api\` alone for "it just needs a kick"; (c) SMS Tate if you need Tate's attention.
4. Report progress frequently. Tate may be watching the rescue UI. Announce what you're investigating before you investigate it. Announce what you're fixing before you fix it.
5. When main is back healthy, write a brief \`[RESCUE_REPORT] …\` line summarizing what you found and what you did, then stop.
6. Do not recurse into your own process. If ecodia-rescue itself is sick, you can't fix yourself — escalate to Tate.
7. Do not rewrite systems. You are a surgeon, not an architect. The smallest correct change wins. If a proper fix would be large, apply the minimum patch that restores main and file the rest as a followup for main OS.

Your available tools are scoped to infra and code. You do NOT have access to CRM, bookkeeping, email, calendar, finance, social, or Factory background dispatch. Do not ask about them.`

// ─── Session state ────────────────────────────────────────────────────
let activeQuery = null
let idleTimer = null
let turnCount = 0

function _armIdleTimer() {
  if (idleTimer) clearTimeout(idleTimer)
  idleTimer = setTimeout(() => {
    if (activeQuery) {
      logger.info('rescueRunner: idle timeout reached, closing session')
      _abortActive('idle_timeout')
    }
  }, SESSION_IDLE_TIMEOUT_MS)
  if (typeof idleTimer.unref === 'function') idleTimer.unref()
}

function _abortActive(reason) {
  const q = activeQuery
  activeQuery = null
  if (q) {
    Promise.resolve().then(() => q.close?.()).catch(() => {})
  }
  bridge.publishStatus('idle', { abortReason: reason })
}

function _buildOptions() {
  // Tool scoping: shell, git, gh, pm2 via Bash; filesystem Read/Write/Edit;
  // Grep for code search. No MCP servers for domain work. We include the
  // Agent tool OFF — no subagent delegation from rescue.
  return {
    cwd: process.env.RESCUE_REPO_PATH || '/home/tate/ecodiaos',
    permissionMode: 'bypassPermissions',
    allowDangerouslySkipPermissions: true,
    includePartialMessages: true,
    systemPrompt: RESCUE_SYSTEM_PROMPT,
    model: process.env.RESCUE_MODEL || 'claude-sonnet-4-6', // Sonnet default: fast, cheap, capable enough for surgical fixes
    thinking: { type: 'enabled', budget_tokens: 8000 },
    // No MCP servers — rescue uses only built-in CC tools (Bash, Read, Edit,
    // Write, Grep, Glob, WebFetch). This is intentional; MCP servers are the
    // thing that might be broken in the first place.
    mcpServers: {},
    allowedTools: ['Bash', 'Read', 'Edit', 'Write', 'Grep', 'Glob', 'WebFetch'],
    // No subagents.
    agents: {},
  }
}

async function _runTurn(messageContent) {
  if (turnCount >= SESSION_MAX_TURNS) {
    bridge.publishOutput({ type: 'text_delta', content: '\n[rescue: session turn cap reached, exiting. Send another message to start a new session.]\n' })
    bridge.publishStatus('idle', { reason: 'max_turns' })
    return
  }
  turnCount++

  bridge.publishStatus('streaming', { turn: turnCount })

  try {
    const queryFn = await getQuery()
    const options = _buildOptions()
    const token = _pickOAuthToken()
    if (token) process.env.CLAUDE_CODE_OAUTH_TOKEN = token

    const q = queryFn({ prompt: messageContent, options })
    activeQuery = q

    for await (const msg of q) {
      if (!activeQuery) break // aborted

      // Normalize SDK events to rescue:output for the api relay.
      try {
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
          // Full assistant message — could include a tool_use block complete
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
          // tool_result — echo to UI for observability
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
    bridge.publishStatus('idle', { turn: turnCount })
  } catch (err) {
    logger.error('rescueRunner: turn failed', { error: err.message, stack: err.stack })
    bridge.publishOutput({ type: 'error', content: `Rescue turn failed: ${err.message}` })
    bridge.publishStatus('error', { error: err.message })
    activeQuery = null
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

// ─── Boot ────────────────────────────────────────────────────────────
async function main() {
  logger.info('rescueRunner: booting', {
    cwd: process.cwd(),
    repoPath: process.env.RESCUE_REPO_PATH || '/home/tate/ecodiaos',
    model: process.env.RESCUE_MODEL || 'claude-sonnet-4-6',
    hasToken: !!_pickOAuthToken(),
  })

  await bridge.subscribeToApiEvents({
    [bridge.CHANNELS.MESSAGE_SEND]: (data) => {
      logger.info('rescueRunner: incoming message', { len: (data.content || '').length })
      _enqueueTurn(data.content || '')
    },
    [bridge.CHANNELS.MESSAGE_ABORT]: (data) => {
      logger.info('rescueRunner: abort requested', { reason: data.reason })
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
  // Let PM2 restart us. Never loop.
  process.exit(1)
})

// Graceful shutdown
process.on('SIGTERM', () => {
  logger.info('rescueRunner: SIGTERM — shutting down')
  _abortActive('shutdown')
  bridge.publishExit('sigterm')
  setTimeout(() => process.exit(0), 500).unref()
})
