/**
 * Fork Service — true parallel sub-sessions of the EcodiaOS conductor.
 *
 * Implements EcodiaOS_Spec_NextBuild Build 1 (Fork-Mode Parallelism).
 *
 * Architecture
 * ────────────
 * The main OS (osSessionService) stays a single-threaded conductor with its
 * own _sendQueue. Forks are *additive*: each is a fresh SDK query() with a
 * separate AbortController, separate ccSessionId, separate provider env. They
 * run on independent Promise chains so 3 forks + main = 4 truly concurrent
 * SDK streams. The conductor never sees a fork's raw stream — it only sees a
 * rolled-up positions table when it asks (or when forks finish and post a
 * [FORK_REPORT] back into main's inbox via the queue).
 *
 * Why a separate file
 * ───────────────────
 * Putting forks inside osSessionService.js would mean either (a) coupling
 * fork lifecycle to the singleton activeQuery/ _sendQueue (kills parallelism),
 * or (b) duplicating ~600 lines of MCP/provider/streaming logic across two
 * code paths inside one file. A separate service with its own minimal stream
 * loop keeps the conductor untouched and the fork loop small.
 *
 * Fork tool scoping (spec §1.4)
 * ─────────────────────────────
 *  - Forks DO get: neo4j, scheduler, factory, supabase + Agent (subagent
 *    delegation: comms/finance/ops/social).
 *  - Forks DO NOT get: any os-session lifecycle (restart, compact, handover) —
 *    that's main's job. We achieve this by simply not exposing those tools to
 *    the fork (fork's MCP server set is identical to conductor's; the os-
 *    session admin endpoints are HTTP-only and forks have no HTTP client).
 *
 * Persistence (os_forks table, migration 062)
 * ───────────────────────────────────────────
 *  - In-memory Map is the runtime source of truth.
 *  - DB row is for visibility (frontend GET /forks), the conductor rollup
 *    (forksRollup() reads it cheaply), and post-mortem if a fork dies.
 *  - DB writes are fire-and-forget — a slow DB never blocks fork progress.
 */
'use strict'

const crypto = require('crypto')
const fs = require('fs')
const path = require('path')
const db = require('../config/db')
const env = require('../config/env')
const logger = require('../config/logger')
const usageEnergy = require('./usageEnergyService')
const { broadcast } = require('../websocket/wsManager')
const secretSafety = require('./secretSafetyService')

// ── SDK loader (shared shape with osSessionService) ─────────────────────────
let _query = null
async function getQuery() {
  if (_queryOverride) return _queryOverride
  if (!_query) {
    const sdk = await import('@anthropic-ai/claude-agent-sdk')
    _query = sdk.query
  }
  return _query
}
// Test seam — set via _setQueryForTest to inject a fake query() generator so
// parallelism / lifecycle can be verified without burning real Anthropic
// tokens. NEVER set this in production code paths.
let _queryOverride = null

// ── Caps (raised 2026-04-27 — Tate's directive: conductor self-spawns up to 5) ─
// Hard cap is the absolute concurrency ceiling. Energy soft caps step down
// proportionally as the weekly budget tightens — at "low" we still allow 2
// forks so the conductor isn't single-threaded just because we're past 70%.
const HARD_FORK_CAP = 5
const ENERGY_FORK_CAPS = {
  full:     5,
  healthy:  5,
  conserve: 4,
  low:      2,
  critical: 0,
}

// Conductor & subagent MCP groups — duplicated from osSessionService so a
// refactor there doesn't silently change fork behaviour. Kept narrow on
// purpose: forks should match the conductor's tool surface (minus session
// lifecycle), not balloon their own.
const FORK_CONDUCTOR_SERVERS = ['neo4j', 'scheduler', 'factory', 'supabase']
const FORK_SUBAGENT_DOMAINS = {
  comms:   ['google-workspace', 'crm', 'sms'],
  finance: ['bookkeeping', 'supabase'],
  ops:     ['vps', 'supabase'],
  social:  ['business-tools'],
}

// ── In-memory registry ───────────────────────────────────────────────────────
// Map<fork_id, ForkState>. Live state: never recovered after process restart.
const _forks = new Map()

function _newForkId() {
  return `fork_${Date.now().toString(36)}_${crypto.randomBytes(3).toString('hex')}`
}

function _forkSnapshot(state) {
  return {
    fork_id:        state.fork_id,
    parent_id:      state.parent_id,
    brief:          state.brief,
    context_mode:   state.context_mode,
    status:         state.status,
    position:       state.position,
    result:         state.result,
    next_step:      state.next_step,
    provider:       state.provider,
    tokens_input:   state.tokens_input,
    tokens_output:  state.tokens_output,
    tool_calls:     state.tool_calls,
    current_tool:   state.current_tool,
    last_heartbeat: state.last_heartbeat ? new Date(state.last_heartbeat).toISOString() : null,
    started_at:     state.started_at ? new Date(state.started_at).toISOString() : null,
    ended_at:       state.ended_at ? new Date(state.ended_at).toISOString() : null,
    abort_reason:   state.abort_reason,
  }
}

// ── Fork-aware WS broadcast ─────────────────────────────────────────────────
// Every WS event a fork emits carries fork_id so the frontend can thread it.
// Main's events keep fork_id="main" via the wrapper in osSessionService (added
// in step 6 of this build); forks always stamp their own id here.
function _emitForkOutput(fork_id, data) {
  try { broadcast('os-session:output', { fork_id, data }) }
  catch (err) { logger.warn('forkService: broadcast failed (non-fatal)', { error: err.message, fork_id }) }
}

function _emitForkStatus(fork_id, status, meta = {}) {
  try { broadcast('os-session:status', { fork_id, status, ...meta }) }
  catch (err) { logger.warn('forkService: broadcast failed (non-fatal)', { error: err.message, fork_id }) }
}

// Registry-delta event: a single channel the frontend subscribes to for the
// live tracks panel. Fired on spawn, every status transition, every position
// change, and on terminate. Cheap rollup, ~200 bytes per event.
function _emitForkEvent(kind, state) {
  try { broadcast('os-session:fork', { kind, fork: _forkSnapshot(state) }) }
  catch (err) { logger.debug('forkService: fork event broadcast failed', { error: err.message }) }
}

// ── DB persistence (fire-and-forget) ────────────────────────────────────────
async function _dbInsert(state) {
  try {
    await db`
      INSERT INTO os_forks (
        fork_id, parent_id, brief, context_mode, status,
        provider, started_at
      ) VALUES (
        ${state.fork_id}, ${state.parent_id}, ${state.brief}, ${state.context_mode}, ${state.status},
        ${state.provider}, to_timestamp(${state.started_at} / 1000.0)
      )
      ON CONFLICT (fork_id) DO NOTHING
    `
  } catch (err) {
    logger.warn('forkService: _dbInsert failed (non-fatal)', { error: err.message, fork_id: state.fork_id })
  }
}

async function _dbUpdate(state) {
  try {
    await db`
      UPDATE os_forks SET
        status        = ${state.status},
        position      = ${state.position},
        result        = ${state.result},
        next_step     = ${state.next_step},
        abort_reason  = ${state.abort_reason},
        cc_session_id = ${state.cc_session_id},
        tokens_input  = ${state.tokens_input},
        tokens_output = ${state.tokens_output},
        tool_calls    = ${state.tool_calls},
        current_tool  = ${state.current_tool},
        last_heartbeat = to_timestamp(${state.last_heartbeat} / 1000.0),
        ended_at      = ${state.ended_at ? db`to_timestamp(${state.ended_at} / 1000.0)` : null}
      WHERE fork_id = ${state.fork_id}
    `
  } catch (err) {
    logger.warn('forkService: _dbUpdate failed (non-fatal)', { error: err.message, fork_id: state.fork_id })
  }
}

// ── Cap enforcement (spec §1.5) ─────────────────────────────────────────────
function _activeCount() {
  let n = 0
  for (const s of _forks.values()) {
    if (s.status === 'spawning' || s.status === 'running' || s.status === 'reporting') n++
  }
  return n
}

async function _energyCap() {
  try {
    const e = await usageEnergy.getEnergy()
    const lvl = e?.level || 'healthy'
    if (Object.prototype.hasOwnProperty.call(ENERGY_FORK_CAPS, lvl)) return ENERGY_FORK_CAPS[lvl]
    return ENERGY_FORK_CAPS.healthy
  } catch {
    return ENERGY_FORK_CAPS.healthy
  }
}

// ── MCP loader (mirror of osSessionService logic, scoped) ───────────────────
function _getAllMcpConfigs(cwd) {
  try {
    const p = path.join(cwd, '.mcp.json')
    if (!fs.existsSync(p)) return {}
    const raw = JSON.parse(fs.readFileSync(p, 'utf8'))
    const servers = raw.mcpServers || {}
    const out = {}
    for (const [name, cfg] of Object.entries(servers)) {
      out[name] = {
        type: cfg.type || 'stdio',
        command: cfg.command,
        args: cfg.args || [],
        ...(cfg.env ? { env: cfg.env } : {}),
      }
    }
    return out
  } catch (err) {
    logger.warn('forkService: failed to load .mcp.json', { error: err.message })
    return {}
  }
}

function _conductorMcp(all) {
  const out = {}
  for (const n of FORK_CONDUCTOR_SERVERS) if (all[n]) out[n] = all[n]
  return out
}

function _subagentMcpForDomain(all, names) {
  const specs = []
  for (const n of names) if (all[n]) specs.push({ [n]: all[n] })
  return specs
}

function _buildForkAgents(all) {
  return {
    comms: {
      description: 'Fork-mode comms specialist: email, calendar, CRM, SMS.',
      prompt: 'You are a fork-mode comms specialist. Same rules as the main comms subagent — keep it tight, professional, CRM-aware.',
      model: 'sonnet',
      mcpServers: _subagentMcpForDomain(all, FORK_SUBAGENT_DOMAINS.comms),
      permissionMode: 'bypassPermissions',
      maxTurns: 30,
    },
    finance: {
      description: 'Fork-mode finance officer: bookkeeping, P&L, BAS/GST.',
      prompt: 'You are a fork-mode finance officer. Same rules as the main finance subagent.',
      model: 'sonnet',
      mcpServers: _subagentMcpForDomain(all, FORK_SUBAGENT_DOMAINS.finance),
      permissionMode: 'bypassPermissions',
      maxTurns: 20,
    },
    ops: {
      description: 'Fork-mode ops engineer: VPS, PM2, deployments.',
      prompt: 'You are a fork-mode ops engineer. Diagnose before acting. Stamp git commits and pm2 actions clearly.',
      model: 'sonnet',
      mcpServers: _subagentMcpForDomain(all, FORK_SUBAGENT_DOMAINS.ops),
      permissionMode: 'bypassPermissions',
      maxTurns: 20,
    },
    social: {
      description: 'Fork-mode social/platform specialist: Vercel, Zernio, Xero.',
      prompt: 'You are a fork-mode social/platform specialist.',
      model: 'sonnet',
      mcpServers: _subagentMcpForDomain(all, FORK_SUBAGENT_DOMAINS.social),
      permissionMode: 'bypassPermissions',
      maxTurns: 15,
    },
  }
}

// ── Fork system prompt (spec §1.3) ──────────────────────────────────────────
function _buildForkSystemPrompt(cwd, fork_id, brief) {
  let claudeMd = ''
  try {
    const p = path.join(cwd, 'CLAUDE.md')
    if (fs.existsSync(p)) claudeMd = fs.readFileSync(p, 'utf8')
  } catch {}
  const today = new Date().toISOString().slice(0, 10)

  const forkBlock = `# You are a fork
You are a fork of the main EcodiaOS conductor session. Main is still running on its own work — you do NOT share state with it after this moment.

Your fork id: ${fork_id}
Your brief is in the user message below.

Operating rules:
- Work on the brief, then end with a single line:
    [FORK_REPORT] <one-paragraph summary of what you did, results, anything main needs to know>
- If you want main to take a follow-up action, append after the summary:
    [NEXT_STEP] <one short sentence — what main should do next>
- Do not call any os-session lifecycle tool (restart, compact, handover). Those are main's only.
- pm2 restart and git push are allowed, but stamp every external side-effect (commits, emails, SMS, Neo4j writes) with your fork id (${fork_id}) so duplicate-detection works in post-hoc review.
- Factory dispatch is allowed — multiple concurrent Factory sessions are fine architecturally.
- If you hit something that only main should decide, write it into your [FORK_REPORT] and stop.
- You cannot speak to main while you work; main reads your report when you're done.
- Keep your output tight. Main's context is the precious one, not yours, but you still cost tokens.`

  const envBlock = `# Environment
Working directory: ${cwd}
Platform: linux
Date: ${today}
You are powered by Claude (Anthropic's model). Running inside an EcodiaOS fork via the Claude Agent SDK.`

  return [claudeMd, envBlock, forkBlock].filter(Boolean).join('\n\n---\n\n')
}

// ── Provider env wiring (mirror osSessionService for a single fork run) ─────
function _resolveProviderForFork() {
  const best = usageEnergy.getBestProvider()
  const sessionEnv = { ...process.env }
  let provider = 'claude_max'
  let model

  if (best.isBedrockFallback) {
    provider = 'bedrock'
    if (env.AWS_ACCESS_KEY_ID) sessionEnv.AWS_ACCESS_KEY_ID = env.AWS_ACCESS_KEY_ID
    if (env.AWS_SECRET_ACCESS_KEY) sessionEnv.AWS_SECRET_ACCESS_KEY = env.AWS_SECRET_ACCESS_KEY
    if (env.AWS_REGION) sessionEnv.AWS_REGION = env.AWS_REGION
    sessionEnv.CLAUDE_CODE_USE_BEDROCK = '1'
    model = env.BEDROCK_MODEL || 'us.anthropic.claude-sonnet-4-6'
  } else if (best.provider === 'claude_max_2') {
    provider = 'claude_max_2'
    delete sessionEnv.ANTHROPIC_API_KEY
    if (env.CLAUDE_CODE_OAUTH_TOKEN_CODE) {
      sessionEnv.CLAUDE_CODE_OAUTH_TOKEN = env.CLAUDE_CODE_OAUTH_TOKEN_CODE
      delete sessionEnv.CLAUDE_CONFIG_DIR
    } else if (env.CLAUDE_CONFIG_DIR_2) {
      sessionEnv.CLAUDE_CONFIG_DIR = env.CLAUDE_CONFIG_DIR_2
    }
  } else {
    provider = 'claude_max'
    delete sessionEnv.ANTHROPIC_API_KEY
    if (env.CLAUDE_CODE_OAUTH_TOKEN_TATE) {
      sessionEnv.CLAUDE_CODE_OAUTH_TOKEN = env.CLAUDE_CODE_OAUTH_TOKEN_TATE
      delete sessionEnv.CLAUDE_CONFIG_DIR
    } else if (env.CLAUDE_CONFIG_DIR_1) {
      sessionEnv.CLAUDE_CONFIG_DIR = env.CLAUDE_CONFIG_DIR_1
    }
  }
  return { provider, env: sessionEnv, model }
}

// ── Core: spawn one fork ────────────────────────────────────────────────────
async function spawnFork({ brief, context_mode = 'recent' } = {}) {
  if (!brief || typeof brief !== 'string' || !brief.trim()) {
    throw Object.assign(new Error('brief is required'), { httpStatus: 400, code: 'invalid_brief' })
  }
  if (!['recent', 'brief'].includes(context_mode)) {
    throw Object.assign(new Error('context_mode must be "recent" or "brief"'), {
      httpStatus: 400, code: 'invalid_context_mode',
    })
  }

  // Cap check: hard cap first (always 3), then energy soft cap.
  const active = _activeCount()
  if (active >= HARD_FORK_CAP) {
    throw Object.assign(new Error('fork_cap_reached'), {
      httpStatus: 429,
      code: 'fork_cap_reached',
      details: { active_forks: listForks(), hard_cap: HARD_FORK_CAP },
    })
  }
  const eCap = await _energyCap()
  if (active >= eCap) {
    throw Object.assign(new Error('fork_energy_cap_reached'), {
      httpStatus: 429,
      code: 'fork_energy_cap_reached',
      details: { active_forks: listForks(), energy_cap: eCap },
    })
  }

  const fork_id = _newForkId()
  const cwd = env.OS_SESSION_CWD || '/home/tate/ecodiaos'
  const { provider, env: sessionEnv, model } = _resolveProviderForFork()
  const abort = new AbortController()
  const startedAt = Date.now()

  const state = {
    fork_id,
    parent_id: 'main',
    brief,
    context_mode,
    status: 'spawning',
    position: 'spawning',
    result: null,
    next_step: null,
    abort_reason: null,
    provider,
    cc_session_id: null,
    tokens_input: 0,
    tokens_output: 0,
    tool_calls: 0,
    current_tool: null,
    last_heartbeat: startedAt,
    started_at: startedAt,
    ended_at: null,
    abort,
    queryHandle: null,
    transcript: [],   // collected assistant text fragments - used to extract [FORK_REPORT]
    // Per-fork message injection queue (populated by sendMessageToFork)
    pendingMessages:  [],  // messages waiting to be yielded to the SDK
    pendingResolvers: [],  // resolvers waiting for the next message
    input_closed:     false,
  }
  _forks.set(fork_id, state)
  _emitForkEvent('spawned', state)
  // must await: ensures row exists before run-loop UPDATEs (sibling fix to e4bd2a7)
  await _dbInsert(state)

  // Build SDK options. We deliberately reuse main's pattern (custom systemPrompt
  // string, conductor MCP, agents) so behaviour is symmetrical, then layer on
  // the fork-specific brief.
  const allConfigs = _getAllMcpConfigs(cwd)
  const mcpServers = _conductorMcp(allConfigs)
  const systemPrompt = _buildForkSystemPrompt(cwd, fork_id, brief)

  const options = {
    cwd,
    permissionMode: 'bypassPermissions',
    allowDangerouslySkipPermissions: true,
    includePartialMessages: true,
    systemPrompt,
    model: model || env.OS_SESSION_MODEL || undefined,
    thinking: { type: 'enabled', budget_tokens: 6000 },
    mcpServers,
    allowedTools: [
      ...Object.keys(mcpServers).map(n => `mcp__${n}__*`),
      'Agent',
    ],
    agents: _buildForkAgents(allConfigs),
    abortController: abort,
    env: sessionEnv,
  }

  // ── Run loop (background) ────────────────────────────────────────────
  // We do NOT await this — spawnFork returns immediately and the caller
  // (HTTP handler) gets the fork id. The loop runs on its own promise chain.
  ;(async () => {
    try {
      const queryFn = await getQuery()
      const userPrompt = `BRIEF (fork ${fork_id}, context_mode=${context_mode}):\n\n${brief}`
      logger.info('forkService: starting fork', { fork_id, provider, context_mode, brief_chars: brief.length })

      // Build async-iterable prompt source so sendMessageToFork can inject
      // user messages mid-stream without aborting the session (spec §2).
      // The generator closes over `state` (outer spawnFork scope) and
      // `userPrompt` (this IIFE scope) - both are available here.
      async function* _makeForkPromptStream() {
        // First yield: the initial brief.
        yield {
          type: 'user',
          message: { role: 'user', content: [{ type: 'text', text: userPrompt }] },
          parent_tool_use_id: null,
        }
        // Subsequent yields: injected messages from sendMessageToFork.
        while (true) {
          if (state.pendingMessages.length > 0) {
            // Message already queued - yield it immediately.
            const txt = state.pendingMessages.shift()
            yield {
              type: 'user',
              message: { role: 'user', content: [{ type: 'text', text: txt }] },
              parent_tool_use_id: null,
            }
          } else if (state.input_closed) {
            // Stream closed and queue drained - end the iterable.
            return
          } else {
            // No message queued and not closed - wait for the next push.
            const txt = await new Promise(resolve => state.pendingResolvers.push(resolve))
            if (txt === null) return  // null sentinel = stream closed
            yield {
              type: 'user',
              message: { role: 'user', content: [{ type: 'text', text: txt }] },
              parent_tool_use_id: null,
            }
          }
        }
      }

      const q = queryFn({ prompt: _makeForkPromptStream(), options })
      state.queryHandle = q
      state.status = 'running'
      state.position = 'started'
      state.last_heartbeat = Date.now()
      _emitForkEvent('status', state)
      _emitForkStatus(fork_id, 'streaming', { fork_id })
      await _dbUpdate(state)

      for await (const msg of q) {
        state.last_heartbeat = Date.now()

        switch (msg.type) {
          case 'system': {
            if (msg.subtype === 'init' && msg.session_id) {
              state.cc_session_id = msg.session_id
            }
            break
          }
          case 'assistant': {
            const blocks = msg.message?.content || []
            const textParts = blocks
              .filter(b => b.type === 'text' && b.text)
              .map(b => b.text)
            const text = textParts.join('\n\n')
            if (text) {
              const safe = secretSafety.scrubSecrets(text)
              state.transcript.push(safe)
              // Position = first ~100 chars of latest assistant text.
              state.position = safe.replace(/\s+/g, ' ').slice(0, 140)
              _emitForkOutput(fork_id, { type: 'assistant_text', content: safe, fork_id })
              _emitForkEvent('position', state)
            }
            const toolUses = blocks.filter(b => b.type === 'tool_use')
            if (toolUses.length) {
              state.tool_calls += toolUses.length
              state.current_tool = toolUses[toolUses.length - 1].name
              state.position = `running tool: ${state.current_tool}`
              _emitForkOutput(fork_id, {
                type: 'tool_use',
                tools: toolUses.map(t => ({ name: t.name, id: t.id })),
                fork_id,
              })
              _emitForkEvent('position', state)
            }
            if (msg.message?.usage) {
              state.tokens_input  += msg.message.usage.input_tokens  || 0
              state.tokens_output += msg.message.usage.output_tokens || 0
            }
            break
          }
          case 'user': {
            // tool_result blocks — clear current_tool, count nothing.
            const content = msg.message?.content
            if (Array.isArray(content)) {
              for (const block of content) {
                if (block.type === 'tool_result') {
                  state.current_tool = null
                  let txt = ''
                  if (typeof block.content === 'string') txt = block.content
                  else if (Array.isArray(block.content)) {
                    txt = block.content.filter(b => b.type === 'text').map(b => b.text).join('\n')
                  }
                  if (txt.length > 1500) txt = txt.slice(0, 1500) + '\n… (truncated)'
                  _emitForkOutput(fork_id, {
                    type: block.is_error ? 'tool_use_error' : 'tool_use_result',
                    tool_use_id: block.tool_use_id,
                    content: txt || '(no output)',
                    fork_id,
                  })
                }
              }
            }
            break
          }
          case 'result': {
            // SDK terminal - fork is wrapping up.
            // Close the prompt stream so the generator yields no further messages.
            state.input_closed = true
            for (const resolve of state.pendingResolvers.splice(0)) resolve(null)
            state.status = 'reporting'
            _emitForkEvent('status', state)
            break
          }
        }
      }

      // Stream complete — extract [FORK_REPORT] / [NEXT_STEP] from transcript.
      const fullText = state.transcript.join('\n\n')
      const reportMatch = fullText.match(/\[FORK_REPORT\][^\n]*([\s\S]*?)(?:\[NEXT_STEP\]|$)/i)
      const nextMatch = fullText.match(/\[NEXT_STEP\][^\n]*([\s\S]*?)$/i)
      const report = reportMatch ? reportMatch[1].trim() : null
      const nextStep = nextMatch ? nextMatch[1].trim() : null

      state.result = report || (fullText.length > 600 ? fullText.slice(-600) : fullText) || '(no output)'
      state.next_step = nextStep
      state.status = 'done'
      state.ended_at = Date.now()
      state.position = report ? `done: ${report.slice(0, 100)}` : 'done'
      _emitForkEvent('done', state)
      _emitForkStatus(fork_id, 'complete', { fork_id })
      await _dbUpdate(state)

      logger.info('forkService: fork complete', {
        fork_id,
        duration_ms: state.ended_at - state.started_at,
        tokens_input: state.tokens_input,
        tokens_output: state.tokens_output,
        tool_calls: state.tool_calls,
        had_report: !!report,
        had_next_step: !!nextStep,
      })

      // Post the report back to main via the message queue. Non-interrupting:
      // it lands on main's next turn as a system message.
      if (report) {
        try {
          const mq = require('./messageQueue')
          const body = [
            `[SYSTEM: fork_report ${fork_id}]`,
            `Brief: ${brief}`,
            '',
            `Report: ${report}`,
            nextStep ? `\nNext step suggested: ${nextStep}` : '',
          ].filter(Boolean).join('\n')
          await mq.enqueueMessage({ body, source: `fork:${fork_id}`, mode: 'queue' })
        } catch (err) {
          logger.warn('forkService: failed to enqueue fork_report to main', { fork_id, error: err.message })
        }
      }
    } catch (err) {
      // Close the prompt stream and drain pending resolvers so the generator
      // does not leak (null sentinel causes the generator to return).
      state.input_closed = true
      for (const resolve of state.pendingResolvers.splice(0)) resolve(null)

      const aborted = err?.name === 'AbortError' || /abort/i.test(err?.message || '')
      state.status = aborted ? 'aborted' : 'error'
      state.abort_reason = state.abort_reason || (aborted ? 'aborted' : err?.message || 'error')
      state.ended_at = Date.now()
      state.position = state.status
      _emitForkEvent(state.status, state)
      _emitForkStatus(fork_id, 'complete', { fork_id, error: state.abort_reason })
      await _dbUpdate(state)
      logger.error('forkService: fork failed', { fork_id, status: state.status, error: err?.message, stack: err?.stack })
    } finally {
      // Keep the entry for ~5min after termination so the frontend can render
      // its final state, then evict to keep the Map small.
      setTimeout(() => { _forks.delete(fork_id) }, 5 * 60 * 1000).unref?.()
    }
  })().catch(err => logger.error('forkService: top-level fork loop threw (should never happen)', { fork_id, error: err.message }))

  return _forkSnapshot(state)
}

// ── Public registry helpers ─────────────────────────────────────────────────
function listForks() {
  return Array.from(_forks.values()).map(_forkSnapshot)
}

function getFork(fork_id) {
  const s = _forks.get(fork_id)
  return s ? _forkSnapshot(s) : null
}

async function abortFork(fork_id, reason = 'manual_abort') {
  const s = _forks.get(fork_id)
  if (!s) return { aborted: false, reason: 'not_found' }
  if (s.status === 'done' || s.status === 'aborted' || s.status === 'error') {
    return { aborted: false, reason: `already_${s.status}` }
  }
  s.abort_reason = reason
  try { s.abort?.abort?.(reason) } catch {}
  try { s.queryHandle?.close?.() } catch {}
  return { aborted: true, fork_id }
}

// ── Message injection ───────────────────────────────────────────────────────
// Sends a user message into a running fork's SDK stream without aborting it.
// The fork receives the message on its next SDK turn via the async-iterable
// prompt source built in spawnFork. Returns synchronously.
function sendMessageToFork(fork_id, message) {
  const s = _forks.get(fork_id)
  if (!s) return { accepted: false, reason: 'not_found' }
  if (s.status === 'done' || s.status === 'aborted' || s.status === 'error') {
    return { accepted: false, reason: 'fork_terminal' }
  }
  if (s.status === 'spawning' && !s.queryHandle) {
    return { accepted: false, reason: 'fork_not_running' }
  }

  // Push to queue or resolve a waiting generator promise, whichever applies.
  if (s.pendingResolvers.length > 0) {
    const resolve = s.pendingResolvers.shift()
    resolve(message)
  } else {
    s.pendingMessages.push(message)
  }

  s.last_heartbeat = Date.now()
  s.position = `received message: ${message.slice(0, 80)}`

  const queuedCount = s.pendingMessages.length
  logger.info('forkService: message_injected', { fork_id, message_chars: message.length, queued_count: queuedCount })

  return { accepted: true, fork_id, queued_messages: queuedCount }
}

// ── Conductor rollup (spec §3 of the message follow-up) ─────────────────────
// Bounded summary the conductor sees instead of fork transcripts. Keeps the
// conductor's context as a goals/positions/results/next-steps brain only.
async function forksRollup({ includeRecentDone = true } = {}) {
  const live = listForks()
  if (!live.length) {
    if (!includeRecentDone) return null
    // Pull last 5 finished forks from DB so the conductor can also see "what
    // just finished" if a fork report came in via the queue.
    let recent = []
    try {
      recent = await db`
        SELECT fork_id, brief, status, position, result, next_step, started_at, ended_at
        FROM os_forks
        WHERE ended_at > now() - interval '15 minutes'
        ORDER BY ended_at DESC
        LIMIT 5
      `
    } catch { recent = [] }
    if (!recent.length) return null
    const lines = recent.map(r => {
      const head = `${r.fork_id} [${r.status}] brief="${(r.brief || '').slice(0, 60)}"`
      const tail = r.next_step ? `  next_step: ${r.next_step}` : ''
      return `- ${head}${tail ? '\n' + tail : ''}`
    })
    return `<forks_rollup>\nNo active forks. Recently finished:\n${lines.join('\n')}\n</forks_rollup>`
  }
  const lines = live.map(f => {
    const ageSec = f.started_at ? Math.round((Date.now() - new Date(f.started_at).getTime()) / 1000) : 0
    return `- ${f.fork_id} [${f.status}] (${ageSec}s, ${f.tool_calls} tools) brief="${(f.brief || '').slice(0, 60)}"\n    position: ${(f.position || '').slice(0, 100)}`
  })
  return `<forks_rollup>\nActive forks (${live.length}/${HARD_FORK_CAP}):\n${lines.join('\n')}\n</forks_rollup>`
}

// ── Test hooks ──────────────────────────────────────────────────────────────
function _resetForTest() { _forks.clear() }
function _getForkMapForTest() { return _forks }
function _setQueryForTest(fn) { _queryOverride = fn }

module.exports = {
  spawnFork,
  abortFork,
  sendMessageToFork,
  listForks,
  getFork,
  forksRollup,
  HARD_FORK_CAP,
  ENERGY_FORK_CAPS,
  _resetForTest,
  _getForkMapForTest,
  _setQueryForTest,
}
