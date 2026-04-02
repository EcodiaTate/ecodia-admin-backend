const { spawn } = require('child_process')
const { createInterface } = require('readline')
const logger = require('../config/logger')
const db = require('../config/db')
const env = require('../config/env')
const { broadcastToSession } = require('../websocket/wsManager')
const { appendLog, updateSessionStatus } = require('../db/queries/ccSessions')
const codebaseIntelligence = require('./codebaseIntelligenceService')
const kg = require('./knowledgeGraphService')
const kgHooks = require('./kgIngestionHooks')
const secretSafety = require('./secretSafetyService')

// ═══════════════════════════════════════════════════════════════════════
// CC SERVICE — Claude Code Execution Engine
//
// Spawns headless Claude Code CLI sessions as child processes.
// Streams output in real-time via WebSocket. Builds rich context
// bundles from codebase intelligence + KG. Manages lifecycle:
// spawn → stream → timeout → cleanup.
//
// Uses `claude` CLI (Anthropic console account, NOT API).
// ═══════════════════════════════════════════════════════════════════════

const activeSessions = new Map()

const CC_CLI = env.CLAUDE_CLI_PATH || 'claude'
const MAX_TURNS = parseInt(env.CC_MAX_TURNS || '200', 10)
const SESSION_TIMEOUT_MS = parseInt(env.CC_TIMEOUT_MINUTES || '120', 10) * 60 * 1000

// ─── Context Bundle Builder ─────────────────────────────────────────

async function buildContextBundle(session) {
  const bundle = {
    codebaseStructure: null,
    relevantChunks: [],
    kgContext: null,
    prompt: session.initial_prompt,
  }

  // Get codebase context if linked
  if (session.codebase_id) {
    try {
      const structure = await codebaseIntelligence.getCodebaseStructure(session.codebase_id)
      bundle.codebaseStructure = structure

      // Semantic search for relevant code
      const chunks = await codebaseIntelligence.queryCodebase(
        session.codebase_id,
        session.initial_prompt,
        { limit: 15 }
      )
      bundle.relevantChunks = chunks
    } catch (err) {
      logger.debug('Failed to get codebase context for CC session', { error: err.message })
    }
  }

  // Get KG context
  try {
    const kgContext = await kg.getContext(session.initial_prompt)
    bundle.kgContext = kgContext
  } catch (err) {
    logger.debug('Failed to get KG context for CC session', { error: err.message })
  }

  // Get recent Factory session history for this codebase
  bundle.sessionHistory = []
  if (session.codebase_id) {
    try {
      const recentSessions = await db`
        SELECT initial_prompt, status, confidence_score, files_changed, error_message, started_at
        FROM cc_sessions
        WHERE codebase_id = ${session.codebase_id}
          AND id != ${session.id}
          AND started_at > now() - interval '14 days'
        ORDER BY started_at DESC LIMIT 10
      `
      bundle.sessionHistory = recentSessions
    } catch {}
  }

  // Get factory learnings (cross-session knowledge)
  bundle.factoryLearnings = { codebase: [], global: [] }
  try {
    // Exclude learnings that have decayed below threshold or haven't been
    // applied in 90+ days (stale patterns mislead more than they help).
    // Rank by recency of last application, then confidence.
    const codebaseLearnings = session.codebase_id ? await db`
      SELECT id, pattern_type, pattern_description, confidence, times_applied, last_applied_at
      FROM factory_learnings
      WHERE codebase_id = ${session.codebase_id}
        AND confidence > 0.3
        AND (last_applied_at IS NULL OR last_applied_at > now() - interval '90 days')
      ORDER BY last_applied_at DESC NULLS LAST, confidence DESC, updated_at DESC LIMIT 10
    ` : []

    const globalLearnings = await db`
      SELECT id, pattern_type, pattern_description, confidence, times_applied, last_applied_at
      FROM factory_learnings
      WHERE codebase_id IS NULL
        AND confidence > 0.3
        AND (last_applied_at IS NULL OR last_applied_at > now() - interval '90 days')
      ORDER BY last_applied_at DESC NULLS LAST, confidence DESC, updated_at DESC LIMIT 5
    `

    bundle.factoryLearnings.codebase = codebaseLearnings
    bundle.factoryLearnings.global = globalLearnings

    // Track that these learnings were applied
    const allIds = [...codebaseLearnings, ...globalLearnings].map(l => l.id)
    if (allIds.length > 0) {
      await db`
        UPDATE factory_learnings
        SET times_applied = times_applied + 1, last_applied_at = now()
        WHERE id = ANY(${allIds})
      `
    }
  } catch (err) {
    logger.debug('Failed to fetch factory learnings', { error: err.message })
  }

  return bundle
}

function assemblePrompt(session, bundle) {
  const parts = []

  // Codebase structure
  if (bundle.codebaseStructure) {
    parts.push(`## Codebase Structure (${bundle.codebaseStructure.fileCount} files)`)
    parts.push('```')
    parts.push(formatTree(bundle.codebaseStructure.tree, '', 3))
    parts.push('```')
    parts.push('')
  }

  // Relevant code chunks
  if (bundle.relevantChunks.length > 0) {
    parts.push('## Relevant Code Context')
    for (const chunk of bundle.relevantChunks) {
      const sim = chunk.similarity ? ` (similarity: ${(chunk.similarity * 100).toFixed(0)}%)` : ''
      parts.push(`### ${chunk.file_path}:${chunk.start_line}-${chunk.end_line}${sim}`)
      parts.push('```' + (chunk.language || ''))
      parts.push(chunk.content.slice(0, 2000))
      parts.push('```')
      parts.push('')
    }
  }

  // KG context
  if (bundle.kgContext) {
    parts.push('## Knowledge Graph Context')
    parts.push(bundle.kgContext)
    parts.push('')
  }

  // Recent Factory history on this codebase
  if (bundle.sessionHistory && bundle.sessionHistory.length > 0) {
    parts.push('## Recent Factory Activity on This Codebase')
    parts.push('These are previous autonomous sessions — avoid duplicating work.')
    for (const s of bundle.sessionHistory) {
      const files = (s.files_changed || []).slice(0, 5).join(', ')
      parts.push(`- [${s.status}${s.confidence_score ? `, confidence: ${s.confidence_score}` : ''}] ${(s.initial_prompt || '').slice(0, 120)}${files ? ` → files: ${files}` : ''}${s.error_message ? ` (error: ${s.error_message.slice(0, 80)})` : ''}`)
    }
    parts.push('')
  }

  // Factory learnings (cross-session knowledge)
  const allLearnings = [
    ...(bundle.factoryLearnings?.codebase || []),
    ...(bundle.factoryLearnings?.global || []),
  ]
  if (allLearnings.length > 0) {
    parts.push('## Factory Learnings (from previous sessions)')
    parts.push('These are patterns learned from previous autonomous sessions. Apply them where relevant.')
    for (const l of allLearnings) {
      const icon = l.pattern_type === 'dont_try' ? 'AVOID' :
        l.pattern_type === 'failure_pattern' ? 'FAILED' :
        l.pattern_type === 'success_pattern' ? 'WORKED' :
        l.pattern_type === 'technique' ? 'TECHNIQUE' : 'NOTE'
      parts.push(`- [${icon}] (confidence: ${l.confidence}) ${l.pattern_description}`)
    }
    parts.push('')
  }

  // Task
  parts.push('## Task')
  parts.push(session.initial_prompt)
  parts.push('')

  // Operating Principles
  parts.push('## Operating Principles')
  parts.push('You are the Ecodia Factory — an autonomous code execution engine. You have full freedom to accomplish the task using any tools and approaches you see fit.')
  parts.push('')
  parts.push('### Freedom')
  parts.push('- Use any tools available to you: read files, write code, run commands, search, install packages, run tests')
  parts.push('- If you need to install dependencies, do it. If you need to create directories, do it. If you need to refactor to accomplish the task properly, do it.')
  parts.push('- Make decisions autonomously. Do NOT ask questions or wait for input — you are running headless. If something is ambiguous, use your best judgment and document your reasoning.')
  parts.push('- If you discover related issues while working, fix them if they are directly relevant to the task')
  parts.push('')
  parts.push('### Safety')
  parts.push('- Do NOT modify .env files, credential files, or any files containing secrets/API keys')
  parts.push('- Run tests after making changes if test infrastructure exists (npm test, pytest, etc)')
  parts.push('- If you encounter an unrecoverable error, clearly document what went wrong and what was attempted')
  parts.push('')
  parts.push('### Quality')
  parts.push('- Write production-grade code that matches the existing codebase style and conventions')
  parts.push('- Your changes will be reviewed by a DeepSeek oversight layer before deployment')
  parts.push('- Focus on correctness, clarity, and completeness')

  return parts.join('\n')
}

function formatTree(tree, indent, maxDepth) {
  if (maxDepth <= 0) return indent + '...'
  const lines = []
  const entries = Object.entries(tree)
  for (const [name, value] of entries) {
    if (typeof value === 'string') {
      lines.push(`${indent}${name}`)
    } else {
      lines.push(`${indent}${name}/`)
      lines.push(formatTree(value, indent + '  ', maxDepth - 1))
    }
  }
  return lines.join('\n')
}

// ─── Session Lifecycle ──────────────────────────────────────────────

async function startSession(session) {
  logger.info(`Starting CC session ${session.id}`, {
    codebaseId: session.codebase_id,
    triggerSource: session.trigger_source || 'manual',
  })

  await updateSessionStatus(session.id, 'running')
  await db`UPDATE cc_sessions SET pipeline_stage = 'context' WHERE id = ${session.id}`
  broadcastToSession(session.id, 'cc:stage', { stage: 'context', progress: 0.1 })

  // Build context bundle
  const bundle = await buildContextBundle(session)
  const fullPrompt = assemblePrompt(session, bundle)

  // Store context bundle (without full chunk content to save space)
  const bundleSummary = {
    chunkCount: bundle.relevantChunks.length,
    hasKGContext: !!bundle.kgContext,
    hasStructure: !!bundle.codebaseStructure,
    promptLength: fullPrompt.length,
    selfModification: !!session.self_modification,
  }
  await db`UPDATE cc_sessions SET context_bundle = ${JSON.stringify(bundleSummary)}, pipeline_stage = 'executing' WHERE id = ${session.id}`
  broadcastToSession(session.id, 'cc:stage', { stage: 'executing', progress: 0.2 })

  // Resolve working directory
  let cwd = session.working_dir
  if (!cwd && session.codebase_id) {
    const [codebase] = await db`SELECT repo_path FROM codebases WHERE id = ${session.codebase_id}`
    cwd = codebase?.repo_path
  }
  if (!cwd) cwd = process.cwd()

  // Spawn Claude CLI — full autonomy, no tool restrictions
  const args = [
    '--print',
    '--verbose',
    '--output-format', 'stream-json',
    '--max-turns', String(MAX_TURNS),
    '--dangerously-skip-permissions',
    '-p', fullPrompt,
  ]

  // Strip ANTHROPIC_API_KEY so CC uses console auth (not API key)
  const ccEnv = { ...process.env, LANG: 'en_US.UTF-8' }
  delete ccEnv.ANTHROPIC_API_KEY

  const proc = spawn(CC_CLI, args, {
    cwd,
    env: ccEnv,
    stdio: ['pipe', 'pipe', 'pipe'],
  })

  const sessionData = {
    process: proc,
    sessionId: session.id,
    startedAt: Date.now(),
    codebaseId: session.codebase_id,
    timeout: null,
  }
  activeSessions.set(session.id, sessionData)

  // Set timeout
  sessionData.timeout = setTimeout(async () => {
    logger.warn(`CC session ${session.id} timed out after ${SESSION_TIMEOUT_MS / 60000} min`)
    try {
      proc.kill('SIGTERM')
      setTimeout(() => {
        if (!proc.killed) proc.kill('SIGKILL')
      }, 10_000)
    } catch {}
    await updateSessionStatus(session.id, 'error', { error_message: 'Session timed out' })
    await db`UPDATE cc_sessions SET pipeline_stage = 'failed' WHERE id = ${session.id}`
    activeSessions.delete(session.id)
  }, SESSION_TIMEOUT_MS)

  // Stream stdout line by line
  const rl = createInterface({ input: proc.stdout })
  rl.on('line', async (line) => {
    try {
      // Scrub any secrets from output
      const safeLine = secretSafety.scrubSecrets(line)
      await appendLog(session.id, safeLine)

      // Try to parse as JSON (stream-json format)
      let parsed
      try {
        parsed = JSON.parse(safeLine)
      } catch {
        parsed = { type: 'raw', content: safeLine }
      }

      broadcastToSession(session.id, 'cc:output', parsed)
    } catch (err) {
      logger.debug('Error processing CC output line', { error: err.message })
    }
  })

  // Stderr
  const stderrLines = []
  const stderrRl = createInterface({ input: proc.stderr })
  stderrRl.on('line', (line) => {
    stderrLines.push(line)
    logger.debug(`CC session ${session.id} stderr: ${line}`)
  })

  // Process exit
  proc.on('close', async (code) => {
    rl.close()
    stderrRl.close()
    clearTimeout(sessionData.timeout)
    activeSessions.delete(session.id)

    const success = code === 0
    const status = success ? 'complete' : 'error'
    const errorMessage = !success ? stderrLines.slice(-5).join('\n') || `Exit code ${code}` : null

    await updateSessionStatus(session.id, status, {
      error_message: errorMessage,
    })

    // If failed, mark pipeline as failed immediately
    if (!success) {
      await db`UPDATE cc_sessions SET pipeline_stage = 'failed' WHERE id = ${session.id}`
    }

    broadcastToSession(session.id, 'cc:status', { status, code })

    // Detect changed files via git BEFORE triggering oversight
    if (success && cwd) {
      try {
        const { execFileSync } = require('child_process')
        const diff = execFileSync('git', ['diff', '--name-only'], { cwd, encoding: 'utf-8' }).trim()
        const staged = execFileSync('git', ['diff', '--name-only', '--cached'], { cwd, encoding: 'utf-8' }).trim()
        const untracked = execFileSync('git', ['ls-files', '--others', '--exclude-standard'], { cwd, encoding: 'utf-8' }).trim()

        // Filter out noise: node_modules, lockfiles, build artifacts
        const NOISE_PATTERNS = [
          /^node_modules\//,
          /^\.next\//,
          /^dist\//,
          /^build\//,
          /^\.cache\//,
          /^__pycache__\//,
          /^\.venv\//,
          /^venv\//,
          /^\.pytest_cache\//,
          /package-lock\.json$/,
          /yarn\.lock$/,
          /pnpm-lock\.yaml$/,
        ]
        const isNoise = (f) => NOISE_PATTERNS.some(p => p.test(f))

        const allChanged = [...new Set([
          ...diff.split('\n'),
          ...staged.split('\n'),
          ...untracked.split('\n'),
        ].filter(f => f && !isNoise(f)))]

        if (allChanged.length > 0) {
          await db`UPDATE cc_sessions SET files_changed = ${allChanged} WHERE id = ${session.id}`
        }
      } catch (err) {
        logger.debug('Failed to detect changed files for CC session', { sessionId: session.id, error: err.message })
      }
    }

    // KG learning hook
    kgHooks.onCCSessionCompleted({
      session: { ...session, status },
      projectName: session.project_name || null,
    }).catch(() => {})

    logger.info(`CC session ${session.id} completed`, { code, status })

    // Trigger full oversight pipeline: review → validate → deploy → monitor
    // Pipeline will set pipeline_stage through its own stages (testing → deploying → complete/failed)
    const oversight = require('./factoryOversightService')
    oversight.runPostSessionPipeline(session.id).catch(err => {
      logger.error(`Oversight pipeline failed for session ${session.id}`, { error: err.message })
      // If oversight itself fails, mark as complete (CC succeeded, oversight is best-effort)
      db`UPDATE cc_sessions SET pipeline_stage = 'complete' WHERE id = ${session.id}`.catch(() => {})
    })
  })

  proc.on('error', async (err) => {
    rl.close()
    stderrRl.close()
    clearTimeout(sessionData.timeout)
    activeSessions.delete(session.id)

    logger.error(`CC session ${session.id} process error`, { error: err.message })
    await updateSessionStatus(session.id, 'error', {
      error_message: `Process error: ${err.message}`,
    })
    await db`UPDATE cc_sessions SET pipeline_stage = 'failed' WHERE id = ${session.id}`
    broadcastToSession(session.id, 'cc:status', { status: 'error', error: err.message })
  })
}

// ─── Send Message to Running Session ────────────────────────────────

async function sendMessage(sessionId, content) {
  const sessionData = activeSessions.get(sessionId)
  if (!sessionData) throw new Error('Session not found or not running')

  const proc = sessionData.process
  if (!proc.stdin.writable) throw new Error('Session stdin is not writable')

  proc.stdin.write(content + '\n')
  await appendLog(sessionId, `[USER] ${content}`)
  broadcastToSession(sessionId, 'cc:output', { type: 'user', content })
}

// ─── Stop Session ───────────────────────────────────────────────────

async function stopSession(sessionId) {
  const sessionData = activeSessions.get(sessionId)
  if (sessionData) {
    clearTimeout(sessionData.timeout)

    const proc = sessionData.process
    proc.kill('SIGTERM')

    // Force kill after 5s if still alive
    setTimeout(() => {
      if (!proc.killed) proc.kill('SIGKILL')
    }, 5000)

    activeSessions.delete(sessionId)
  }

  // 'stopped' distinguishes human-cancelled from naturally-completed sessions
  await updateSessionStatus(sessionId, 'stopped')
  await db`UPDATE cc_sessions SET pipeline_stage = 'complete' WHERE id = ${sessionId}`
  logger.info(`CC session ${sessionId} stopped`)
}

// ─── Get Active Session Info ────────────────────────────────────────

function getActiveSessionInfo(sessionId) {
  const sessionData = activeSessions.get(sessionId)
  if (!sessionData) return null
  return {
    sessionId: sessionData.sessionId,
    startedAt: sessionData.startedAt,
    runningFor: Date.now() - sessionData.startedAt,
    codebaseId: sessionData.codebaseId,
  }
}

function getActiveSessionCount() {
  return activeSessions.size
}

module.exports = {
  startSession,
  sendMessage,
  stopSession,
  getActiveSessionInfo,
  getActiveSessionCount,
  buildContextBundle,
}
