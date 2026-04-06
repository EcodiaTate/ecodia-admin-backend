/**
 * OS Session Service — manages a persistent Claude Code session as the OS brain.
 *
 * Uses resume-on-demand pattern: each user message spawns CC CLI with --resume,
 * CC exits after responding, next message resumes. Proven by ccService.js resumeSession().
 *
 * The OS session:
 * - Has MCP access to all business systems via .mcp.json
 * - Reads CLAUDE.md for identity and business rules
 * - Persists conversation across browser refreshes and PM2 restarts
 * - Streams output via WebSocket in real-time
 */

const { spawn } = require('child_process')
const { createInterface } = require('readline')
const db = require('../config/db')
const logger = require('../config/logger')
const env = require('../config/env')
const { broadcast } = require('../websocket/wsManager')
const secretSafety = require('./secretSafetyService')

const CC_CLI = env.CLAUDE_CLI_PATH || 'claude'
const OS_SESSION_TIMEOUT_MS = parseInt(env.OS_SESSION_TIMEOUT_MS || '300000', 10) // 5min per exchange
const STDIN_WARNING_RE = /no stdin data received/i

// In-memory state for the active OS session process
let activeProcess = null

// ── Backpressure-aware stdin write (from ccService.js) ──

function writeStdinSafe(proc, data) {
  return new Promise((resolve, reject) => {
    const ok = proc.stdin.write(data)
    if (ok) {
      proc.stdin.end(resolve)
    } else {
      proc.stdin.once('drain', () => proc.stdin.end(resolve))
    }
    proc.stdin.once('error', reject)
  })
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

// ── Main: send a message to the OS session ──

async function sendMessage(content) {
  // Kill any leftover active process
  if (activeProcess) {
    try { activeProcess.process.kill('SIGTERM') } catch {}
    activeProcess = null
  }

  // Find or create the OS session
  let session = await getOSSession()
  let isResume = false

  if (session?.cc_cli_session_id) {
    isResume = true
  } else {
    session = await createOSSession()
  }

  const sessionId = session.id
  emitStatus('streaming', { sessionId })

  // Build CLI args
  const args = [
    '--print',
    '--verbose',
    '--output-format', 'stream-json',
    '--dangerously-skip-permissions',
  ]
  if (isResume && session.cc_cli_session_id) {
    args.push('--resume', session.cc_cli_session_id)
  }

  // cwd must contain .mcp.json and CLAUDE.md
  // VPS: ~/ecodiaos/ (same dir as backend — CLAUDE.md + .mcp.json + mcp-servers/ live alongside src/)
  // Local dev: set OS_SESSION_CWD to your monorepo root (e.g. d:/.code/ecodiaos)
  const cwd = env.OS_SESSION_CWD || '/home/tate/ecodiaos'

  const ccEnv = { ...process.env, LANG: 'en_US.UTF-8' }
  delete ccEnv.ANTHROPIC_API_KEY // forces console auth

  logger.info(`OS Session ${isResume ? 'resuming' : 'starting'}`, { sessionId, ccCliSessionId: session.cc_cli_session_id })

  const proc = spawn(CC_CLI, args, {
    cwd,
    env: ccEnv,
    stdio: ['pipe', 'pipe', 'pipe'],
  })

  // Track active process
  activeProcess = { process: proc, sessionId, startedAt: Date.now() }

  // Write user message via stdin
  writeStdinSafe(proc, content).catch(err =>
    logger.debug('OS Session stdin write error (non-fatal)', { error: err.message })
  )

  // Log user message
  await appendLog(sessionId, `[USER] ${content}`)
  emitOutput({ type: 'user', content })

  // Timeout
  const timeout = setTimeout(() => {
    logger.warn('OS Session exchange timed out')
    try { proc.kill('SIGTERM') } catch {}
    emitStatus('error', { error: 'Exchange timed out' })
  }, OS_SESSION_TIMEOUT_MS)
  timeout.unref?.()

  // Stream stdout (stream-json NDJSON)
  let ccCliSessionId = session.cc_cli_session_id
  let lastResultJson = null
  const collectedText = [] // collect all text blocks for HTTP response fallback

  const rl = createInterface({ input: proc.stdout })
  rl.on('line', async (line) => {
    try {
      const safeLine = secretSafety.scrubSecrets(line)
      await appendLog(sessionId, safeLine)

      // Parse stream-json to extract session ID, text, and broadcast
      try {
        const parsed = JSON.parse(safeLine)

        // Extract CC CLI session ID from the first message
        if (parsed.session_id && !ccCliSessionId) {
          ccCliSessionId = parsed.session_id
          await updateOSSession(sessionId, { ccCliSessionId, status: 'running' })
        }

        // Collect text for HTTP response fallback
        if (parsed.type === 'assistant' && parsed.message?.content) {
          for (const block of parsed.message.content) {
            if (block.type === 'text' && block.text) {
              collectedText.push(block.text)
            }
          }
        }

        // Track the last result for completion
        if (parsed.type === 'result') {
          lastResultJson = parsed
        }
      } catch {
        // Not JSON — raw text output, still broadcast
      }

      emitOutput({ type: 'stream', content: safeLine })
    } catch (err) {
      logger.debug('OS Session stdout parse error', { error: err.message })
    }
  })

  // Stream stderr (mostly noise, but log for observability)
  const stderrLines = []
  const stderrRl = createInterface({ input: proc.stderr })
  stderrRl.on('line', (line) => {
    if (STDIN_WARNING_RE.test(line)) return // harmless noise
    stderrLines.push(line)
    logger.debug('OS Session stderr', { line: line.slice(0, 200) })
  })

  // Handle process exit
  return new Promise((resolve) => {
    proc.on('close', async (code) => {
      clearTimeout(timeout)
      activeProcess = null

      // Save the CC CLI session ID for future resumes
      if (ccCliSessionId) {
        await updateOSSession(sessionId, { ccCliSessionId, status: code === 0 ? 'complete' : 'error' })
      }

      if (code !== 0 && stderrLines.length > 0) {
        const errorMsg = stderrLines.slice(-5).join('\n')
        emitOutput({ type: 'error', content: errorMsg })
        logger.warn('OS Session exited with error', { code, stderr: errorMsg.slice(0, 500) })
      }

      // Emit both status and complete events — frontend listens on complete to finalize
      emitStatus('complete', { sessionId, code })
      broadcast('os-session:complete', { sessionId, code })
      logger.info('OS Session exchange complete', { sessionId, code, ccCliSessionId })

      resolve({ sessionId, ccCliSessionId, code, text: collectedText.join('\n\n') })
    })
  })
}

// ── Get current session status ──

async function getStatus() {
  const session = await getOSSession()
  return {
    active: !!activeProcess,
    sessionId: session?.id || null,
    ccCliSessionId: session?.cc_cli_session_id || null,
    status: activeProcess ? 'streaming' : (session?.status || 'idle'),
    startedAt: session?.started_at,
  }
}

// ── Restart — kill current, start fresh ──

async function restart() {
  if (activeProcess) {
    try { activeProcess.process.kill('SIGTERM') } catch {}
    activeProcess = null
  }
  // Create a new session (don't reuse the old cc_cli_session_id)
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

module.exports = { sendMessage, getStatus, restart, getHistory }
