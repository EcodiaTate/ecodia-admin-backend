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
const { broadcast, flushDeltasForTurnComplete, resetSessionSeq } = require('../websocket/wsManager')
const secretSafety = require('./secretSafetyService')
const usageEnergy = require('./usageEnergyService')
const osIncident = require('./osIncidentService')
const sessionMemory = require('./sessionMemoryService')
const osConversationLog = require('./osConversationLog')
const neo4jRetrieval = require('./neo4jRetrieval')

// Fire quota-checks for BOTH accounts on startup to get real usage % immediately.
// Log failure — if both accounts are misconfigured, the first user message fails
// with an opaque error. Knowing this at boot is the difference between 10s
// diagnosis and reading PM2 logs.
usageEnergy.refreshAllAccounts()
  .then(() => usageEnergy.getEnergy())
  .then(e => logger.info('Claude energy on startup', {
    pctUsed: e.pctUsed, level: e.level,
    recommended: e.recommendedProvider, reason: e.providerReason,
    acct1: e.accounts?.claude_max?.pctUsed, acct2: e.accounts?.claude_max_2?.pctUsed,
  }))
  .catch(err => logger.warn('Claude energy startup refresh failed', { error: err.message }))


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
      // Sonnet default = cheap baseline. Conductor can override per call by
      // passing `model: 'opus'` (or 'haiku') to the Agent tool when it judges
      // a specific delegation needs more/less power. Keeping the default low
      // so routine work doesn't silently burn Opus tokens.
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
      // Sonnet default — conductor can override via Agent tool `model` param.
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
      // Sonnet default — conductor can override via Agent tool `model` param.
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
      // Sonnet default — conductor can override via Agent tool `model` param.
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
  // Per-session dedup: tracks injected node keys so the same node isn't
  // surfaced more than once per session. Map<sessionId, Set<nodeKey>>.
  // Cap per session at 100 entries; evict oldest on overflow.
  const _preToolSeenKeys = new Map()

  function _getSeenKeys(sessionId) {
    if (!_preToolSeenKeys.has(sessionId)) {
      _preToolSeenKeys.set(sessionId, [])
    }
    return _preToolSeenKeys.get(sessionId)
  }

  function _recordSeen(sessionId, keys) {
    const seen = _getSeenKeys(sessionId)
    for (const k of keys) {
      seen.push(k)
    }
    // Evict oldest if over cap
    if (seen.length > 100) {
      seen.splice(0, seen.length - 100)
    }
  }

  return {
    PreToolUse: [
      // Context injection before high-leverage tools — runs fusedSearch against
      // Neo4j and surfaces the top 3 relevant Patterns/Decisions/Episodes before
      // the tool call so the model sees them in the tool-result area.
      {
        matcher: 'mcp__factory__start_cc_session|mcp__google-workspace__gmail_send|mcp__google-workspace__gmail_reply|mcp__stripe__create_invoice',
        hooks: [async (input) => {
          try {
            const toolName = input.tool_name || ''
            const toolInput = input.tool_input || {}
            const sessionId = input.session_id || 'default'

            // Derive search query from tool-specific fields
            let query = ''
            if (toolName === 'mcp__factory__start_cc_session') {
              query = `${(toolInput.prompt || '').slice(0, 500)} ${toolInput.codebaseName || ''}`.trim()
            } else if (toolName === 'mcp__google-workspace__gmail_send' || toolName === 'mcp__google-workspace__gmail_reply') {
              query = `${toolInput.to || ''} ${toolInput.subject || ''}`.trim()
            } else if (toolName === 'mcp__stripe__create_invoice') {
              query = `${toolInput.customer_email || toolInput.customer || ''} stripe invoice`.trim()
            }

            if (!query) return {}

            const results = await Promise.race([
              neo4jRetrieval.fusedSearch(query, { limit: 3, labels: ['Pattern', 'Decision', 'Episode'] }),
              new Promise((_, reject) => setTimeout(() => reject(new Error('PreToolUse hook timeout')), 4000)),
            ])

            if (!results || results.length === 0) return {}

            // Filter already-seen nodes for this session
            const seen = _getSeenKeys(sessionId)
            const seenSet = new Set(seen)
            const fresh = results.filter(r => {
              const key = `${r.label || r.labels?.[0] || ''}|${r.name || ''}`
              return !seenSet.has(key)
            })

            if (fresh.length === 0) return {}

            // Record injected keys
            _recordSeen(sessionId, fresh.map(r => `${r.label || r.labels?.[0] || ''}|${r.name || ''}`))

            // Format context block
            const lines = fresh.map((r, i) => {
              const label = r.label || (Array.isArray(r.labels) ? r.labels[0] : '') || 'Node'
              const name = r.name || '(unnamed)'
              const desc = (r.description || r.content || '').slice(0, 180)
              return `${i + 1}. [${label}] ${name}${desc ? ` - ${desc}...` : ''}`
            })

            const additionalContext = `<retrieval>\nRelevant Patterns/Decisions/Episodes for this tool call (Neo4j fusedSearch):\n${lines.join('\n')}\n</retrieval>`

            return {
              hookSpecificOutput: {
                hookEventName: 'PreToolUse',
                additionalContext,
              },
            }
          } catch (err) {
            logger.warn('PreToolUse hook: retrieval failed (non-blocking)', { error: err.message })
            return {}
          }
        }],
        timeout: 4,
      },
    ],

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
let activeAbort = null          // AbortController for the running query (enables SDK-level cancellation)
let activeQuerySuppressed = false  // true when the current query was started via sendTask / suppressOutput
let abortGraceTimer = null      // 30s backstop: process.exit(1) if turn stays hung after abort
let _abortInProgress = false    // true from abort until the for-await loop naturally exits
let ccSessionId = null          // CC's internal session_id (for resume)
let sessionTokenUsage = { input: 0, output: 0 }
let _currentProvider = 'claude_max'  // tracks which provider the current session is using

// Message queue — prevents concurrent sendMessage calls from racing and clobbering
// each other's queries. Each sendMessage waits for the previous one to finish.
let _sendQueue = Promise.resolve()

// Tracks whether the SDK is currently performing a compaction (context rotation).
// Set to true on compact_boundary start, false on end or next assistant/result message.
let isCompacting = false

// Consecutive-failure tracking. At 3 in a row, auto-restart ecodia-api (Tate's
// direction Apr 21 2026: "instead of just texting/emailing me that 3 consecutive
// calls to the chat have failed ... It should just automatically run pm2 restart
// ecodia-api"). PM2 will bring us back up, and alertProcessRestart fires after
// the fact so Tate sees the event in email/SMS.
//
// Cooldown: 15m between auto-restarts via kv_store to prevent crash loops if
// something is persistently broken (PM2 also has its own max_restarts guard).
let _consecutiveFailures = 0
const AUTO_RESTART_COOLDOWN_MS = 15 * 60 * 1000

async function _shouldAutoRestart() {
  try {
    const row = await db`SELECT value FROM kv_store WHERE key = 'auto_restart_last_at'`
    if (!row.length) return true
    const v = row[0].value
    let lastAt = 0
    if (typeof v === 'string') {
      try {
        const parsed = JSON.parse(v)
        if (parsed && typeof parsed === 'object' && Number.isFinite(parsed.ts)) lastAt = parsed.ts
        else if (Number.isFinite(Number(parsed))) lastAt = Number(parsed)
      } catch {
        const n = Number(v)
        if (Number.isFinite(n)) lastAt = n
      }
    } else if (typeof v === 'object' && v !== null && Number.isFinite(v.ts)) {
      lastAt = v.ts
    }
    return (Date.now() - lastAt) >= AUTO_RESTART_COOLDOWN_MS
  } catch {
    return true
  }
}

async function _markAutoRestart(reason) {
  try {
    const payload = JSON.stringify({ ts: Date.now(), reason: reason || 'consecutive_failures' })
    await db`
      INSERT INTO kv_store (key, value)
      VALUES ('auto_restart_last_at', ${payload})
      ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()
    `
  } catch (err) {
    logger.warn('auto-restart: failed to record cooldown', { error: err.message })
  }
}

function _recordTurnOutcome(ok, errorMsg) {
  if (ok) {
    _consecutiveFailures = 0
    return
  }
  _consecutiveFailures += 1
  if (_consecutiveFailures >= 3) {
    // Fire-and-forget async restart; caller returns immediately.
    ;(async () => {
      try {
        const allowed = await _shouldAutoRestart()
        if (!allowed) {
          logger.warn('auto-restart: suppressed by cooldown', {
            consecutiveFailures: _consecutiveFailures,
            cooldownMs: AUTO_RESTART_COOLDOWN_MS,
          })
          // Still email/SMS as fallback so Tate knows we're stuck
          try {
            const alerting = require('./osAlertingService')
            alerting.alertConsecutiveFailures(_consecutiveFailures, errorMsg).catch(() => {})
          } catch {}
          return
        }
        logger.error('auto-restart: 3+ consecutive turn failures, restarting ecodia-api', {
          consecutiveFailures: _consecutiveFailures,
          lastError: errorMsg,
        })
        // Log incident BEFORE restart so we have a trail.
        try {
          await require('./osIncidentService').log({
            kind: 'auto_restart',
            severity: 'warning',
            component: 'os_session',
            message: `Auto pm2 restart after ${_consecutiveFailures} consecutive turn failures`,
            context: { consecutiveFailures: _consecutiveFailures, lastError: errorMsg },
          })
        } catch {}
        await _markAutoRestart(errorMsg)
        // Exec pm2 restart. Detached so the restart signal survives our own death.
        const { exec } = require('child_process')
        exec('pm2 restart ecodia-api', { timeout: 10000 }, (err, stdout, stderr) => {
          if (err) {
            logger.error('auto-restart: pm2 restart failed', {
              error: err.message, stderr: (stderr || '').slice(0, 500),
            })
          } else {
            logger.info('auto-restart: pm2 restart ecodia-api issued', {
              stdout: (stdout || '').slice(0, 200),
            })
          }
        })
      } catch (e) {
        logger.error('auto-restart: unexpected failure', { error: e.message })
      }
    })()
  }
}

// Detect usage exhaustion / rate limit errors from any error string
// Detect REAL exhaustion, not casual mentions. The old implementation matched
// bare "quota" / "weekly" / "resets " substrings which tripped on almost any
// assistant-generated text mentioning those words (e.g. "let me check the
// weekly report" or "quota analysis"). That false-positived into Bedrock
// fallback on healthy accounts.
//
// Strict matcher: require either an explicit HTTP status (429), an official
// Anthropic error code, or a full exhaustion phrase. Single-word matches
// like "quota" alone are NOT sufficient.
function _isUsageExhausted(text) {
  const t = (text || '').toLowerCase()
  // HTTP 429 always = exhaustion
  if (/\b429\b/.test(t)) return true
  // Official Anthropic error codes in their exact shape
  if (t.includes('rate_limit_error') || t.includes('rate limit exceeded') ||
      t.includes('too many requests')) return true
  // Claude Max-specific exhaustion phrases (full sentences, not single words)
  if (t.includes('out of extra usage') ||
      t.includes('out of usage') ||
      t.includes('weekly limit reached') ||
      t.includes('usage limit reached') ||
      t.includes('weekly quota exceeded') ||
      t.includes('monthly quota exceeded')) return true
  // SDK-surfaced overload from Anthropic's capacity layer
  if ((t.includes('overloaded') && t.includes('anthropic')) ||
      t.includes('overloaded_error')) return true
  return false
}

// Detect auth failures that a token refresh might fix.
// The Claude CLI is annoying about this — sometimes the message is rich
// ("Failed to authenticate. API Error: 401 ..."), sometimes it's just
// "claude CLI exit 1: " with empty stderr. We treat any empty/cryptic
// CLI exit as *suspect* — the caller will then live-validate the token
// to confirm before paying for a full refresh round-trip.
function _DEAD_isAuthFailure(text) {
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
function _DEAD_isSuspectSilentFailure({ collectedText, errMsg, hadResultMessage }) {
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
async function _DEAD_tryTokenRefresh(mode = 'force') {
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
  const from = _currentProvider
  // Mark current provider as rejected so getBestProvider skips it
  usageEnergy.markAccountRejected(_currentProvider, 'exhaustion_detected')
  // Re-probe to see what's available
  const best = usageEnergy.getBestProvider()
  if (best.provider === _currentProvider) {
    // getBestProvider returned the same one (best-effort) — no real alternative
    return null
  }
  osIncident.log({
    kind: 'provider_switch',
    severity: best.isBedrockFallback ? 'error' : 'warn',
    component: from,
    message: `switched ${from} -> ${best.provider}`,
    context: { from, to: best.provider, reason: best.reason, isBedrockFallback: !!best.isBedrockFallback },
  })
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
  // Pinnacle P1: reset WS seq counter so the frontend can detect a new event stream.
  resetSessionSeq()
  return row
}

// Retry DB writes up to 3x with 200/400/800ms backoff, but ONLY for
// transient (connection-class) failures. The postgres.js pool recycles
// at max_lifetime=30min; a turn that spans a recycle can fail on the
// closed connection even though the pool will open a fresh one next call.
// Unique-violations / syntax errors / permission denied are NOT transient
// and retrying them wastes 1.4s before the permanent failure surfaces.
function _isTransientDbError(err) {
  if (!err) return false
  const code = err.code || ''
  // Node-level network errors
  if (['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'ENETRESET', 'ENOTFOUND', 'EPIPE'].includes(code)) return true
  // postgres.js surfaces its own codes for these
  if (['CONNECTION_CLOSED', 'CONNECTION_ENDED', 'CONNECTION_DESTROYED', 'NOT_TAGGED_CALL'].includes(code)) return true
  // Postgres SQLSTATE classes for connection failures (class 08)
  if (typeof code === 'string' && code.startsWith('08')) return true
  // Message fallback — postgres.js sometimes surfaces errors without a code
  const msg = (err.message || '').toLowerCase()
  if (msg.includes('connection') && (msg.includes('closed') || msg.includes('terminated') || msg.includes('reset'))) return true
  return false
}

async function _dbRetry(label, fn) {
  const delays = [200, 400, 800]
  let lastErr
  for (let i = 0; i <= delays.length; i++) {
    try {
      return await fn()
    } catch (err) {
      lastErr = err
      // Fast-fail on non-transient errors (unique violation, syntax, permission)
      // — retry can never succeed, only delays the inevitable.
      if (!_isTransientDbError(err)) {
        logger.warn(`DB write failed (non-transient, not retrying)`, { label, code: err.code, error: err.message })
        throw err
      }
      if (i < delays.length) {
        logger.warn(`DB write retry ${i + 1}/${delays.length}`, { label, code: err.code, error: err.message })
        await new Promise(r => setTimeout(r, delays[i]))
      }
    }
  }
  logger.error(`DB write permanently failed after retries`, { label, error: lastErr?.message })
  throw lastErr
}

async function updateOSSession(sessionId, updates) {
  const { ccCliSessionId, status } = updates
  if (ccCliSessionId) {
    await _dbRetry('updateOSSession.ccSessionId', () =>
      db`UPDATE cc_sessions SET cc_cli_session_id = ${ccCliSessionId}, status = ${status || 'complete'} WHERE id = ${sessionId}`
    )
  } else if (status) {
    await _dbRetry('updateOSSession.status', () =>
      db`UPDATE cc_sessions SET status = ${status} WHERE id = ${sessionId}`
    )
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
  try { broadcast('os-session:output', { data }) } catch (err) { logger.warn('osSession: broadcast failed (non-fatal)', { error: err.message }) }
}

function emitStatus(status, meta = {}) {
  try { broadcast('os-session:status', { status, ...meta }) } catch (err) { logger.warn('osSession: broadcast failed (non-fatal)', { error: err.message }) }
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
//
// opts._retryDepth — bounded recursion guard. Incremented on every automatic
// retry path (stale session, account switch, inactivity timeout). Hard cap
// of MAX_RETRY_DEPTH prevents the stack-overflow recursion bomb we used to
// have when a hang on the fallback provider triggered another fallback.
const MAX_RETRY_DEPTH = 2

// ── Relevant memory injection ──────────────────────────────────────────────
// Searches Neo4j for Pattern/Decision/Episode nodes semantically similar to
// the current user message + last assistant reply. Returns a formatted
// <relevant_memory> block, or null if nothing clears the threshold.
//
// Hard 2s timeout - if Neo4j is slow or unavailable the user turn proceeds
// unblocked. Fail-open on all errors.

async function _injectRelevantMemory(userMessage, lastAssistantTail) {
  if (env.OS_MEMORY_INJECTION_ENABLED === 'false') return null

  try {
    // Build query: tail-biased concat of last assistant reply + user message
    const combined = [lastAssistantTail, userMessage]
      .filter(Boolean)
      .join('\n')
    const queryText = combined.length > 800
      ? combined.slice(combined.length - 800)
      : combined
    if (!queryText.trim()) return null

    // 2s hard cap - never block the user turn on retrieval
    const t0 = Date.now()
    const useFused = env.OS_MEMORY_FUSED_ENABLED !== 'false'
    const useNeighborhood = env.OS_MEMORY_NEIGHBORHOOD_ENABLED !== 'false'
    let searchFn
    let searchOpts
    if (useFused) {
      searchFn = neo4jRetrieval.fusedSearch
      searchOpts = { limit: 5 }
    } else if (useNeighborhood) {
      searchFn = neo4jRetrieval.semanticSearchWithNeighborhood
      searchOpts = { limit: 3 }
    } else {
      searchFn = neo4jRetrieval.semanticSearch
      searchOpts = { limit: 3 }
    }
    const results = await Promise.race([
      searchFn(queryText, searchOpts),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('neo4j retrieval timeout')), 2000)
      ),
    ])

    logger.info('OS Session: relevant memory', {
      query_len: queryText.length,
      hits: results ? results.length : 0,
      top_score: results && results[0] ? results[0].score ?? null : null,
      fused: useFused,
      neighborhood: useNeighborhood,
      elapsed_ms: Date.now() - t0,
    })

    if (!results || results.length === 0) return null

    const lines = results.map((r, i) => {
      const desc = r.description ? `: ${r.description.replace(/\s+/g, ' ').trim()}` : ''
      const sig = r.signals
        ? ` (sig: v=${r.signals.vector != null ? r.signals.vector.toFixed(2) : '-'}, k=${r.signals.keyword ?? '-'})`
        : ''
      const head = `${i + 1}. [${r.label}] ${r.name}${sig}${desc}`
      if (!r.neighbours || r.neighbours.length === 0) return head
      const edges = r.neighbours.map(n => {
        const nDesc = n.description ? `: ${n.description.replace(/\s+/g, ' ').trim()}` : ''
        return `   -> ${n.rel_type} [${n.label}] ${n.name}${nDesc}`
      })
      return [head, ...edges].join('\n')
    })

    return `<relevant_memory>\n${lines.join('\n')}\n</relevant_memory>`
  } catch (err) {
    logger.warn('OS Session: relevant memory injection failed (skipping)', { error: err.message })
    return null
  }
}

// Injects <recent_doctrine> block: the most recent high-priority Decisions /
// Episodes / Patterns. Unlike _injectRelevantMemory this is UNQUERIED - it
// surfaces recent doctrine regardless of whether the current turn matches it
// semantically. This fixes the class of failure where a Decision written
// minutes ago never surfaces on the next turn because the user phrasing is
// colloquial and vector similarity is low.
//
// Hard 2s timeout. Fail-open - returns null on any error.
async function _injectRecentDoctrine() {
  if (env.OS_RECENT_DOCTRINE_ENABLED === 'false') return null
  try {
    const t0 = Date.now()
    const results = await Promise.race([
      neo4jRetrieval.getRecentHighPriorityNodes({ days: 14, limit: 5 }),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('neo4j doctrine timeout')), 2000)
      ),
    ])
    logger.info('OS Session: recent doctrine', {
      hits: results ? results.length : 0,
      elapsed_ms: Date.now() - t0,
    })
    if (!results || results.length === 0) return null
    const lines = results.map((r, i) => {
      const when = r.date ? r.date.slice(0, 10) : ''
      const prio = r.priority ? ` [${r.priority}]` : ''
      const desc = r.description ? `: ${r.description.replace(/\s+/g, ' ').trim().slice(0, 280)}` : ''
      return `${i + 1}. ${when} ${r.label}${prio} ${r.name}${desc}`
    })
    return `<recent_doctrine>\n${lines.join('\n')}\n</recent_doctrine>`
  } catch (err) {
    logger.warn('OS Session: recent doctrine injection failed (skipping)', { error: err.message })
    return null
  }
}

async function _sendMessageImpl(content, opts = {}) {
  const { suppressOutput = false } = opts
  const retryDepth = opts._retryDepth || 0
  const queryFn = await getQuery()

  // Kill any active query — SDK query() is one-shot, so each message needs a new call.
  // Session continuity is maintained via options.resume + ccSessionId.
  _abortActiveQuery('new_turn_starting')

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

    // Emit current energy level so frontend knows if thinking mode is active.
    // FIRE-AND-FORGET — must never block turn startup. Production incident
    // 2026-04-23: an Anthropic headers probe inside getEnergy() stalled
    // indefinitely and froze the whole OS between the "streaming" status emit
    // and the first logger.info("OS Session starting") line, so the UI saw
    // only a thinking pulse and the backend produced zero further logs until
    // restart. Energy is advisory telemetry; the turn must proceed regardless.
    usageEnergy.getEnergy()
      .then(energyNow => { try { broadcast('os-session:energy', energyNow) } catch {} })
      .catch(err => logger.debug('OS Session: energy emit failed (non-fatal)', { error: err.message }))
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

  // Energy level is still tracked for logging + provider routing, but no longer
  // gates thinking — the conductor thinks on every turn now (see thinking block
  // below). Provider routing still honours energy (Bedrock fallback when both
  // Max accounts are exhausted).
  let energy = null
  try { energy = await usageEnergy.getEnergy() } catch {}
  const energyLevel = energy?.level || 'healthy'

  // Build the custom system prompt (cached per-cwd). This replaces the SDK's
  // default ~5-6k-token scaffolding entirely — see buildCustomSystemPrompt docs.
  //
  // IMPORTANT: keep this STABLE across turns. The SDK's prompt cache keys on
  // the system prompt — a single byte of churn busts the cache and we re-pay
  // the full system-prompt cost every turn. Any per-turn addendum (like the
  // restart recovery block below) goes into the USER message instead, where
  // it's expected to vary.
  const customSystemPrompt = buildCustomSystemPrompt(cwd)

  // Load restart recovery block; we'll stitch it into the user message
  // further down instead of prepending to system prompt (was a cache-buster).
  let recoveryBlock = null
  try {
    const { readHandoffState } = require('./sessionHandoff')
    recoveryBlock = await readHandoffState()
  } catch (err) {
    logger.warn('Failed to read handoff state', { error: err.message })
  }

  // Load last-turn breadcrumb. Two purposes:
  //   1. Fresh-session display: stitch "where I left off" into the user message
  //      when SDK resume isn't available (!ccSessionId).
  //   2. Memory query context: assistant_tail feeds into Neo4j memory injection
  //      regardless of resume state (so retrieval is always contextualised).
  let breadcrumbBlock = null
  let _lastAssistantTail = ''  // used by memory injection below
  try {
    const rows = await db`SELECT value FROM kv_store WHERE key = 'session.last_breadcrumb'`
    const raw = rows?.[0]?.value
    // Tolerate both JSONB (object) and TEXT (JSON string) column types --
    // the live DB has been observed as both depending on migration history.
    let b = null
    if (raw && typeof raw === 'object') b = raw
    else if (typeof raw === 'string') { try { b = JSON.parse(raw) } catch {} }
    if (b && Number.isFinite(b.ts)) {
      // Capture assistant tail for memory injection (no age gate - recent context is useful)
      if (b.assistant_tail) _lastAssistantTail = b.assistant_tail

      // Only surface the display block for fresh sessions and if reasonably recent (12h).
      // Stale breadcrumbs create more confusion than continuity.
      if (!ccSessionId) {
        const ageMin = Math.round((Date.now() - b.ts) / 60000)
        if (ageMin < 12 * 60) {
          breadcrumbBlock = [
            `Last turn ended ${ageMin} min ago on provider ${b.provider || 'unknown'}.`,
            b.user_tail ? `Tate last said: ${b.user_tail}` : '',
            b.assistant_tail ? `You last replied: ${b.assistant_tail}` : '',
          ].filter(Boolean).join('\n')
        }
      }
    }
  } catch (err) {
    logger.debug('Breadcrumb read failed (non-fatal)', { error: err.message })
  }

  // Rich recent-exchange block — the real continuity fix.
  //
  // When ccSessionId is missing (PM2 restart / provider switch / stale retry)
  // SDK resume isn't available. The tiny breadcrumb above carries ~600 chars of
  // each side's last line, which is enough for "am I back online" acknowledgement
  // but loses the NUANCE of the last several exchanges — the thing Tate described
  // as "ruins the flow".
  //
  // Solution: on a fresh session with an existing DB row, pull the last ~15
  // [USER]/assistant turns from cc_session_logs and inject them as a real
  // transcript tail. ~8-15KB of genuine conversation instead of 1.5KB of
  // sentence-tails. The OS rehydrates into the actual conversation, not a
  // summary of it.
  //
  // Only runs when (a) we have a DB session row (not a cold start) and (b) we
  // don't have a live ccSessionId (resume path is not active). Skipped entirely
  // on resume to avoid double-context.
  let recentExchangeBlock = null
  if (!ccSessionId && session?.id) {
    try {
      const RECENT_CHARS_BUDGET = 12_000   // ~3k tokens, generous but bounded
      const RECENT_ROW_LIMIT = 40          // enough for ~15-20 turn pairs
      const rows = await db`
        SELECT content, created_at FROM cc_session_logs
        WHERE session_id = ${session.id}
        ORDER BY created_at DESC
        LIMIT ${RECENT_ROW_LIMIT}
      `
      if (rows?.length) {
        // Rows are newest-first from the query. Walk newest→oldest, pushing
        // into a buffer, stop when we hit the char budget. Then reverse so
        // the model reads them in chronological order.
        const picked = []
        let used = 0
        for (const r of rows) {
          const c = r.content || ''
          if (!c) continue
          const isUser = c.startsWith('[USER] ')
          const role = isUser ? 'Tate' : 'You'
          const body = isUser ? c.slice(7) : c
          const chunk = `${role}: ${body}`
          if (used + chunk.length + 2 > RECENT_CHARS_BUDGET) break
          picked.push(chunk)
          used += chunk.length + 2
        }
        if (picked.length) {
          // Reverse for chronological display and note if we truncated.
          const chronological = picked.reverse()
          if (rows.length > picked.length) {
            chronological.unshift('… (earlier exchanges omitted to fit budget)')
          }
          recentExchangeBlock = chronological.join('\n\n')
        }
      }
    } catch (err) {
      logger.debug('Recent-exchange block read failed (non-fatal)', { error: err.message })
    }
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
    // Extended thinking — unconditional, maximum budget. Tate's directive:
    // the conductor should be the absolute smartest it can be on every turn.
    // Previous energy-gated tiers (5k/10k/off) were trading quality for weekly
    // budget; weekly-budget pressure is now handled upstream via account
    // routing + Bedrock fallback, so there's no reason to throttle reasoning.
    // 10k was empirically the right ceiling before — keeping it as the cap to
    // avoid eating into the response budget on turns that need long output.
    thinking: {
      type: 'enabled',
      budget_tokens: 10000,
    },
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
    // Bedrock fallback — use ANTHROPIC_API_KEY with Bedrock model.
    // Alert ONLY if a Max account was genuinely near cap — otherwise this is
    // a false fallback (e.g. `_isUsageExhausted` mis-matched on stray text,
    // or the quota-check hasn't run yet and both accounts look unknown).
    // Gate: at least one Max account must have weeklyUtilization >= 0.85,
    // OR be explicitly rejected by the API. Without that signal, Bedrock
    // fallback is likely spurious and we log-only instead of emailing.
    if (prevProvider !== 'bedrock') {
      let energySnap = null
      try { energySnap = await usageEnergy.getEnergy() } catch {}
      const acct1 = energySnap?.accounts?.claude_max
      const acct2 = energySnap?.accounts?.claude_max_2
      const trulyExhausted = (acct1?.pctUsed >= 0.85) || (acct2?.pctUsed >= 0.85) ||
        acct1?.rateLimitStatus === 'rejected' || acct2?.rateLimitStatus === 'rejected'
      if (trulyExhausted) {
        try {
          const alerting = require('./osAlertingService')
          alerting.alertBedrockFallback(best.reason).catch(() => {})
        } catch {}
      } else {
        logger.warn('Bedrock fallback triggered but no account is near-exhausted — likely spurious, NOT alerting', {
          reason: best.reason,
          acct1PctUsed: acct1?.pctUsed,
          acct2PctUsed: acct2?.pctUsed,
        })
      }
    }
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
    options.model = env.BEDROCK_MODEL || 'us.anthropic.claude-sonnet-4-6'
    delete options.resume
    emitOutput({ type: 'system', content: `⚡ Both Claude Max accounts exhausted — falling back to Bedrock (${options.model}).` })
  } else if (best.provider === 'claude_max_2') {
    _currentProvider = 'claude_max_2'
    if (prevProvider !== 'claude_max_2') {
      ccSessionId = null  // can't resume across config dirs
    }
    const sessionEnv = { ...process.env }
    // CRITICAL: strip ANTHROPIC_API_KEY on OAuth paths. If present, the CLI/SDK
    // silently prefers it over OAuth and bills the API wallet instead of Claude Max.
    delete sessionEnv.ANTHROPIC_API_KEY
    // Prefer long-lived CLAUDE_CODE_OAUTH_TOKEN_CODE (from `claude setup-token`).
    // Falls back to CLAUDE_CONFIG_DIR_2-based credentials for legacy compat.
    if (env.CLAUDE_CODE_OAUTH_TOKEN_CODE) {
      sessionEnv.CLAUDE_CODE_OAUTH_TOKEN = env.CLAUDE_CODE_OAUTH_TOKEN_CODE
      delete sessionEnv.CLAUDE_CONFIG_DIR
    } else if (env.CLAUDE_CONFIG_DIR_2) {
      sessionEnv.CLAUDE_CONFIG_DIR = env.CLAUDE_CONFIG_DIR_2
    }
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
    delete sessionEnv.ANTHROPIC_API_KEY
    // Prefer long-lived CLAUDE_CODE_OAUTH_TOKEN_TATE (from `claude setup-token`).
    if (env.CLAUDE_CODE_OAUTH_TOKEN_TATE) {
      sessionEnv.CLAUDE_CODE_OAUTH_TOKEN = env.CLAUDE_CODE_OAUTH_TOKEN_TATE
      delete sessionEnv.CLAUDE_CONFIG_DIR
    } else if (env.CLAUDE_CONFIG_DIR_1) {
      sessionEnv.CLAUDE_CONFIG_DIR = env.CLAUDE_CONFIG_DIR_1
    }
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

  // Pinnacle P1 - per-turn event fidelity tracking
  let _assistantTurnStarted = false    // emitted assistant_message_starting this turn?
  let _currentToolUseBlock = null      // { id, name, inputChunks[] } while streaming tool_use
  let _turnModel = null                // model from system.init, for turn_complete telemetry
  let _lastTurnInputTokens = 0         // set from result.usage.input_tokens; used for compact threshold
  let _compactBoundaryTimer = null     // 60s safety timeout for stuck compact_boundary start

  // ─── Per-tool watchdog ─────────────────────────────────────────────────
  // An MCP server can crash mid-tool-call (stdio pipe breaks, process dies,
  // remote API hangs). When that happens the SDK sits waiting for a
  // tool_result that will never arrive — the inactivity timer doesn't fire
  // because the SDK is still receiving its own internal heartbeats.
  //
  // Track every tool_use id we see in assistant messages; clear on matching
  // tool_result. If a tool sits outstanding past PER_TOOL_TIMEOUT_MS, treat
  // it as a hung MCP and abort the whole query — the outer retry / account-
  // switch logic then takes over.
  const PER_TOOL_TIMEOUT_MS = 60 * 1000
  const _toolStartedAt = new Map()    // tool_use_id -> Date.now()
  let _toolWatchdog = null
  let _toolWatchdogAborted = false
  const _scheduleToolWatchdog = () => {
    if (_toolWatchdog) clearTimeout(_toolWatchdog)
    // Find the oldest outstanding tool. If it's older than the timeout,
    // fire immediately; otherwise schedule for the remaining time.
    if (_toolStartedAt.size === 0) return
    const now = Date.now()
    let oldest = Infinity
    let oldestId = null
    for (const [id, info] of _toolStartedAt) {
      const startedAt = typeof info === 'number' ? info : info.startedAt
      if (startedAt < oldest) { oldest = startedAt; oldestId = id }
    }
    const age = now - oldest
    const remaining = Math.max(0, PER_TOOL_TIMEOUT_MS - age)
    _toolWatchdog = setTimeout(() => {
      const ageSec = Math.round((Date.now() - oldest) / 1000)
      logger.error('OS Session: tool watchdog fired — tool outstanding past timeout, aborting query', {
        tool_use_id: oldestId, ageSec, outstanding: _toolStartedAt.size,
      })
      _toolWatchdogAborted = true
      _abortActiveQuery('tool_watchdog')
    }, remaining)
  }
  const _markToolStarted = (id, name) => {
    if (!id) return
    // Store as object so the liveness heartbeat can surface the tool name
    // currently running, not just its id. Watchdog still reads startedAt.
    _toolStartedAt.set(id, { startedAt: Date.now(), name: name || null })
    _scheduleToolWatchdog()
  }
  const _markToolCompleted = (id) => {
    if (!id) return
    _toolStartedAt.delete(id)
    _scheduleToolWatchdog()
  }

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
      _abortActiveQuery('inactivity_timeout')
    }, INACTIVITY_TIMEOUT_MS)
  }

  // ─── Liveness heartbeat (5s tick while the turn is in flight) ──────────
  // The frontend expects `os-session:status` with status='live' every 5s so
  // it can render "thinking — Ns" or "running tool X — Ns" instead of a
  // silent spinner during long tool chains. Without this, the UI goes quiet
  // for 30-60s stretches and feels dead even when the OS is working hard.
  let _livenessTimer = null
  let _livenessInitialTimer = null
  let _livenessTurnStartedAt = null
  const _livenessTick = () => {
    if (!_livenessTurnStartedAt) return
    const elapsedSec = Math.round((Date.now() - _livenessTurnStartedAt) / 1000)
    // If a tool is outstanding, surface the oldest one + its age.
    let phase = 'thinking'
    let detail = null
    if (_toolStartedAt.size > 0) {
      phase = 'tool'
      let oldest = Infinity
      let oldestId = null
      let oldestName = null
      for (const [id, info] of _toolStartedAt) {
        const startedAt = typeof info === 'number' ? info : info.startedAt
        if (startedAt < oldest) {
          oldest = startedAt
          oldestId = id
          oldestName = typeof info === 'object' ? info.name : null
        }
      }
      detail = {
        name: oldestName || 'tool',
        runningSec: Math.round((Date.now() - oldest) / 1000),
        outstanding: _toolStartedAt.size,
      }
      // name is opportunistic — _toolStartedAt may not have it for pre-P1 paths.
      if (!oldestName) detail.name = oldestId || 'tool'
    }
    if (!suppressOutput) {
      try {
        broadcast('os-session:status', {
          status: 'live',
          phase,
          elapsedSec,
          detail,
          sessionId: dbSessionId,
        })
      } catch (err) { logger.warn('osSession: broadcast failed (non-fatal)', { error: err.message }) }
    }
  }
  const _startLiveness = () => {
    if (_livenessTimer || _livenessInitialTimer) return
    _livenessTurnStartedAt = Date.now()
    // First tick at ~2s so the UI gets a signal quickly after send, then 5s cadence.
    // Tracked so _stopLiveness can cancel the initial delay if the turn ends
    // before it fires — otherwise the setInterval gets armed for a dead turn.
    _livenessInitialTimer = setTimeout(() => {
      _livenessInitialTimer = null
      if (!_livenessTurnStartedAt) return
      _livenessTick()
      _livenessTimer = setInterval(_livenessTick, 5000)
    }, 2000)
  }
  const _stopLiveness = () => {
    if (_livenessInitialTimer) { clearTimeout(_livenessInitialTimer); _livenessInitialTimer = null }
    if (_livenessTimer) { clearInterval(_livenessTimer); _livenessTimer = null }
    _livenessTurnStartedAt = null
  }

  // Stitch continuity blocks into the USER message (not the system prompt)
  // so the SDK's prompt cache stays stable across turns. Blocks are small,
  // tagged so the model treats them as context (not user intent), and only
  // included when they carry real signal (fresh session / recent handoff).
  let finalPrompt = promptWithMemory
  const continuityParts = []
  // Current-moment injection. Varies per turn (cache-safe - lives in user msg)
  // Fixes temporal blindness from only having a date-only system prompt stamp.
  const _nowAEST = new Date().toLocaleString('en-AU', {
    timeZone: 'Australia/Brisbane',
    weekday: 'short',
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  })
  continuityParts.push(`<now>${_nowAEST} AEST</now>`)

  // Relevant Neo4j memory injection. Runs in parallel with the rest of setup.
  // Searches Pattern/Decision/Episode nodes semantically similar to the current
  // turn. Block goes between <now> and <restart_recovery> so it reads as
  // "current context" before any session recovery state.
  //
  // TIMEOUT-WRAPPED — a paused/unavailable Neo4j Aura instance would otherwise
  // hang the entire turn at the `await _memoryBlockPromise` below. 2026-04-23
  // incident: Aura paused (free tier), every turn stalled indefinitely with no
  // logs because the memory lookup never resolved. 5s hard cap → fall through
  // to null → turn proceeds with no memory context rather than wedging.
  const _withTimeout = (p, ms, label) => Promise.race([
    p,
    new Promise(resolve => setTimeout(() => {
      logger.warn(`OS Session: ${label} timed out after ${ms}ms — proceeding without it (Neo4j health?)`)
      resolve(null)
    }, ms)),
  ])
  const _memoryBlockPromise = _withTimeout(
    _injectRelevantMemory(content, _lastAssistantTail).catch(() => null),
    5000,
    'memory injection',
  )
  const _doctrineBlockPromise = _withTimeout(
    _injectRecentDoctrine().catch(() => null),
    5000,
    'doctrine injection',
  )

  if (recoveryBlock) {
    continuityParts.push(`<restart_recovery>\n${recoveryBlock}\n</restart_recovery>`)
  }
  // Recent exchange block takes precedence over the tiny breadcrumb — it's the
  // same signal at much higher fidelity. Ship both only in the degenerate case
  // where we have a breadcrumb but no session row (shouldn't normally happen).
  if (recentExchangeBlock) {
    continuityParts.push(`<recent_exchanges>\nBelow is the tail of the conversation before this session restarted. Pick up naturally — do NOT summarise or acknowledge the gap. Just continue as if nothing happened.\n\n${recentExchangeBlock}\n</recent_exchanges>`)
  } else if (breadcrumbBlock) {
    continuityParts.push(`<last_turn_breadcrumb>\n${breadcrumbBlock}\n</last_turn_breadcrumb>`)
  }

  // Await memory + doctrine results and splice after <now>, before restart_recovery
  // Order: <now> (idx 0), <recent_doctrine>, <relevant_memory>, <restart_recovery>, <recent_exchanges>
  // Splice in reverse so the later insertions push earlier ones down correctly.
  // Log failures at debug — these fail silently on Neo4j flakiness and the
  // turn proceeds without injected context, but we want a breadcrumb for
  // "why was the OS responding without its usual memory" post-hoc analysis.
  let _memoryBlock = null
  let _doctrineBlock = null
  try { _memoryBlock = await _memoryBlockPromise } catch (err) {
    logger.debug('OS Session: memory injection failed', { error: err.message })
  }
  try { _doctrineBlock = await _doctrineBlockPromise } catch (err) {
    logger.debug('OS Session: doctrine injection failed', { error: err.message })
  }
  if (_memoryBlock) {
    continuityParts.splice(1, 0, _memoryBlock)
  }
  if (_doctrineBlock) {
    continuityParts.splice(1, 0, _doctrineBlock)
  }

  if (continuityParts.length > 0) {
    finalPrompt = `${continuityParts.join('\n\n')}\n\n${promptWithMemory}`
    logger.info('OS Session: stitching continuity blocks into user message', {
      now: true,
      recent_doctrine: !!_doctrineBlock,
      memory: !!_memoryBlock,
      restart_recovery: !!recoveryBlock,
      recent_exchanges: !!recentExchangeBlock,
      breadcrumb: !!breadcrumbBlock,
      totalBlocksLen: continuityParts.join('\n\n').length,
    })
  }

  try {
    logger.info('OS Session: calling queryFn...', { promptLength: finalPrompt.length, suppressOutput, recovery: !!recoveryBlock })
    const turnAbort = new AbortController()
    options.abortController = turnAbort
    const q = queryFn({ prompt: finalPrompt, options })
    activeQuery = q
    activeAbort = turnAbort
    const _turnStartedAt = Date.now()  // for turn_complete duration_ms
    activeQuerySuppressed = suppressOutput
    _resetInactivityTimer()
    _startLiveness()

    let _turnNo = 0
    try {
      const next = await osConversationLog.getNextTurnNumber(dbSessionId)
      if (typeof next === 'number') _turnNo = next
    } catch (e) {
      logger.debug('osConversationLog.getNextTurnNumber failed, defaulting to 0', { err: e.message })
    }
    // Log the user turn once up front. finalPrompt already contains the effective user text for this query.
    try {
      await osConversationLog.logTurn({
        ccSessionId: dbSessionId,
        turnNumber: _turnNo++,
        role: 'user',
        content: finalPrompt,
        contentJson: null,
        tokenCount: null,
      })
    } catch (e) {
      logger.debug('osConversationLog.logTurn(user) failed', { err: e.message })
    }

    // Stream all messages from the SDK
    for await (const msg of q) {
      _resetInactivityTimer()  // got a message, reset timeout
      try {
        // Log raw message type for debugging
        logger.debug('OS Session SDK message', { type: msg.type, subtype: msg.subtype })

        switch (msg.type) {
          // ─── System init — capture session_id + log actual model ─
          case 'system': {
            if (msg.subtype === 'init') {
              // SDK reports the real model it locked in (including SDK default
              // when OS_SESSION_MODEL was unset). This is the ground truth.
              _turnModel = msg.model || null  // captured for turn_complete telemetry
              logger.info('OS Session SDK init', {
                model: msg.model || '(unknown)',
                requestedModel: options.model || '(default)',
                provider: _currentProvider,
                session_id: msg.session_id,
                tools: Array.isArray(msg.tools) ? msg.tools.length : null,
              })
              if (msg.session_id) {
                newCcSessionId = msg.session_id
                if (newCcSessionId !== ccSessionId) {
                  ccSessionId = newCcSessionId
                  await updateOSSession(dbSessionId, { ccCliSessionId: ccSessionId, status: 'running' })
                }
              }
            } else if (!suppressOutput && msg.subtype) {
              // Forward other system events (session_resumed, session_recovered, etc.)
              // as inline banners so the frontend can surface them.
              broadcast('os-session:output', { data: { type: 'session_event', subtype: msg.subtype } })
            }
            break
          }

          // ─── User message — contains tool_result blocks after tool calls ─
          case 'user': {
            const content = msg.message?.content
            if (!Array.isArray(content)) break
            for (const block of content) {
              if (block.type === 'tool_result') {
                // Clear the watchdog for this tool_use_id — it completed.
                _markToolCompleted(block.tool_use_id)
                try {
                  await osConversationLog.logTurn({
                    ccSessionId: dbSessionId,
                    turnNumber: _turnNo++,
                    role: 'tool_result',
                    content: null,
                    contentJson: { tool_use_id: block.tool_use_id, content: block.content ?? null },
                    tokenCount: null,
                  })
                } catch (e) {
                  logger.debug('osConversationLog.logTurn(tool_result) failed', { err: e.message })
                }
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
                  // Pinnacle P1: also emit typed tool_use_result or tool_use_error
                  // so the frontend can distinguish success from failure without
                  // parsing the content string.
                  if (block.is_error) {
                    emitOutput({
                      type: 'tool_use_error',
                      tool_use_id: block.tool_use_id,
                      content: resultText || '(no output)',
                    })
                  } else {
                    emitOutput({
                      type: 'tool_use_result',
                      tool_use_id: block.tool_use_id,
                      content: resultText || '(no output)',
                    })
                  }
                }
              }
            }
            break
          }

          // ─── Full assistant message — extract text, broadcast ─
          case 'assistant': {
            // If compaction was in-flight and we received the next assistant turn,
            // treat that as an implicit compaction-end signal (singular boundary case).
            if (isCompacting) {
              isCompacting = false
              if (!suppressOutput) emitStatus('streaming', { sessionId: dbSessionId })
            }

            const blocks = msg.message?.content || []

            if (!suppressOutput) {
              // Broadcast thinking blocks for the frontend reasoning display
              const thinkingBlocks = blocks.filter(b => b.type === 'thinking' && b.thinking)
              for (const tb of thinkingBlocks) {
                emitOutput({ type: 'thinking', content: tb.thinking })
              }
            }

            const text = extractTextFromContent(blocks)
            let safeText = null
            if (text) {
              safeText = secretSafety.scrubSecrets(text)
              collectedText.push(safeText)
              await appendLog(dbSessionId, safeText)
              // Broadcast the full assistant text for the frontend
              if (!suppressOutput) emitOutput({ type: 'assistant_text', content: safeText })
            }

            // Track tool_use starts for the per-tool watchdog, regardless
            // of suppressOutput — we still want to protect against MCP hangs
            // on background turns.
            const toolUses = blocks.filter(b => b.type === 'tool_use')
            for (const t of toolUses) _markToolStarted(t.id, t.name)

            if (!suppressOutput) {
              // Also broadcast tool_use blocks so frontend knows about tool calls
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
              // Live token usage broadcast — surfaces context-fill progress in the UI
              // so Tate can see the session approaching the compact threshold rather
              // than being surprised by a silent handover. Fire-and-forget; don't care
              // if the broadcast fails.
              if (!suppressOutput) {
                try {
                  const handoverThreshold = parseInt(env.OS_SESSION_COMPACT_THRESHOLD || '800000', 10)
                  const total = sessionTokenUsage.input + sessionTokenUsage.output
                  // Also surface the "context size" signal — for resumed sessions the
                  // SDK's per-turn input_tokens is roughly how much context we're
                  // sending each turn, i.e. effective session size.
                  broadcast('os-session:tokens', {
                    input: sessionTokenUsage.input,
                    output: sessionTokenUsage.output,
                    total,
                    turnInput,
                    threshold: handoverThreshold,
                    needsCompaction: turnInput > handoverThreshold * 0.95,
                    pctOfThreshold: Math.min(100, Math.round((turnInput / handoverThreshold) * 100)),
                  })
                } catch {}
              }
            }
            try {
              if (safeText && safeText.trim()) {
                await osConversationLog.logTurn({
                  ccSessionId: dbSessionId,
                  turnNumber: _turnNo++,
                  role: 'assistant',
                  content: safeText,
                  contentJson: null,
                  tokenCount: null,
                })
              }
              for (const tu of toolUses) {
                await osConversationLog.logTurn({
                  ccSessionId: dbSessionId,
                  turnNumber: _turnNo++,
                  role: 'tool_use',
                  content: null,
                  contentJson: { id: tu.id, name: tu.name, input: tu.input ?? null },
                  tokenCount: null,
                })
              }
            } catch (e) {
              logger.debug('osConversationLog.logTurn(assistant/tool_use) failed', { err: e.message })
            }
            break
          }

          // ─── Streaming partial — real-time text + thinking deltas + tool lifecycle ──
          // Pinnacle P1: emits full event fidelity (assistant_message_starting,
          // tool_use_starting, tool_use_input_complete) from streaming events
          // before the full assistant message arrives.
          case 'stream_event': {
            const event = msg.event
            if (!event) break

            if (event.type === 'message_start') {
              // New assistant message starting - emit banner before first text_delta
              // so the frontend can show a "thinking" indicator immediately.
              _assistantTurnStarted = true
              if (!suppressOutput) {
                emitOutput({ type: 'assistant_message_starting', ccSessionId: dbSessionId })
              }
            } else if (event.type === 'content_block_start') {
              const block = event.content_block
              if (block?.type === 'tool_use') {
                // Tool use starting - name is known but input not yet finalized
                _currentToolUseBlock = { id: block.id, name: block.name, inputChunks: [] }
                // Start tracking now (not on full assistant message) so the
                // liveness heartbeat can surface the tool name while it runs.
                _markToolStarted(block.id, block.name)
                if (!suppressOutput) {
                  emitOutput({ type: 'tool_use_starting', id: block.id, name: block.name })
                }
              }
            } else if (event.type === 'content_block_delta' && event.delta) {
              if (event.delta.type === 'text_delta' && event.delta.text) {
                const safeText = secretSafety.scrubSecrets(event.delta.text)
                if (!suppressOutput) emitOutput({ type: 'text_delta', content: safeText })
              } else if (event.delta.type === 'thinking_delta' && event.delta.thinking) {
                // Real-time thinking stream - shown in collapsible panel
                if (!suppressOutput) emitOutput({ type: 'thinking_delta', content: event.delta.thinking })
              } else if (event.delta.type === 'input_json_delta' && _currentToolUseBlock) {
                // Accumulate streaming tool input chunks
                _currentToolUseBlock.inputChunks.push(event.delta.partial_json || '')
              }
            } else if (event.type === 'content_block_stop') {
              if (_currentToolUseBlock) {
                // Tool input fully assembled - emit tool_use_input_complete
                const inputStr = _currentToolUseBlock.inputChunks.join('')
                let parsedInput = null
                try { parsedInput = JSON.parse(inputStr) } catch {}
                if (!suppressOutput) {
                  emitOutput({
                    type: 'tool_use_input_complete',
                    id: _currentToolUseBlock.id,
                    name: _currentToolUseBlock.name,
                    input: parsedInput !== null ? parsedInput : inputStr,
                  })
                }
                _currentToolUseBlock = null
              }
            }
            break
          }

          // ─── Result — session complete, capture final usage ───
          case 'result': {
            sawResultMessage = true
            // Compaction must be done by the time a result arrives.
            if (isCompacting) {
              isCompacting = false
              if (!suppressOutput) emitStatus('streaming', { sessionId: dbSessionId })
            }
            if (msg.usage) {
              // For resumed sessions, result.usage.input_tokens reflects the full
              // context the SDK is sending each turn (resume history + this turn).
              // That's effectively the "context-window fill" signal we want for
              // the compaction threshold. Capture it for the post-turn check.
              //
              // We deliberately do NOT overwrite sessionTokenUsage here — that
              // double-accounted against the `assistant` event accumulation and
              // made the cumulative total reflect only the latest turn, which is
              // why the 800k compact threshold never actually fired historically.
              _lastTurnInputTokens = msg.usage.input_tokens || 0
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
                osIncident.log({
                  kind: 'context_reset',
                  severity: 'warn',
                  component: 'os_session',
                  message: 'stale resume ID in result — CC CLI lost the session, restarting fresh',
                  context: { trigger: 'stale_retry_in_result', staleCcSessionId: ccSessionId },
                })
                ccSessionId = null
                activeQuery = null
                activeAbort = null
                await db`UPDATE cc_sessions SET cc_cli_session_id = NULL WHERE id = ${dbSessionId}`.catch(() => {})
                throw { _staleRetry: true, message: content }
              }

              if (_isUsageExhausted(errTexts)) {
                const next = _switchAfterExhaustion()
                if (next) {
                  ccSessionId = null
                  activeQuery = null
                  activeAbort = null
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
            // Pinnacle P1: flush coalescer then emit turn_complete with full telemetry.
            // Must happen after token broadcast so seq ordering is: tokens -> turn_complete.
            if (!suppressOutput) {
              flushDeltasForTurnComplete()
              broadcast('os-session:output', {
                data: {
                  type: 'turn_complete',
                  input_tokens: msg.usage?.input_tokens ?? sessionTokenUsage.input,
                  output_tokens: msg.usage?.output_tokens ?? sessionTokenUsage.output,
                  cache_read_tokens: msg.usage?.cache_read_input_tokens ?? 0,
                  cache_write_tokens: msg.usage?.cache_creation_input_tokens ?? 0,
                  model: _turnModel || env.OS_SESSION_MODEL || 'unknown',
                  stop_reason: msg.stop_reason || null,
                  duration_ms: Date.now() - _turnStartedAt,
                },
              })
            }
            break
          }

          case 'compact_boundary': {
            // SDK emits compact_boundary during context compaction (summarisation + rotation).
            // Log full payload on first receipt so we can see the shape in production logs.
            logger.info('OS Session: compact_boundary received', { msg: JSON.stringify(msg).slice(0, 500) })

            // compact_boundary events may come as a start/end pair or as a single marker.
            // The `boundary_type` field (if present) distinguishes them. We treat:
            //   start (or undefined) -> compaction underway
            //   end                  -> compaction finished
            const boundaryType = msg.boundary_type || msg.type_detail || null
            if (boundaryType === 'end') {
              if (_compactBoundaryTimer) { clearTimeout(_compactBoundaryTimer); _compactBoundaryTimer = null }
              if (isCompacting) {
                isCompacting = false
                if (!suppressOutput) {
                  emitStatus('streaming', { sessionId: dbSessionId })
                  broadcast('os-session:output', { data: { type: 'compact_boundary', phase: 'end' } })
                }
              }
            } else {
              // start or unknown single marker - begin compacting
              if (!isCompacting) {
                isCompacting = true
                if (!suppressOutput) {
                  emitStatus('compacting', { sessionId: dbSessionId })
                  broadcast('os-session:output', { data: { type: 'compact_boundary', phase: 'start' } })
                }
                // Pinnacle P1: 60s safety timeout - if compact_boundary end never arrives,
                // emit a synthetic end so the frontend doesn't stay stuck in compacting state.
                if (_compactBoundaryTimer) clearTimeout(_compactBoundaryTimer)
                _compactBoundaryTimer = setTimeout(() => {
                  _compactBoundaryTimer = null
                  if (isCompacting) {
                    logger.warn('OS Session: compact_boundary end never arrived - emitting synthetic end')
                    isCompacting = false
                    if (!suppressOutput) {
                      emitStatus('streaming', { sessionId: dbSessionId })
                      broadcast('os-session:output', { data: { type: 'compact_boundary', phase: 'end', synthetic: true } })
                    }
                  }
                }, 60_000)
              }
            }
            break
          }

          default:
            // Pinnacle P1: forward unknown SDK event types so the frontend can
            // observe new event shapes without a backend deploy.
            if (!suppressOutput && msg.type) {
              broadcast('os-session:output', {
                data: { type: 'sdk_event_unknown', event_type: msg.type },
              })
            }
            break
        }
      } catch (msgErr) {
        if (msgErr._accountRetry) throw msgErr  // let sentinel propagate to outer catch
        logger.debug('OS Session message processing error', { error: msgErr.message })
      }
    }

    // Session complete — clear timers and refresh real usage %
    if (_inactivityTimer) clearTimeout(_inactivityTimer)
    if (_toolWatchdog) clearTimeout(_toolWatchdog)
    if (_compactBoundaryTimer) { clearTimeout(_compactBoundaryTimer); _compactBoundaryTimer = null }
    _stopLiveness()
    activeQuery = null
    activeAbort = null
    _abortInProgress = false
    if (abortGraceTimer) { clearTimeout(abortGraceTimer); abortGraceTimer = null }
    // If we exited the SDK loop while isCompacting was still true (the compact
    // boundary 'end' never arrived but the stream ended anyway), the next turn
    // would emitStatus('compacting') as its opening signal. Reset here.
    if (isCompacting) isCompacting = false

    // If the loop ended due to inactivity timeout or a hung tool call,
    // treat it as a hang and try switching accounts. Direct-call
    // _sendMessageImpl (NOT sendMessage) — we're already inside the
    // serialized queue, so going through the queue again would deadlock.
    // Depth-guarded to prevent the recursion bomb.
    if (_inactivityAborted || _toolWatchdogAborted) {
      const hangReason = _toolWatchdogAborted ? 'tool_watchdog' : 'inactivity_timeout'

      // IMPORTANT distinction: a hang is NOT the same as a rate-limit.
      // A hung MCP tool or a silent SDK means the current PROVIDER is fine;
      // something downstream is stuck. Previously we called
      // _switchAfterExhaustion() here, which marked the provider rejected
      // and flipped us to Bedrock — that's how a neo4j outage could end up
      // burning AWS $ on a 35%-quota Max account.
      //
      // New policy: a hang retries on the SAME provider (fresh session_id)
      // up to MAX_RETRY_DEPTH. Only a real rate-limit / exhaustion signal
      // (caught by _isUsageExhausted in the result handler) triggers a
      // provider switch.
      if (retryDepth < MAX_RETRY_DEPTH) {
        ccSessionId = null  // can't resume a dead session; start fresh
        logger.warn(`OS Session: ${hangReason} — retrying on same provider ${_currentProvider}`, { retryDepth })
        emitOutput({ type: 'system', content: `⚡ Retrying (${hangReason})…` })
        return _sendMessageImpl(content, { ...opts, _retryDepth: retryDepth + 1 })
      }
      logger.error(`OS Session: ${hangReason} at max retry depth — surfacing error`, { retryDepth, provider: _currentProvider })
      osIncident.log({
        kind: _toolWatchdogAborted ? 'tool_hung' : 'turn_failure',
        severity: 'error',
        component: 'os_session',
        message: `${hangReason} after ${MAX_RETRY_DEPTH} retries`,
        context: { provider: _currentProvider, retryDepth, sessionId: dbSessionId },
      })
      if (!suppressOutput) {
        emitOutput({ type: 'error', content: `Session hung (${hangReason}) after ${MAX_RETRY_DEPTH} retries. Check MCP servers.` })
        emitStatus('error', { error: hangReason })
        broadcast('os-session:complete', { sessionId: dbSessionId, code: 1 })
      }
      await updateOSSession(dbSessionId, { ccCliSessionId: ccSessionId, status: 'error' })
      _recordTurnOutcome(false, hangReason)
      return { sessionId: dbSessionId, ccCliSessionId: ccSessionId, code: 1, text: `Error: ${hangReason}` }
    }

    // If the SDK for-await loop ended with no result and no text, retry ONCE
    // on a fresh session_id. Most "empty stream" cases are stale ccSessionId
    // where the CC CLI no longer has the session on disk — same-provider
    // retry with null resume fixes it. If it still empty-streams on the
    // retry, that's a real CLI / auth issue; surface it.
    if (!sawResultMessage && collectedText.length === 0) {
      if (retryDepth < MAX_RETRY_DEPTH && ccSessionId) {
        logger.warn('OS Session: empty SDK stream — retrying with fresh session_id', { retryDepth, provider: _currentProvider })
        osIncident.log({
          kind: 'context_reset',
          severity: 'warn',
          component: 'os_session',
          message: 'empty SDK stream — ccSessionId nulled, retrying fresh',
          context: { trigger: 'empty_stream_retry', provider: _currentProvider, retryDepth },
        })
        ccSessionId = null
        if (session?.id) {
          await db`UPDATE cc_sessions SET cc_cli_session_id = NULL WHERE id = ${session.id}`.catch(() => {})
        }
        return _sendMessageImpl(content, { ...opts, _retryDepth: retryDepth + 1 })
      }
      const message = 'Session ended without delivering a response. Check pm2 logs for "claude CLI exit".'
      logger.error('OS Session: empty SDK stream (post-retry or no resume id)', { provider: _currentProvider, retryDepth })
      osIncident.log({
        kind: 'empty_sdk_stream',
        severity: 'error',
        component: 'os_session',
        message: 'CC CLI exited with no result message',
        context: { provider: _currentProvider, retryDepth, sessionId: dbSessionId },
      })
      if (!suppressOutput) {
        emitOutput({ type: 'error', content: message })
        emitStatus('error', { error: 'empty_stream' })
        broadcast('os-session:complete', { sessionId: dbSessionId, code: 1 })
      }
      await updateOSSession(dbSessionId, { ccCliSessionId: ccSessionId, status: 'error' })
      _recordTurnOutcome(false, 'empty_sdk_stream')
      // Preserve user intent so auto-wake can rehydrate into "you were asked X but the stream died".
      // Without this, an empty_sdk_stream silently vaporises the user's last message and next restart
      // wakes with stale context pointing at whatever exchange succeeded before the failure.
      if (!suppressOutput && !content.startsWith('[HEARTBEAT]') && !content.startsWith('[SCHEDULED:')) {
        try {
          const TAIL_CHARS = 600
          const userTail = content.length > TAIL_CHARS ? '…' + content.slice(-TAIL_CHARS) : content
          const breadcrumbPayload = JSON.stringify({
            ts: Date.now(),
            session_id: dbSessionId,
            cc_session_id: ccSessionId,
            provider: _currentProvider,
            user_tail: userTail,
            assistant_tail: `[empty_sdk_stream — turn failed to produce a response]`,
            tokens: sessionTokenUsage.input + sessionTokenUsage.output,
            failed: true,
          })
          await db`
            INSERT INTO kv_store (key, value)
            VALUES ('session.last_breadcrumb', ${breadcrumbPayload})
            ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()
          `
        } catch (bcErr) {
          logger.warn('failure-path breadcrumb write failed', { error: bcErr.message })
        }
      }
      return { sessionId: dbSessionId, ccCliSessionId: ccSessionId, code: 1, text: `Error: ${message}` }
    }

    await updateOSSession(dbSessionId, { ccCliSessionId: ccSessionId, status: 'complete' })
    _recordTurnOutcome(true)

    // ─── Auto session breadcrumb ─────────────────────────────────────────
    // Write a compact "where I left off" snapshot after real user turns.
    // Lets a fresh session (PM2 restart, provider switch, auto-handover)
    // pick up continuity without re-ingesting the whole transcript.
    //
    // Bounded ~1.5KB (two 600-char tails) so it can't bloat context. We
    // deliberately skip:
    //   - suppressed turns (sendTask / background handover generation)
    //   - heartbeat turns (they'd overwrite real user context with
    //     "nothing pressing" self-replies and destroy continuity)
    //   - scheduled-cron turns (same reasoning)
    // The last genuine user→assistant exchange is what's worth recovering.
    const isHeartbeatTurn = content.startsWith('[HEARTBEAT]')
    const isScheduledTurn = content.startsWith('[SCHEDULED:')
    if (!suppressOutput && !isHeartbeatTurn && !isScheduledTurn) {
      try {
        const lastAssistant = collectedText.join('\n\n')
        const TAIL_CHARS = 600
        const userTail = content.length > TAIL_CHARS ? '…' + content.slice(-TAIL_CHARS) : content
        const asstTail = lastAssistant.length > TAIL_CHARS ? '…' + lastAssistant.slice(-TAIL_CHARS) : lastAssistant
        // JSON.stringify explicitly — the live kv_store has been observed as
        // both TEXT and JSONB on different DB versions. A stringified JSON
        // object works for both (JSONB accepts JSON-string input; TEXT takes
        // it as-is). Passing a bare JS object to TEXT writes "[object Object]".
        const breadcrumbPayload = JSON.stringify({
          ts: Date.now(),
          session_id: dbSessionId,
          cc_session_id: ccSessionId,
          provider: _currentProvider,
          user_tail: userTail,
          assistant_tail: asstTail,
          tokens: sessionTokenUsage.input + sessionTokenUsage.output,
        })
        try {
          await db`
            INSERT INTO kv_store (key, value)
            VALUES ('session.last_breadcrumb', ${breadcrumbPayload})
            ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()
          `
        } catch (dbErr) {
          logger.warn('breadcrumb write failed — next restart will lose context', { error: dbErr.message })
          try {
            const osIncident = require('./osIncidentService')
            osIncident.log({
              kind: 'context_reset',
              severity: 'warn',
              component: 'os_session',
              message: 'breadcrumb write failed — context will not survive restart',
              context: { error: dbErr.message, sessionId: dbSessionId },
            })
          } catch {}
        }
      } catch (err) {
        logger.warn('breadcrumb capture failed', { error: err.message })
      }
    }

    // ─── Auto-handover threshold decision ────────────────────────────
    // Check this BEFORE emitting os-session:complete so the UI can switch
    // straight from "streaming" to "compacting" without a flash of "idle"
    // in between. Prior ordering was: emit complete → UI flips to idle →
    // handover signal → UI flips to compacting. That's the "doesn't tell
    // me it's compacting till after" feel from 2026-04-24.
    //
    // Threshold signal: use last turn's input_tokens (= resumed context
    // size being sent each turn), NOT sessionTokenUsage.input+output
    // which is smaller because it accumulates only output across turns.
    const handoverThreshold = parseInt(env.OS_SESSION_COMPACT_THRESHOLD || '800000', 10)
    const contextFill = _lastTurnInputTokens || 0
    const shouldHandover = contextFill > handoverThreshold && !suppressOutput
    if (shouldHandover) {
      logger.info('OS Session: auto-handover threshold hit — signalling before complete', {
        contextFill, threshold: handoverThreshold,
      })
      // Tell the UI *now*, before os-session:complete flips it to idle.
      broadcast('os-session:handover', {
        phase: 'preparing',
        tokens: contextFill,
        trigger: 'threshold',
      })
      try { emitStatus('handover_preparing', { phase: 'threshold_hit' }) } catch {}
    }

    if (!suppressOutput) {
      emitStatus('complete', { sessionId: dbSessionId, code: 0 })
      broadcast('os-session:complete', { sessionId: dbSessionId, code: 0 })
    }

    // Auto-deliver any pending queued messages now that the turn is done.
    // Fire-and-forget: deliverPending is idempotent (no-op when queue empty)
    // and its sendMessage call goes through _sendQueue, so it waits behind any
    // other in-flight work. Only runs for user-visible turns — background
    // turns (handover brief generation, heartbeats) must not drain the queue
    // since that would trigger mid-handover delivery loops.
    if (!suppressOutput && !shouldHandover) {
      try {
        const mq = require('./messageQueue')
        mq.deliverPending({ summary: null }).catch(err => {
          logger.debug('OS Session: post-turn queue drain failed', { error: err.message })
        })
      } catch (err) {
        logger.debug('OS Session: post-turn queue drain skipped', { error: err.message })
      }
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

    logger.info('OS Session exchange complete', {
      sessionId: dbSessionId, ccSessionId,
      sessionInput: sessionTokenUsage.input, sessionOutput: sessionTokenUsage.output,
      lastTurnInput: contextFill,
    })

    // Actually kick off the handover (async). We already broadcast the signal
    // above so the UI is already in compacting state before this starts.
    if (shouldHandover) {
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
    if (_toolWatchdog) clearTimeout(_toolWatchdog)
    if (_compactBoundaryTimer) { clearTimeout(_compactBoundaryTimer); _compactBoundaryTimer = null }
    _stopLiveness()
    activeQuery = null
    activeAbort = null
    _abortInProgress = false
    if (abortGraceTimer) { clearTimeout(abortGraceTimer); abortGraceTimer = null }
    // Module-level flags can leak here if we threw mid-compaction or mid-handover.
    // Reset them so the next turn isn't stuck thinking a phase is still in flight.
    if (isCompacting) isCompacting = false
    // handoverInProgress is managed by autoHandover()'s own cleanup, but if the
    // exception fires during handover's SDK call, the catch above may not run.

    // ─── _accountRetry sentinel (thrown from result handler at line ~932) ───
    // The result-message handler throws this when it detects usage exhaustion
    // and has already switched provider. Retry the turn on the new provider.
    // Direct-call _sendMessageImpl (NOT sendMessage) — we're inside the queue.
    // Depth-guarded so a repeated-exhaustion cascade can't recurse forever.
    if (err && err._accountRetry) {
      if (retryDepth < MAX_RETRY_DEPTH) {
        logger.info('OS Session: retrying turn on new provider after exhaustion', { retryDepth, newProvider: _currentProvider })
        return _sendMessageImpl(err.message || content, { ...opts, _retryDepth: retryDepth + 1 })
      }
      logger.error('OS Session: account retry at max depth — surfacing error', { retryDepth })
      const message = 'All providers exhausted (max retry depth reached).'
      if (!suppressOutput) {
        emitOutput({ type: 'error', content: message })
        emitStatus('error', { error: 'max_retry_depth' })
        broadcast('os-session:complete', { sessionId: dbSessionId, code: 1 })
      }
      await updateOSSession(dbSessionId, { ccCliSessionId: ccSessionId, status: 'error' })
      _recordTurnOutcome(false, 'max_retry_depth')
      if (!suppressOutput && !content.startsWith('[HEARTBEAT]') && !content.startsWith('[SCHEDULED:')) {
        try {
          const TAIL_CHARS = 600
          const userTail = content.length > TAIL_CHARS ? '…' + content.slice(-TAIL_CHARS) : content
          const breadcrumbPayload = JSON.stringify({
            ts: Date.now(),
            session_id: dbSessionId,
            cc_session_id: ccSessionId,
            provider: _currentProvider,
            user_tail: userTail,
            assistant_tail: `[max_retry_depth — all providers exhausted]`,
            tokens: sessionTokenUsage.input + sessionTokenUsage.output,
            failed: true,
          })
          await db`
            INSERT INTO kv_store (key, value)
            VALUES ('session.last_breadcrumb', ${breadcrumbPayload})
            ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()
          `
        } catch (bcErr) {
          logger.warn('failure-path breadcrumb write failed', { error: bcErr.message })
        }
      }
      return { sessionId: dbSessionId, ccCliSessionId: ccSessionId, code: 1, text: `Error: ${message}` }
    }

    // ─── _staleRetry sentinel (thrown from result handler when SDK reports
    // session-not-found in the result itself — happens after PM2 restart). ───
    if (err && err._staleRetry && !opts._staleCleaned) {
      logger.warn('OS Session: stale resume ID from result — starting fresh')
      return _sendMessageImpl(err.message || content, { ...opts, _staleCleaned: true, _retryDepth: retryDepth + 1 })
    }

    const errMsg = err.message || String(err)

    // Stale resume ID after PM2 restart — CC CLI no longer has the session.
    // Clear our stored ID and retry fresh exactly ONCE. This is cheap, safe,
    // and the only automatic retry we still do. All other failure modes
    // (auth, network, model errors) surface immediately and visibly.
    if (!opts._staleCleaned && retryDepth < MAX_RETRY_DEPTH && (
      errMsg.includes('No conversation found') ||
      (errMsg.includes('session') && errMsg.includes('not found')) ||
      errMsg.includes('Invalid session')
    )) {
      logger.warn('OS Session: stale resume ID — starting fresh', { staleCcSessionId: ccSessionId })
      osIncident.log({
        kind: 'context_reset',
        severity: 'warn',
        component: 'os_session',
        message: 'stale resume ID surfaced as exception — restarting fresh',
        context: { trigger: 'stale_retry_outer_catch', errMsg: errMsg.slice(0, 200) },
      })
      ccSessionId = null
      if (session?.id) {
        await db`UPDATE cc_sessions SET cc_cli_session_id = NULL WHERE id = ${session.id}`.catch(() => {})
      }
      return _sendMessageImpl(content, { ...opts, _staleCleaned: true, _retryDepth: retryDepth + 1 })
    }

    // Everything else: log, surface to frontend, persist error state, return.
    // No silent retries, no auth refresh mid-query (token refresh service
    // handles that proactively on its own timer), no provider swap ping-pong.
    // If the user sees an error they can decide what to do; half our past
    // bugs came from this code trying to self-heal in opaque ways.
    logger.error('OS Session SDK error', { error: errMsg, stack: err.stack })
    osIncident.log({
      kind: 'turn_failure',
      severity: 'error',
      component: 'os_session',
      message: errMsg,
      context: { provider: _currentProvider, retryDepth, sessionId: dbSessionId },
    })

    emitOutput({ type: 'error', content: errMsg })
    emitStatus('error', { error: errMsg })
    broadcast('os-session:complete', { sessionId: dbSessionId, code: 1 })

    await updateOSSession(dbSessionId, { ccCliSessionId: ccSessionId, status: 'error' })
    _recordTurnOutcome(false, errMsg)

    return {
      sessionId: dbSessionId,
      ccCliSessionId: ccSessionId,
      code: 1,
      text: `Error: ${errMsg}`,
    }
  }
}

// Safe swap helper — atomically takes the current activeQuery, nulls the ref,
// then propagates cancellation via AbortController before attempting close().
//
// AbortController.abort() is the primary cancellation path: it propagates into
// the SDK's in-flight built-in tools (WebFetch/undici, Bash subprocesses, MCP
// stdio transports) so they stop rather than pin the process indefinitely.
// close() is belt-and-braces for SDK stream teardown.
//
// After abort, _scheduleAbortGraceTimer arms a 30s backstop: if the turn
// somehow stays hung (syscall blocked, libc DNS lookup, native stream stall),
// the timer calls process.exit(1) so PM2 respawns the process.
function _abortActiveQuery(reason) {
  const q = activeQuery
  const ac = activeAbort
  activeQuery = null
  activeAbort = null
  activeQuerySuppressed = false
  if (ac) {
    // Primary cancellation — propagates into SDK tool runners and undici fetch.
    try { ac.abort(reason || 'aborted') } catch (e) {
      logger.debug('AbortController.abort threw', { reason, error: e?.message })
    }
  }
  if (q) {
    // Belt-and-braces: still call close() for SDK stream teardown.
    Promise.resolve()
      .then(() => q.close())
      .catch(err => logger.debug('activeQuery.close() rejected (ignored)', { reason, error: err?.message }))
  }
  _scheduleAbortGraceTimer(reason)
}

// 30-second process-recycle backstop. If the for-await loop does NOT exit
// naturally within 30s of an abort (e.g. a native syscall is truly wedged),
// call process.exit(1) so PM2 respawns ecodia-api.
//
// Not scheduled for 'new_turn_starting' or 'priority_preempt' — those abort
// one query only to immediately start the next, so lingering in _abortInProgress
// would be wrong. All watchdog/manual aborts DO schedule the timer.
function _scheduleAbortGraceTimer(reason) {
  if (reason === 'new_turn_starting' || reason === 'priority_preempt' || reason === 'compact_deprecated') return
  if (abortGraceTimer) { clearTimeout(abortGraceTimer); abortGraceTimer = null }
  _abortInProgress = true
  abortGraceTimer = setTimeout(() => {
    abortGraceTimer = null
    if (_abortInProgress) {
      logger.error('SDK_ABORT_GRACE_EXPIRED — process exit for PM2 respawn', { reason })
      process.exit(1)
    }
  }, 30 * 1000)
  abortGraceTimer.unref?.()
}

// Hard ceiling on any single turn. If _sendMessageImpl hasn't resolved within
// this window, the global watchdog force-aborts the query, writes a failure
// breadcrumb, emits 'error' status so the frontend unfreezes, and resolves the
// promise so _sendQueue advances. This is the last-resort recovery path — all
// inner timeouts (per-tool 60s, inactivity 90s) should fire first. Only kicks
// in when everything else has failed to notice the hang.
//
// Background turns (heartbeat, scheduled crons, handover brief generation) are
// capped at 8 min because they should never legitimately need that long. User
// turns get 15 min to accommodate genuinely slow thinking + heavy tool chains.
const TURN_WATCHDOG_USER_MS = 15 * 60 * 1000
const TURN_WATCHDOG_BG_MS = 8 * 60 * 1000

async function _sendMessageWithWatchdog(content, opts) {
  const isBackground = !!opts.suppressOutput
  const timeoutMs = isBackground ? TURN_WATCHDOG_BG_MS : TURN_WATCHDOG_USER_MS
  let watchdogFired = false
  let watchdogTimer = null

  const watchdogPromise = new Promise((resolve) => {
    watchdogTimer = setTimeout(() => {
      watchdogFired = true
      logger.error('OS Session: global turn watchdog fired — force-aborting', {
        timeoutMs, isBackground, contentLen: content?.length,
      })
      _abortActiveQuery('turn_watchdog')

      // RESOLVE IMMEDIATELY so the outer Promise.race unblocks and _sendQueue
      // advances — even if the cleanup awaits below hang (e.g., DB contention,
      // logger backpressure). Prior version awaited a DB breadcrumb write
      // BEFORE resolving; when Postgres got contended, the watchdog itself
      // wedged and the queue locked forever (2026-04-23 incident).
      resolve({ sessionId: null, ccCliSessionId: null, code: 1, text: 'Error: turn watchdog timeout', watchdogged: true })

      // Fire-and-forget cleanup — runs in the background, never blocks the
      // queue's forward progress.
      ;(async () => {
        try {
          osIncident.log({
            kind: 'tool_hung',
            severity: 'error',
            component: 'os_session',
            message: `global turn watchdog fired after ${Math.round(timeoutMs / 1000)}s`,
            context: { isBackground, contentLen: content?.length || 0 },
          })
        } catch {}
        if (!isBackground) {
          try {
            emitOutput({ type: 'error', content: `Turn timed out after ${Math.round(timeoutMs / 60000)} min. The OS has been force-reset and will accept new messages.` })
            emitStatus('error', { error: 'turn_watchdog' })
            broadcast('os-session:complete', { sessionId: null, code: 1, watchdogged: true })
          } catch {}
        }
        try {
          const TAIL_CHARS = 600
          const userTail = content && content.length > TAIL_CHARS ? '…' + content.slice(-TAIL_CHARS) : (content || '')
          await db`
            INSERT INTO kv_store (key, value)
            VALUES ('session.last_breadcrumb', ${JSON.stringify({
              ts: Date.now(),
              user_tail: userTail,
              assistant_tail: '[turn_watchdog — global timeout fired, turn force-aborted]',
              provider: _currentProvider,
              failed: true,
            })})
            ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()
          `
        } catch (bcErr) {
          logger.warn('watchdog breadcrumb write failed', { error: bcErr.message })
        }
      })()
    }, timeoutMs)
    watchdogTimer.unref?.()
  })

  try {
    const result = await Promise.race([
      _sendMessageImpl(content, opts),
      watchdogPromise,
    ])
    if (watchdogFired) {
      // Watchdog won the race — _sendMessageImpl may still resolve later.
      // We've already aborted the query; its eventual resolution is a no-op.
      return result
    }
    return result
  } finally {
    if (watchdogTimer) clearTimeout(watchdogTimer)
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
  // One info-level breadcrumb at the door so you always see "a message arrived"
  // in pm2 logs even when the turn later hangs in some deep path. Was missing
  // during the 2026-04-23 hang-without-logs incident.
  logger.info('OS Session sendMessage entry', {
    contentLen: typeof content === 'string' ? content.length : null,
    priority: !!opts.priority,
    suppressOutput: !!opts.suppressOutput,
    activeQuery: !!activeQuery,
    handoverInProgress,
    retryDepth: opts._retryDepth || 0,
  })

  // Input size guard — reject pathologically huge prompts at the door. The
  // SDK technically accepts them but they cause unpredictable tool/CLI
  // behaviour and make debugging "it just froze" nearly impossible. 200KB
  // covers any legitimate paste + generous margin.
  if (typeof content === 'string' && content.length > 200_000) {
    logger.warn('OS Session: oversized message rejected', { length: content.length })
    const err = new Error(`Message too large (${content.length} chars, max 200000). Paste a summary or use a file reference.`)
    err.code = 'MESSAGE_TOO_LARGE'
    throw err
  }

  if (opts.priority && activeQuery) {
    // If the task we're about to kill was a suppressed background task
    // (sendTask), don't broadcast an interrupt to the frontend — the user
    // was never seeing it, so finalising it as an assistant message would
    // leak internal work into the chat. This was the source of the
    // "half-sentences from KG consolidation appear mid-conversation" bug.
    const wasSuppressed = activeQuerySuppressed
    logger.info('Priority message — aborting active query to deliver immediately', { wasSuppressed })
    _abortActiveQuery('priority_preempt')
    // Flush the queue — stale system messages shouldn't fire after a user interrupt
    _sendQueue = Promise.resolve()
    if (!wasSuppressed) {
      // Broadcast interrupt only for user-facing streams, so the frontend
      // can finalise whatever partial content was visible.
      try { broadcast('os-session:complete', { sessionId: null, code: 0, interrupted: true }) } catch (err) { logger.warn('osSession: broadcast failed (non-fatal)', { error: err.message }) }
    }
  }

  // Acknowledge to the frontend when a user-visible message is about to queue behind
  // an in-flight turn (active query running + not priority + not a suppressed internal msg).
  if (activeQuery && !opts.priority && !opts.suppressOutput) {
    emitStatus('queued', { sessionId: null, queuedBehind: isCompacting ? 'compaction' : 'active_query' })
  }

  if (activeQuery && !opts.priority) {
    logger.info('osSession: message queued behind active turn', {
      contentLen: content?.length,
      suppressed: !!opts.suppressOutput,
      queue_depth: isCompacting ? 'compaction' : 'active_query',
    })
  }

  const promise = _sendQueue.then(() => _sendMessageWithWatchdog(content, opts))
  // Always chain even on error so the queue doesn't stall
  _sendQueue = promise.catch(() => {})
  return promise
}

// ── Get current session status ──
//
// Auto-heals zombie sessions: if the DB row says `running` but no activeQuery
// is set in memory (process restarted mid-turn, or watchdog fired but DB was
// contended), mark the row complete so the UI doesn't report a ghost turn
// forever. Runs opportunistically per status call — no dedicated cron needed.
const ZOMBIE_SESSION_MAX_AGE_MS = 20 * 60 * 1000 // 20 min — past the 15-min user watchdog

async function getStatus() {
  const session = await getOSSession()
  const provider = _currentProvider

  // Zombie-session auto-heal: stale `running` row + no in-memory activeQuery.
  if (session && session.status === 'running' && !activeQuery && session.started_at) {
    const ageMs = Date.now() - new Date(session.started_at).getTime()
    if (ageMs > ZOMBIE_SESSION_MAX_AGE_MS) {
      logger.warn('OS Session: zombie session auto-healed (marking complete)', {
        sessionId: session.id,
        ageMs,
        startedAt: session.started_at,
      })
      // Fire-and-forget — never block status reply on a DB write
      updateOSSession(session.id, { status: 'complete' }).catch(err => {
        logger.debug('OS Session: zombie auto-heal DB update failed', { error: err.message })
      })
      // Return the expected post-heal shape so callers don't see the zombie
      return {
        active: false,
        sessionId: session.id,
        ccCliSessionId: session.cc_cli_session_id || null,
        status: 'complete',
        startedAt: session.started_at,
        provider,
      }
    }
  }

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
  _abortActiveQuery('manual_restart')
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
  _abortActiveQuery('compact_deprecated')

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

// Hard ceiling on the entire handover flow. If brief-generation + warmup takes
// longer than this, the handover watchdog force-resets state so the OS can
// accept new messages again. Without this guard, a hung brief call could
// leave handoverInProgress=true forever — next call returns immediately,
// effectively disabling the whole session until PM2 restart.
const HANDOVER_WATCHDOG_MS = 10 * 60 * 1000

async function autoHandover(recentMessages) {
  if (handoverInProgress) {
    logger.warn('autoHandover: already in progress, skipping')
    return
  }
  handoverInProgress = true
  const handoverStartedAt = Date.now()

  // Watchdog: if the whole flow exceeds HANDOVER_WATCHDOG_MS, force-reset.
  // Doesn't interrupt running calls — they'll continue and resolve/error on
  // their own — but ensures the session isn't permanently wedged.
  const handoverWatchdog = setTimeout(() => {
    if (handoverInProgress) {
      logger.error('autoHandover: watchdog fired, force-resetting', {
        elapsedMs: Date.now() - handoverStartedAt,
      })
      try {
        osIncident.log({
          kind: 'context_reset',
          severity: 'error',
          component: 'os_session',
          message: 'handover watchdog fired — force-reset handoverInProgress',
          context: { elapsedMs: Date.now() - handoverStartedAt, trigger: 'handover_watchdog' },
        })
      } catch {}
      handoverInProgress = false
      _abortActiveQuery('handover_watchdog')
      _sendQueue = Promise.resolve()
      try {
        broadcast('os-session:handover', { phase: 'failed', error: 'handover_watchdog_timeout' })
        emitStatus('error', { error: 'handover_watchdog' })
      } catch {}
    }
  }, HANDOVER_WATCHDOG_MS)
  handoverWatchdog.unref?.()

  // Flush any pending queued messages BEFORE starting the handover. Messages
  // that arrive during brief-generation would otherwise fire against the dying
  // session. The user can always re-send; silent mis-delivery is worse.
  _sendQueue = Promise.resolve()

  try {
    const tokensAtHandover = sessionTokenUsage.input + sessionTokenUsage.output
    logger.info('OS Session: auto-handover triggered', { tokens: tokensAtHandover })
    osIncident.log({
      kind: 'context_reset',
      severity: 'warn',
      component: 'os_session',
      message: `auto-handover triggered at ${tokensAtHandover} tokens — ccSessionId nulled, warm brief generated`,
      context: { tokens: tokensAtHandover, trigger: 'auto_handover' },
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
    _abortActiveQuery('handover_prep')
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
    try { broadcast('os-session:handover', { phase: 'failed', error: err.message }) } catch (broadcastErr) { logger.warn('osSession: broadcast failed (non-fatal)', { error: broadcastErr.message }) }
    // Emit a terminal status so the frontend doesn't stay stuck on "handover_warming"
    try {
      emitStatus('error', { error: 'handover_failed' })
      broadcast('os-session:complete', { sessionId: null, code: 1, handoverFailed: true })
    } catch {}
  } finally {
    handoverInProgress = false
    clearTimeout(handoverWatchdog)
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
  _abortActiveQuery('explicit_abort')

  // Clear the send queue so queued messages don't auto-fire
  _sendQueue = Promise.resolve()

  // Clear module-level flags that would otherwise leak into the next turn if
  // the abort fires while the SDK loop is inside a compaction or handover.
  isCompacting = false
  handoverInProgress = false

  const session = await getOSSession()
  if (session) {
    await updateOSSession(session.id, { status: 'complete' })
  }

  // Flush any coalesced text_delta chunks BEFORE emitting the terminal event.
  // Without this, the last 1–10ms of streamed text stays stranded in the
  // coalescer and the frontend ends the turn with a truncated message.
  try { flushDeltasForTurnComplete() } catch {}

  try { emitStatus('complete', { sessionId: session?.id, aborted: true }) } catch (err) { logger.warn('osSession: broadcast failed (non-fatal)', { error: err.message }) }
  try { broadcast('os-session:complete', { sessionId: session?.id, code: 0, aborted: true }) } catch (err) { logger.warn('osSession: broadcast failed (non-fatal)', { error: err.message }) }

  logger.info('OS Session aborted by user')
  return { aborted: true }
}

// Background AI calls no longer route through this service. They go to
// factoryBridge.runBackgroundJob instead, which dispatches to ecodia-factory
// over Redis. The factory process uses a dedicated credentials dir so it
// can never race chat for OAuth. See services/claudeService.js and
// services/deepseekService.js for the call sites.

// Internal introspection for the heartbeat/scheduler to avoid race-conditions
// where they check "busy" then fire while a user message is landing in the queue.
// Returns true if activeQuery OR _sendQueue has anything pending.
function _isQueueBusy() {
  if (activeQuery) return true
  // _sendQueue is always a resolved Promise when idle (after .catch()).
  // We treat handoverInProgress as busy too — anything queuing during a
  // handover would be orphaned by the queue flush.
  if (handoverInProgress) return true
  return false
}

// Test-only hooks — expose abort internals for unit tests without touching production paths.
function _getAbortGraceTimerForTest() { return abortGraceTimer }
function _isAbortInProgressForTest() { return _abortInProgress }
function _setActiveAbortForTest(ac) { activeAbort = ac }
function _setActiveQueryForTest(q) { activeQuery = q }
function _resetAbortStateForTest() { activeAbort = null; activeQuery = null; _abortInProgress = false; if (abortGraceTimer) { clearTimeout(abortGraceTimer); abortGraceTimer = null } }

module.exports = { sendMessage, getStatus, restart, getHistory, compact, getTokenUsage, recoverResponse, autoHandover, abort, _isQueueBusy, _abortActiveQuery, _getAbortGraceTimerForTest, _isAbortInProgressForTest, _setActiveAbortForTest, _setActiveQueryForTest, _resetAbortStateForTest }
