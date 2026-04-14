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
 * Provider fallback chain (smart selection via usageEnergyService.getBestProvider()):
 *   1. Healthiest Claude Max account (whichever has more weekly + 5h headroom)
 *   2. The other Claude Max account (if first is capped — weekly OR 5h session)
 *   3. Bedrock Opus (final fallback when both Max accounts are exhausted)
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

// Fire quota-checks for BOTH accounts on startup to get real usage % immediately
usageEnergy.refreshAllAccounts()
  .then(() => usageEnergy.getEnergy())
  .then(e => logger.info('Claude energy on startup', {
    pctUsed: e.pctUsed, level: e.level,
    recommended: e.recommendedProvider, reason: e.providerReason,
    acct1: e.accounts?.claude_max?.pctUsed, acct2: e.accounts?.claude_max_2?.pctUsed,
  }))
  .catch(() => {})


// ─── Conductor Architecture ─────────────────────────────────────────────────
// The OS session is a lightweight conductor (~35 tools) that delegates to
// domain-specific subagents. Each subagent loads only its relevant MCP servers,
// keeping the conductor's context window lean.
//
// Conductor keeps:  neo4j, scheduler, factory, supabase
// Subagents:        comms (google-workspace+crm+sms), finance (bookkeeping+supabase),
//                   ops (vps+supabase), social (business-tools)

const CONDUCTOR_SERVERS = ['neo4j', 'scheduler', 'factory', 'supabase']

const SUBAGENT_DOMAINS = {
  comms:   ['google-workspace', 'crm', 'sms'],
  finance: ['bookkeeping', 'supabase'],
  ops:     ['vps', 'supabase'],
  social:  ['business-tools'],
}

/**
 * Read .mcp.json and normalize ALL server configs into SDK format.
 * This is the raw material that conductor + subagents both draw from.
 */
function getAllMcpServerConfigs(cwd) {
  try {
    const p = path.join(cwd, '.mcp.json')
    if (!fs.existsSync(p)) {
      logger.warn('No .mcp.json found in OS session cwd', { cwd })
      return {}
    }
    const raw = JSON.parse(fs.readFileSync(p, 'utf8'))
    const servers = raw.mcpServers || {}
    const normalized = {}
    for (const [name, cfg] of Object.entries(servers)) {
      normalized[name] = {
        type: cfg.type || 'stdio',
        command: cfg.command,
        args: cfg.args || [],
        ...(cfg.env ? { env: cfg.env } : {}),
      }
    }
    logger.info('Loaded all MCP server configs', { count: Object.keys(normalized).length, names: Object.keys(normalized) })
    return normalized
  } catch (err) {
    logger.error('Failed to load .mcp.json', { cwd, error: err.message })
    return {}
  }
}

/**
 * Extract only conductor-level servers (neo4j, scheduler, factory, supabase).
 * These are the only MCP tools the OS session sees in its context window.
 */
function loadConductorServers(allConfigs) {
  const conductor = {}
  for (const name of CONDUCTOR_SERVERS) {
    if (allConfigs[name]) conductor[name] = allConfigs[name]
  }
  logger.info('Conductor servers loaded', { count: Object.keys(conductor).length, names: Object.keys(conductor) })
  return conductor
}

/**
 * Build inline MCP server configs for a subagent domain.
 * Returns array of AgentMcpServerSpec (Record<string, McpServerConfig>) entries.
 */
function _mcpForDomain(allConfigs, serverNames) {
  const specs = []
  for (const name of serverNames) {
    if (allConfigs[name]) {
      specs.push({ [name]: allConfigs[name] })
    }
  }
  return specs
}

/**
 * Build the agents object for query() options.
 * Each subagent gets its own MCP servers (inline, not inherited from parent)
 * so the conductor never sees those tools in its context.
 */
function buildSubagentConfigs(allConfigs) {
  return {
    comms: {
      description: 'Communications hub: email triage and responses, calendar management, CRM updates, SMS. Use for anything involving Gmail, Calendar, Drive, contacts, CRM client management, or sending SMS messages.',
      prompt: [
        'You are the EcodiaOS communications specialist -- part of the Ecodia DAO LLC operating team.',
        'You handle all email, calendar, CRM, and SMS operations with professional quality.',
        '',
        'Guidelines:',
        '- Before responding to any email, check CRM (crm_search_clients, crm_get_intelligence) for context on the sender.',
        '- After sending emails or SMS, update CRM: add activity notes (crm_add_note), update stage if warranted (crm_update_stage).',
        '- For calendar events, always include timezone (AEST/Brisbane) and check for conflicts.',
        '- Emails must sound like a sharp, professional business partner -- not a bot or template.',
        '- Report back a concise summary of what you did and any follow-up actions needed.',
      ].join('\n'),
      model: 'sonnet',
      mcpServers: _mcpForDomain(allConfigs, SUBAGENT_DOMAINS.comms),
      permissionMode: 'bypassPermissions',
      maxTurns: 30,
    },

    finance: {
      description: 'Finance and bookkeeping: transaction categorization, P&L reports, BAS/GST position, balance sheets, cash flow, billing, and accounting rules. Use for anything involving bookkeeping, financial reports, or transaction management.',
      prompt: [
        'You are the EcodiaOS finance officer -- part of the Ecodia DAO LLC operating team.',
        'You handle all bookkeeping, financial reporting, and transaction management.',
        '',
        'Guidelines:',
        '- Maintain double-entry accuracy. Every transaction must balance.',
        '- Flag GST implications on all categorizations (10% AU GST).',
        '- When running reports (bk_pnl, bk_balance_sheet, bk_bas), present clean summaries with key numbers highlighted.',
        '- Auto-categorize transactions using rules (bk_list_rules) before falling back to manual categorization.',
        '- Report back concise financial summaries, not raw data dumps.',
      ].join('\n'),
      model: 'sonnet',
      mcpServers: _mcpForDomain(allConfigs, SUBAGENT_DOMAINS.finance),
      permissionMode: 'bypassPermissions',
      maxTurns: 20,
    },

    ops: {
      description: 'Infrastructure and operations: VPS server management, PM2 process control, shell commands, deployments, log analysis, database diagnostics. Use for anything involving server health, service restarts, deployment, or system debugging.',
      prompt: [
        'You are the EcodiaOS ops engineer -- part of the Ecodia DAO LLC operating team.',
        'You manage VPS infrastructure, services, and deployments.',
        '',
        'Guidelines:',
        '- Always diagnose before acting. Check logs (pm2_logs) and status (pm2_list) before restarting.',
        '- Never restart a service without understanding why it needs restarting.',
        '- For deployments: git pull, npm install if needed, pm2 restart, then verify with pm2_list.',
        '- Report service health clearly: what is running, what is not, any error patterns.',
        '- Use db_query via supabase for diagnostic queries when needed.',
      ].join('\n'),
      model: 'sonnet',
      mcpServers: _mcpForDomain(allConfigs, SUBAGENT_DOMAINS.ops),
      permissionMode: 'bypassPermissions',
      maxTurns: 20,
    },

    social: {
      description: 'Social media and external platforms: Zernio social media posting/analytics, Vercel deployments, Xero accounting sync. Use for anything involving social media, website deployments, or Xero integration.',
      prompt: [
        'You are the EcodiaOS marketing and platform specialist -- part of the Ecodia DAO LLC operating team.',
        'You manage social media presence, website deployments, and external platform integrations.',
        '',
        'Guidelines:',
        '- Match the Ecodia brand voice: plain, concise, no hype or reassurance.',
        '- Use zernio_best_time_to_post before scheduling content.',
        '- For Vercel deploys, verify the deployment status after triggering.',
        '- Report analytics concisely with key metrics highlighted.',
      ].join('\n'),
      model: 'sonnet',
      mcpServers: _mcpForDomain(allConfigs, SUBAGENT_DOMAINS.social),
      permissionMode: 'bypassPermissions',
      maxTurns: 15,
    },
  }
}

/**
 * Build programmatic hooks for the OS session.
 * These replace the shell-based hooks in vps-hooks/settings-account1.json
 * with native JS callbacks -- faster, more reliable, guaranteed to fire.
 */
function buildProgrammaticHooks() {
  // NOTE: UserPromptSubmit hook removed 2026-04-11.
  // Reason: it injected "Think like a CEO..." every turn, which (a) is redundant
  // with CLAUDE.md, and (b) breaks the prompt cache boundary by inserting fresh
  // content between the cached system prompt and conversation, forcing full re-bill
  // of the system prompt each turn. Anthropic prompt caching is prefix-based —
  // any insertion invalidates the cache from that point down.
  //
  // Dead hook removed:
  //   - `Write|Edit` PostToolUse: conductor's allowedTools only includes
  //     mcp__*__* and Agent. Write/Edit never fire at the conductor level.
  //
  // NOTE: neo4j PostToolUse matcher retained — the VPS ~/ecodiaos/.mcp.json
  // DOES include a neo4j server (confirmed by OS Session using graph_merge_node
  // and graph_create_relationship in active sessions). Local d:/.code/EcodiaOS/.mcp.json
  // is drifted and missing neo4j; the VPS copy is authoritative. If you edit
  // the local .mcp.json, scp to VPS or copy from VPS before pushing.
  return {
    PostToolUse: [
      // Factory dispatch oversight — fires only when Factory session is kicked off
      {
        matcher: 'mcp__factory__start_cc_session',
        hooks: [async (_input) => ({
          hookSpecificOutput: {
            hookEventName: 'PostToolUse',
            additionalContext: 'You dispatched a Factory session. What are your acceptance criteria? Which spec docs might the diff affect? Set a mental checkpoint to review when it completes.',
          },
        })],
        timeout: 3,
      },
      // Scheduler quality check — fires only on schedule creation
      {
        matcher: 'mcp__scheduler__schedule_cron|mcp__scheduler__schedule_delayed|mcp__scheduler__schedule_chain',
        hooks: [async (_input) => ({
          hookSpecificOutput: {
            hookEventName: 'PostToolUse',
            additionalContext: 'Re-read the prompt you scheduled. It will arrive with zero context -- does it have enough detail to act on cold?',
          },
        })],
        timeout: 3,
      },
      // Neo4j memory quality — fires on graph writes
      {
        matcher: 'mcp__neo4j__graph_reflect|mcp__neo4j__graph_merge_node',
        hooks: [async (_input) => ({
          hookSpecificOutput: {
            hookEventName: 'PostToolUse',
            additionalContext: 'Cold-start test: would a new session reading only this node make a better decision? Good memory is specific context + reasoning, not vague summaries.',
          },
        })],
        timeout: 3,
      },
    ],

    SubagentStop: [{
      hooks: [async (input) => ({
        systemMessage: `Subagent "${input.agent_type}" completed. Review its result and decide: any follow-up actions, CRM update, or scheduled task needed?`,
      })],
      timeout: 3,
    }],
  }
}

// ─── Custom system prompt builder ───────────────────────────────────────────
// Context-burn investigation 2026-04-11 — verified in SDK v0.2.92 cli.js that
// when `systemPrompt` is omitted OR `{type:'preset'}` is passed without a string,
// the CLI loads the full `GW()` default section array (~5-6k tokens of Claude
// Code CLI scaffolding: output style, tool permission guidance, tone rules,
// coding instructions, session guidance, env info, auto-memory scanner, etc.).
//
// By passing a plain STRING systemPrompt, `Lx()` in cli.js bypasses the entire
// default array — we get only the string we provide. That saves ~5k input tokens
// per turn AND preserves the prompt cache boundary (since our string is stable).
//
// We inline CLAUDE.md ourselves so `settingSources: ['project']` can be dropped
// (which also disables auto-memory file scanning — another per-turn cost).
let _cachedSystemPrompt = null
let _cachedSystemPromptCwd = null

function buildCustomSystemPrompt(cwd) {
  if (_cachedSystemPrompt && _cachedSystemPromptCwd === cwd) {
    return _cachedSystemPrompt
  }
  // Read project CLAUDE.md (the OS's operational identity)
  let claudeMd = ''
  try {
    const claudeMdPath = path.join(cwd, 'CLAUDE.md')
    if (fs.existsSync(claudeMdPath)) {
      claudeMd = fs.readFileSync(claudeMdPath, 'utf8')
    }
  } catch (err) {
    logger.warn('Failed to read CLAUDE.md for custom system prompt', { cwd, error: err.message })
  }

  // Minimal environment context — replaces the SDK's verbose default env block
  const today = new Date().toISOString().slice(0, 10)
  const envBlock = `# Environment
Working directory: ${cwd}
Platform: linux
Date: ${today}
You are powered by Claude (Anthropic's model). Running inside the EcodiaOS conductor via the Claude Agent SDK.`

  // Minimal tone/behavior rules — only the non-obvious things the model needs.
  // Everything else is either in CLAUDE.md or is default model behavior.
  const behaviorBlock = `# Behavior
- You are a conductor. Delegate domain work (email, finance, ops, social) to the subagent with the right tools via the Agent tool. Do not try to do that work yourself — you don't have those tools.
- Keep responses terse. The user can read tool outputs; don't restate them.
- When referencing files, use markdown links like [file.js:42](path/to/file.js#L42).
- All text you output outside of tool use is shown to the user.`

  _cachedSystemPrompt = [claudeMd, envBlock, behaviorBlock].filter(Boolean).join('\n\n---\n\n')
  _cachedSystemPromptCwd = cwd
  logger.info('Custom system prompt built', {
    bytes: _cachedSystemPrompt.length,
    hasClaudeMd: !!claudeMd,
  })
  return _cachedSystemPrompt
}

// Token tracking (informational only — SDK/CLI handles its own context management;
// we track tokens purely for the frontend usage bar display.)
let handoverInProgress = false

// In-memory state
let activeQuery = null          // the running Query object from the SDK
let ccSessionId = null          // CC's internal session_id (for resume)
let sessionTokenUsage = { input: 0, output: 0 }
let _currentProvider = 'claude_max'  // tracks which provider the current session is using

// Message queue — prevents concurrent sendMessage calls from racing and clobbering
// each other's queries. Each sendMessage waits for the previous one to finish.
let _sendQueue = Promise.resolve()

// Detect usage exhaustion / rate limit errors from any error string
function _isUsageExhausted(text) {
  const t = (text || '').toLowerCase()
  return t.includes('429') || t.includes('rate limit') || t.includes('overloaded') ||
    t.includes('capacity') || t.includes('out of extra usage') || t.includes('out of usage') ||
    t.includes('weekly') || t.includes('resets ') || t.includes('not logged in') ||
    t.includes('too many requests') || t.includes('quota')
}

// Detect auth failures that a token refresh might fix.
// The Claude CLI is annoying about this — sometimes the message is rich
// ("Failed to authenticate. API Error: 401 ..."), sometimes it's just
// "claude CLI exit 1: " with empty stderr. We treat any empty/cryptic
// CLI exit as *suspect* — the caller will then live-validate the token
// to confirm before paying for a full refresh round-trip.
function _isAuthFailure(text) {
  const t = (text || '').toLowerCase()
  if (t.includes('401') || t.includes('unauthorized') || t.includes('not logged in') ||
      t.includes('invalid token') || t.includes('token expired') ||
      t.includes('invalid authentication') || t.includes('authentication_error') ||
      t.includes('failed to authenticate') ||
      (t.includes('oauth') && t.includes('error'))) {
    return true
  }
  return false
}

// Heuristic: the SDK / CLI silently failed before producing usable output.
// Triggers a token validation as a likely root cause — auth is the #1 reason
// the CLI exits early without explanation on this VPS.
function _isSuspectSilentFailure({ collectedText, errMsg, hadResultMessage }) {
  if (errMsg && /claude cli exit \d+\s*:?\s*$/i.test(errMsg)) return true
  if (errMsg && errMsg.length > 0 && errMsg.length < 5) return true
  // SDK exited the for-await loop with no result message AND no text — something
  // ate the response before we could see it. Auth is the prime suspect.
  if (!hadResultMessage && (!collectedText || collectedText.length === 0)) return true
  return false
}

// Attempt token refresh for the current provider. Returns true if refresh
// produced a working token, false otherwise.
//
// `mode` controls how we decide to refresh:
//   - 'force'     : refresh unconditionally (caller already saw a 401)
//   - 'validate'  : live-check the current token first; only refresh if API rejects it
//                   (used for *suspect* failures like empty CLI exits where auth is
//                   plausible but unconfirmed — avoids wasting a refresh on a healthy
//                   token when the real bug was something else)
async function _tryTokenRefresh(mode = 'force') {
  if (_currentProvider === 'bedrock') return false  // Bedrock uses AWS creds, not OAuth
  try {
    const tokenRefresh = require('./claudeTokenRefreshService')
    const account = _currentProvider === 'claude_max_2' ? 'claude_max_2' : 'claude_max'

    if (mode === 'validate') {
      const check = await tokenRefresh.validateAccount(account)
      if (check.valid) {
        logger.warn('OS Session: silent CLI failure but token validates — not auth', { account })
        return false  // not an auth issue; caller should treat as generic error
      }
      logger.warn('OS Session: silent CLI failure + token rejected by API — refreshing', {
        account, status: check.status, reason: check.reason,
      })
    } else {
      logger.warn('OS Session: auth failure detected — forcing token refresh', { account })
    }

    const result = await tokenRefresh.refreshAccount(account, { force: true })
    if (result.refreshed) {
      logger.info('OS Session: token refresh succeeded — retrying', { account })
      return true
    }
    if (result.deadOnArrival) {
      logger.error('OS Session: refresh produced a dead token — refresh_token may be on the way out', { account })
    }
    if (result.isRevoked) {
      logger.error('OS Session: REFRESH TOKEN REVOKED — manual login required', { account })
    }
    return false
  } catch (err) {
    logger.warn('OS Session: token refresh attempt failed', { error: err.message })
    return false
  }
}

// After an exhaustion event on the current provider, mark it rejected and pick the next best.
// Returns { provider, reason, isBedrockFallback } or null if no alternative.
function _switchAfterExhaustion() {
  // Mark current provider as rejected so getBestProvider skips it
  usageEnergy.markAccountRejected(_currentProvider, 'exhaustion_detected')
  // Re-probe to see what's available
  const best = usageEnergy.getBestProvider()
  if (best.provider === _currentProvider) {
    // getBestProvider returned the same one (best-effort) — no real alternative
    return null
  }
  return best
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

  // ─── Build SDK options (conductor architecture) ────────────────────────────
  // Load ALL MCP configs, then split: conductor gets ~35 tools directly,
  // subagents get their domain tools via inline MCP server definitions.
  const allConfigs = getAllMcpServerConfigs(cwd)
  const mcpServers = loadConductorServers(allConfigs)

  // Energy-gated thinking: extended thinking on full/healthy.
  // The OS uses thinking for strategic reasoning, diff/code review, and multi-step
  // planning on Opus 1M — 2k was confirmed too low, 10k/5k is the right ceiling.
  let energy = null
  try { energy = await usageEnergy.getEnergy() } catch {}
  const energyLevel = energy?.level || 'healthy'
  const canThink = energyLevel === 'full' || energyLevel === 'healthy'

  // Build the custom system prompt (cached per-cwd). This replaces the SDK's
  // default ~5-6k-token scaffolding entirely — see buildCustomSystemPrompt docs.
  let customSystemPrompt = buildCustomSystemPrompt(cwd)

  // Prepend restart recovery state if a recent handoff snapshot exists
  try {
    const { readHandoffState } = require('./sessionHandoff')
    const recoveryBlock = await readHandoffState()
    if (recoveryBlock) {
      customSystemPrompt = recoveryBlock + '\n\n---\n\n' + customSystemPrompt
    }
  } catch (err) {
    logger.warn('Failed to prepend handoff state', { error: err.message })
  }

  const options = {
    cwd,
    permissionMode: 'bypassPermissions',
    allowDangerouslySkipPermissions: true,
    // settingSources intentionally omitted — we inline CLAUDE.md ourselves via
    // buildCustomSystemPrompt. Setting it would trigger the CLI's auto-memory
    // subsystem (bl8 in cli.js) on top of our own inlined copy.
    includePartialMessages: true,      // stream_event messages for real-time text
    // includeHookEvents intentionally omitted — the frontend doesn't render hook
    // lifecycle events, and having them on adds events to the conversation stream
    // that the SDK persists in history, bloating resume payloads.
    //
    // systemPrompt as a plain STRING replaces the CLI's full default prompt array.
    // SDK v0.2.92 cli.js function Lx: `customSystemPrompt ? [customSystemPrompt] : defaultSystemPrompt`.
    systemPrompt: customSystemPrompt,
    model: env.OS_SESSION_MODEL || undefined,
    // NOTE: `compactionControl` option was removed 2026-04-11. Verified against SDK
    // v0.2.92 sdk.mjs — the option is destructured in HL() but never forwarded to
    // the CLI subprocess transport (only BetaToolRunner uses it, which is a
    // different API path). Passing it was a no-op. The CLI manages compaction
    // internally based on context-window pressure; we can't override that from JS.
    //
    // Extended thinking — scales with energy level.
    ...(canThink ? {
      thinking: {
        type: 'enabled',
        budget_tokens: energyLevel === 'full' ? 10000 : 5000,
      },
    } : {}),
    // Conductor-level MCP servers only (neo4j, scheduler, factory, supabase).
    // Subagent domains (comms, finance, ops, social) are defined below in agents.
    mcpServers,
    // Allow conductor MCP tools + Agent tool for subagent delegation
    allowedTools: [
      ...Object.keys(mcpServers).map(name => `mcp__${name}__*`),
      'Agent',
    ],
    // Domain subagents — each gets its own MCP servers inline (not inherited).
    // The conductor never sees these tools in its context window.
    agents: buildSubagentConfigs(allConfigs),
    // Programmatic hooks — factory dispatch oversight, scheduler quality,
    // subagent completion review. UserPromptSubmit + dead matchers removed
    // 2026-04-11 to preserve prompt cache boundary across turns.
    hooks: buildProgrammaticHooks(),
  }

  // Resume existing session or start fresh
  if (isResume && ccSessionId) {
    options.resume = ccSessionId
  }

  // ─── Smart provider selection ──────────────────────────────────────────────
  // getBestProvider() checks both accounts' weekly + 5h utilization and picks the
  // healthiest. Falls back to Bedrock when both Max accounts are exhausted.
  const best = usageEnergy.getBestProvider()
  const prevProvider = _currentProvider

  if (best.isBedrockFallback) {
    // Bedrock fallback — use ANTHROPIC_API_KEY with Bedrock model
    _currentProvider = 'bedrock'
    ccSessionId = null  // can't resume across providers
    const sessionEnv = { ...process.env }
    // For Bedrock via CC Agent SDK: set model to bedrock-prefixed model
    // and provide AWS credentials in the environment
    if (env.AWS_ACCESS_KEY_ID) sessionEnv.AWS_ACCESS_KEY_ID = env.AWS_ACCESS_KEY_ID
    if (env.AWS_SECRET_ACCESS_KEY) sessionEnv.AWS_SECRET_ACCESS_KEY = env.AWS_SECRET_ACCESS_KEY
    if (env.AWS_REGION) sessionEnv.AWS_REGION = env.AWS_REGION
    // CC Agent SDK supports Bedrock via CLAUDE_CODE_USE_BEDROCK=1
    sessionEnv.CLAUDE_CODE_USE_BEDROCK = '1'
    options.env = sessionEnv
    options.model = env.BEDROCK_MODEL || 'us.anthropic.claude-opus-4-0-20250514'
    delete options.resume
    emitOutput({ type: 'system', content: `⚡ Both Claude Max accounts exhausted — falling back to Bedrock (${options.model}).` })
  } else if (best.provider === 'claude_max_2') {
    _currentProvider = 'claude_max_2'
    if (prevProvider !== 'claude_max_2') {
      ccSessionId = null  // can't resume across config dirs
    }
    const sessionEnv = { ...process.env }
    // CRITICAL: strip ANTHROPIC_API_KEY on OAuth paths. If present, the CLI/SDK
    // silently prefers it over the OAuth credentials in CLAUDE_CONFIG_DIR and
    // bills the API wallet instead of Claude Max. Confirmed in memory
    // project_os_session_mcp_fix_apr2026: "Never set ANTHROPIC_API_KEY".
    delete sessionEnv.ANTHROPIC_API_KEY
    sessionEnv.CLAUDE_CONFIG_DIR = env.CLAUDE_CONFIG_DIR_2
    options.env = sessionEnv
    if (prevProvider !== 'claude_max_2') {
      delete options.resume
      emitOutput({ type: 'system', content: `⚡ Switching to account 2 — ${best.reason}` })
    }
  } else {
    _currentProvider = 'claude_max'
    if (prevProvider !== 'claude_max') {
      ccSessionId = null
    }
    const sessionEnv = { ...process.env }
    // Same ANTHROPIC_API_KEY strip — see claude_max_2 branch above for rationale.
    delete sessionEnv.ANTHROPIC_API_KEY
    if (env.CLAUDE_CONFIG_DIR_1) sessionEnv.CLAUDE_CONFIG_DIR = env.CLAUDE_CONFIG_DIR_1
    options.env = sessionEnv
    if (prevProvider && prevProvider !== 'claude_max') {
      delete options.resume
      emitOutput({ type: 'system', content: `Returning to account 1 — ${best.reason}` })
    }
  }

  usageEnergy.setProvider(_currentProvider)

  // Log full provider decision for debugging
  logger.info('OS Session provider decision', {
    provider: _currentProvider,
    reason: best.reason,
    isBedrockFallback: best.isBedrockFallback,
    prevProvider,
    configDir1: env.CLAUDE_CONFIG_DIR_1 || '(default)',
    configDir2: env.CLAUDE_CONFIG_DIR_2 || '(not set)',
    resume: options.resume || null,
    model: options.model || '(default)',
    energyLevel,
    energyPctUsed: energy?.pctUsed,
    acct1PctUsed: energy?.accounts?.claude_max?.pctUsed,
    acct2PctUsed: energy?.accounts?.claude_max_2?.pctUsed,
    acct1SessionPct: energy?.accounts?.claude_max?.sessionPctUsed,
    acct2SessionPct: energy?.accounts?.claude_max_2?.sessionPctUsed,
  })

  const collectedText = []
  let newCcSessionId = ccSessionId
  let sawResultMessage = false  // SDK delivered a 'result' terminal message

  // Inactivity timeout: if the SDK produces no messages for 90 seconds, abort.
  // This catches hangs from 429s, network issues, or stuck SDK state.
  // 90s is generous enough for slow tool calls but catches silent hangs quickly.
  const INACTIVITY_TIMEOUT_MS = 90 * 1000
  let _inactivityTimer = null
  let _inactivityAborted = false
  const _resetInactivityTimer = () => {
    if (_inactivityTimer) clearTimeout(_inactivityTimer)
    _inactivityTimer = setTimeout(() => {
      logger.error('OS Session: inactivity timeout (90s no messages) — aborting query', {
        currentProvider: _currentProvider,
      })
      _inactivityAborted = true
      if (activeQuery) {
        try { activeQuery.close() } catch {}
        activeQuery = null
      }
    }, INACTIVITY_TIMEOUT_MS)
  }

  try {
    logger.info('OS Session: calling queryFn...', { promptLength: promptWithMemory.length })
    const q = queryFn({ prompt: promptWithMemory, options })
    activeQuery = q
    _resetInactivityTimer()

    // Stream all messages from the SDK
    for await (const msg of q) {
      _resetInactivityTimer()  // got a message, reset timeout
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
                const provider = _currentProvider
                const model    = env.OS_SESSION_MODEL || null
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
            sawResultMessage = true
            if (msg.usage) {
              // result.usage is cumulative — use only for the threshold/compaction check,
              // not for logging (individual turns already logged in 'assistant' case above)
              sessionTokenUsage.input  = msg.usage.input_tokens  || sessionTokenUsage.input
              sessionTokenUsage.output = msg.usage.output_tokens || sessionTokenUsage.output
            }

            // Check for rate-limit / usage-exhaustion errors in the result
            // Fallback chain: account1 → account2
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
                const next = _switchAfterExhaustion()
                if (next) {
                  ccSessionId = null
                  activeQuery = null
                  logger.warn(`OS Session ${_currentProvider} exhausted — switching to ${next.provider}`, { reason: next.reason })
                  emitOutput({ type: 'system', content: `⚡ ${_currentProvider} limit hit — switching to ${next.provider}.` })
                  throw { _accountRetry: true, message: content }
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
        if (msgErr._accountRetry) throw msgErr  // let sentinel propagate to outer catch
        logger.debug('OS Session message processing error', { error: msgErr.message })
      }
    }

    // Session complete — clear inactivity timer and refresh real usage %
    if (_inactivityTimer) clearTimeout(_inactivityTimer)
    activeQuery = null

    // If the loop ended due to inactivity timeout (not a normal completion),
    // treat it as a hang and try switching accounts
    if (_inactivityAborted) {
      const next = _switchAfterExhaustion()
      if (next) {
        ccSessionId = null
        logger.warn(`OS Session: inactivity timeout — switching from ${_currentProvider} to ${next.provider}`)
        emitOutput({ type: 'system', content: `⚡ ${_currentProvider} appears hung — switching to ${next.provider}.` })
        return sendMessage(content)
      }
      // All providers exhausted — report error
      logger.error('OS Session: inactivity timeout, no alternative providers available')
      emitOutput({ type: 'error', content: 'Session timed out — no response received. All providers may be exhausted.' })
      emitStatus('error', { error: 'inactivity_timeout' })
      broadcast('os-session:complete', { sessionId: dbSessionId, code: 1 })
      await updateOSSession(dbSessionId, { ccCliSessionId: ccSessionId, status: 'error' })
      return { sessionId: dbSessionId, ccCliSessionId: ccSessionId, code: 1, text: 'Error: inactivity timeout' }
    }

    // Silent failure detection — the SDK can exit the for-await loop cleanly
    // without ever delivering a 'result' message OR any text. Most common cause
    // on this VPS: claude CLI exits with code 1 due to a 401, taking the SDK's
    // pipe down with it. The SDK emits an empty/missing terminal frame, our loop
    // exits, and the user sees "(processing...)" forever.
    //
    // Detect that case and (a) try to recover via validate-mode token refresh,
    // (b) if recovery fails, surface a real error to the frontend.
    if (!sawResultMessage && collectedText.length === 0 && !opts._silentRetried) {
      logger.warn('OS Session: SDK loop ended with no result and no text — checking auth', {
        provider: _currentProvider,
      })
      const refreshed = await _tryTokenRefresh('validate')
      if (refreshed) {
        ccSessionId = null  // force fresh CC session against new token
        return sendMessage(content, { ...opts, _silentRetried: true })
      }
      // Auth was fine (or refresh failed) — this is a real failure, not a success.
      const message = 'Session ended without delivering a response. The CC subprocess may have crashed (check pm2 logs for "claude CLI exit 1") or the model returned nothing.'
      logger.error('OS Session: silent failure not recoverable', { provider: _currentProvider })
      emitOutput({ type: 'error', content: message })
      emitStatus('error', { error: 'silent_failure', detail: message })
      broadcast('os-session:complete', { sessionId: dbSessionId, code: 1 })
      await updateOSSession(dbSessionId, { ccCliSessionId: ccSessionId, status: 'error' })
      return { sessionId: dbSessionId, ccCliSessionId: ccSessionId, code: 1, text: `Error: ${message}` }
    }

    await updateOSSession(dbSessionId, { ccCliSessionId: ccSessionId, status: 'complete' })
    if (!suppressOutput) {
      emitStatus('complete', { sessionId: dbSessionId, code: 0 })
      broadcast('os-session:complete', { sessionId: dbSessionId, code: 0 })
    }

    // Quota check fires in background for both accounts — updates energy state from real headers
    usageEnergy.refreshAllAccounts()
      .then(() => usageEnergy.getEnergy())
      .then(energy => { if (!suppressOutput) broadcast('os-session:energy', energy) })
      .catch(() => {})

    // Ingest current session transcript into persistent memory (fire-and-forget, recent files only)
    // Full backlog scan runs in the codebase index worker cycle.
    sessionMemory.ingestProjectDir(undefined, { recentHours: 2 })
      .catch(err => logger.debug('Session memory ingest skipped', { error: err.message }))

    const totalTokens = sessionTokenUsage.input + sessionTokenUsage.output
    logger.info('OS Session exchange complete', { sessionId: dbSessionId, ccSessionId, totalTokens })

    // Auto-handover: when conversation exceeds threshold, generate a handover brief
    // and start a fresh session. Prevents unbounded context growth which multiplies
    // token cost on every subsequent turn (resume re-sends full history).
    const handoverThreshold = parseInt(env.OS_SESSION_COMPACT_THRESHOLD || '250000', 10)
    if (totalTokens > handoverThreshold && !suppressOutput) {
      logger.info('OS Session: triggering auto-handover', { totalTokens, threshold: handoverThreshold })
      autoHandover().catch(err => logger.error('Auto-handover failed', { error: err.message }))
    }

    return {
      sessionId: dbSessionId,
      ccCliSessionId: ccSessionId,
      code: 0,
      text: collectedText.join('\n\n'),
    }

  } catch (err) {
    if (_inactivityTimer) clearTimeout(_inactivityTimer)
    activeQuery = null

    // Sentinel from the result handler — flags already set, just retry
    if (err._accountRetry) {
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

    // Auth failure — try token refresh before giving up or switching providers.
    // Two paths: (a) explicit auth signal in errMsg → force refresh,
    //            (b) suspect silent CLI exit → live-validate first, refresh only if dead.
    if (!opts._authRefreshed) {
      const explicit = _isAuthFailure(errMsg)
      const suspect = !explicit && _isSuspectSilentFailure({
        collectedText, errMsg, hadResultMessage: sawResultMessage,
      })
      if (explicit || suspect) {
        const refreshed = await _tryTokenRefresh(explicit ? 'force' : 'validate')
        if (refreshed) {
          ccSessionId = null  // fresh session after token refresh
          return sendMessage(content, { ...opts, _authRefreshed: true })
        }
        // Refresh failed — fall through to exhaustion/provider switching logic
      }
    }

    const exhausted = _isUsageExhausted(errMsg)
    logger.warn('OS Session catch block', { errMsg: errMsg.slice(0, 200), exhausted, currentProvider: _currentProvider })

    // On usage exhaustion — smart fallback to next best provider
    if (exhausted) {
      const next = _switchAfterExhaustion()
      if (next) {
        ccSessionId = null
        logger.warn(`OS Session ${_currentProvider} exhausted — switching to ${next.provider}`, { reason: next.reason })
        emitOutput({ type: 'system', content: `⚡ ${_currentProvider} limit hit — switching to ${next.provider}.` })
        return sendMessage(content)
      }
    }

    // All providers exhausted or non-quota error
    logger.error('OS Session SDK error', { error: errMsg, stack: err.stack, currentProvider: _currentProvider })

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
//
// Priority messages (user-initiated from frontend) skip the queue entirely:
// they abort the active query, flush the queue, and send immediately.
// The CC session resumes via session_id so no context is lost.
async function sendMessage(content, opts = {}) {
  if (opts.priority && activeQuery) {
    logger.info('Priority message — aborting active query to deliver immediately')
    try { activeQuery.close() } catch {}
    activeQuery = null
    // Flush the queue — stale system messages shouldn't fire after a user interrupt
    _sendQueue = Promise.resolve()
    // Broadcast that the previous stream was interrupted so frontend can finalize it
    broadcast('os-session:complete', { sessionId: null, code: 0, interrupted: true })
  }

  const promise = _sendQueue.then(() => _sendMessageImpl(content, opts))
  // Always chain even on error so the queue doesn't stall
  _sendQueue = promise.catch(() => {})
  return promise
}

// ── Get current session status ──

async function getStatus() {
  const session = await getOSSession()
  const provider = _currentProvider
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
  _currentProvider = 'claude_max'  // reset — smart selection will re-evaluate on next message
  usageEnergy.setProvider('claude_max')
  // Refresh both accounts so the next message gets fresh data
  usageEnergy.refreshAllAccounts().catch(() => {})
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
    logger.info('OS Session: auto-handover triggered', {
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

// ── Abort — kill the active query immediately ──

async function abort() {
  if (!activeQuery) {
    return { aborted: false, reason: 'no_active_query' }
  }
  try { activeQuery.close() } catch {}
  activeQuery = null

  // Clear the send queue so queued messages don't auto-fire
  _sendQueue = Promise.resolve()

  const session = await getOSSession()
  if (session) {
    await updateOSSession(session.id, { status: 'complete' })
  }

  emitStatus('complete', { sessionId: session?.id, aborted: true })
  broadcast('os-session:complete', { sessionId: session?.id, code: 0, aborted: true })

  logger.info('OS Session aborted by user')
  return { aborted: true }
}

// ─── sendTask — route background AI calls through the OS session ───────────
//
// Every non-user-facing Claude call in the codebase used to spawn its own
// `claude` subprocess via claudeService.callClaude. That meant up to ~15
// concurrent subprocesses across PM2 workers, all sharing one OAuth credential
// file. The SDK's auto-refresh races caused refresh-token rotation collisions
// that invalidated in-flight tokens — the "(processing...)" hangs.
//
// sendTask() routes those calls through the same _sendQueue the user's chat
// uses. Because the queue is serialized, there is at most one `claude`
// subprocess on the VPS at any moment. User messages (priority:true) preempt
// tasks; tasks wait their turn. One brain, no races.
//
// Signature matches what the old claudeService.callClaude returned: a string.
// Callers who parse it as JSON keep working. Callers who just wanted a text
// response keep working. Suppressed output means it doesn't pollute the chat.
//
// Timeout: tasks must complete within TASK_TIMEOUT_MS or we bail. The queue
// itself can't be starved because suppressOutput tasks don't block on user IO.
const TASK_TIMEOUT_MS = 5 * 60 * 1000  // 5 min — generous for a tool-using turn

async function sendTask(prompt, { module: mod = 'background', timeoutMs = TASK_TIMEOUT_MS } = {}) {
  // Tag the prompt so the conductor knows this is a background system task,
  // not user chat. Helps it stay terse and on-topic instead of conversing.
  const wrapped = `[SYSTEM TASK — ${mod}]\n\n${prompt}\n\n[END SYSTEM TASK — respond with the requested content only, no preamble.]`

  let timer = null
  const timeout = new Promise((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`sendTask timed out after ${timeoutMs}ms (module=${mod})`)), timeoutMs)
  })

  try {
    const result = await Promise.race([
      sendMessage(wrapped, { suppressOutput: true }),
      timeout,
    ])
    if (timer) clearTimeout(timer)
    if (!result || typeof result.text !== 'string') {
      throw new Error('sendTask: OS session returned no text')
    }
    return result.text
  } catch (err) {
    if (timer) clearTimeout(timer)
    throw err
  }
}

module.exports = { sendMessage, sendTask, getStatus, restart, getHistory, compact, getTokenUsage, recoverResponse, autoHandover, abort }
