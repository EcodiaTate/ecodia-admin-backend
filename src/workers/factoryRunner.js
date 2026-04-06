const { spawn } = require('child_process')
const { createInterface } = require('readline')
const logger = require('../config/logger')
const db = require('../config/db')
const env = require('../config/env')
const { appendLog, updateSessionStatus } = require('../db/queries/ccSessions')
const codebaseIntelligence = require('../services/codebaseIntelligenceService')
const kg = require('../services/knowledgeGraphService')
const kgHooks = require('../services/kgIngestionHooks')
const secretSafety = require('../services/secretSafetyService')
const bridge = require('../services/factoryBridge')

// ═══════════════════════════════════════════════════════════════════════
// FACTORY RUNNER — Standalone PM2 process for CC session execution
//
// This process owns all Claude Code CLI child processes. It does NOT
// load Express, routes, or any HTTP server. Communication with the
// main ecodia-api process happens entirely through Redis pub/sub via
// factoryBridge.
//
// Why separate? When ecodia-api restarts for a self-modification deploy,
// this process keeps running. CC sessions survive API restarts.
// The organism can evolve and think at the same time.
// ═══════════════════════════════════════════════════════════════════════

const activeSessions = new Map()

// Rate limit tracking
let _lastRateLimitReset = null

// Config from env
const PROMPT_BUDGET_CHARS = parseInt(env.CC_PROMPT_BUDGET_CHARS || '0', 10)
const STDERR_MAX_LINES = parseInt(env.CC_STDERR_MAX_LINES || '0', 10)
const CC_CLI = env.CLAUDE_CLI_PATH || 'claude'
const MAX_TURNS = env.CC_MAX_TURNS ? parseInt(env.CC_MAX_TURNS, 10) : 0
const _timeoutMinutes = parseInt(env.CC_TIMEOUT_MINUTES || '0', 10)
const SESSION_TIMEOUT_MS = _timeoutMinutes > 0 ? _timeoutMinutes * 60 * 1000 : 0
const STDIN_WARNING_RE = /no stdin data received/i
const ORGANISM_URL = env.ORGANISM_API_URL || 'http://localhost:8000'

function isStdinWarning(text) { return STDIN_WARNING_RE.test(text) }

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

// ─── WebSocket Relay ────────────────────────────────────────────────
// Factory runner has no WebSocket server. All WS broadcasts relay
// through Redis → ecodia-api → connected clients.

function broadcastToSession(sessionId, type, data) {
  bridge.publishWsBroadcast(sessionId, type, data)
}

function broadcast(type, data) {
  bridge.publishWsBroadcast(null, type, data)
}

// ─── Context Bundle Builder (moved from ccService.js) ───────────────
// This is identical to the ccService version. It builds the rich context
// bundle that gets piped to the CC CLI via stdin.

async function buildContextBundle(session) {
  const bundle = {
    codebaseStructure: null,
    relevantChunks: [],
    kgContext: null,
    prompt: session.initial_prompt,
  }

  const contextQuality = {
    codebaseStructure: 'skipped',
    relevantChunks: 0,
    kgContext: 'skipped',
    philosophyDocs: 0,
    philosophyDocsFailed: 0,
    sessionHistory: 0,
    learningsHard: 0,
    learningsSoft: 0,
    learningMatchMethod: 'none',
    warnings: [],
  }
  bundle._contextQuality = contextQuality

  if (session.codebase_id) {
    try {
      const structure = await codebaseIntelligence.getCodebaseStructure(session.codebase_id)
      bundle.codebaseStructure = structure
      contextQuality.codebaseStructure = 'loaded'
    } catch (err) {
      contextQuality.codebaseStructure = 'failed'
      contextQuality.warnings.push(`Codebase structure failed: ${err.message}`)
      logger.warn('Failed to get codebase context for CC session', { error: err.message, sessionId: session.id })
    }

    try {
      const chunkLimit = parseInt(env.CC_CONTEXT_CODE_CHUNKS_LIMIT || '15')
      const chunks = await codebaseIntelligence.queryCodebase(
        session.codebase_id,
        session.initial_prompt,
        { limit: chunkLimit }
      )
      bundle.relevantChunks = chunks
      contextQuality.relevantChunks = chunks.length
    } catch (err) {
      contextQuality.warnings.push(`Semantic code search failed: ${err.message}`)
      logger.warn('Failed to get relevant chunks for CC session', { error: err.message, sessionId: session.id })
    }
  }

  try {
    const kgContext = await kg.getContext(session.initial_prompt)
    bundle.kgContext = kgContext
    contextQuality.kgContext = kgContext ? 'loaded' : 'empty'
  } catch (err) {
    contextQuality.kgContext = 'failed'
    contextQuality.warnings.push(`KG context failed: ${err.message}`)
    logger.warn('Failed to get KG context for CC session', { error: err.message, sessionId: session.id })
  }

  bundle.sessionHistory = []
  if (session.codebase_id) {
    try {
      const recentSessions = await db`
        SELECT initial_prompt, status, confidence_score, files_changed, error_message,
               pipeline_stage, trigger_source, deploy_status, started_at, completed_at
        FROM cc_sessions
        WHERE codebase_id = ${session.codebase_id}
          AND id != ${session.id}
          AND started_at > now() - interval '14 days'
        ORDER BY started_at DESC LIMIT ${parseInt(env.CC_SESSION_HISTORY_LIMIT || '10')}
      `
      bundle.sessionHistory = recentSessions
    } catch {}
  }

  // Philosophy docs (CLAUDE.md, .claude/ specs)
  bundle.philosophyDocs = []
  if (session.codebase_id) {
    try {
      const [codebase] = await db`SELECT repo_path FROM codebases WHERE id = ${session.codebase_id}`
      if (codebase?.repo_path) {
        const fs = require('fs')
        const path = require('path')
        const repoPath = codebase.repo_path
        const promptLower = (session.initial_prompt || '').toLowerCase()
        const promptWords = new Set(promptLower.split(/\W+/).filter(w => w.length > 3))

        const claudeMdPaths = [
          path.join(repoPath, 'CLAUDE.md'),
          path.join(repoPath, 'backend', 'CLAUDE.md'),
          path.join(repoPath, 'frontend', 'CLAUDE.md'),
        ]
        for (const claudePath of claudeMdPaths) {
          try {
            const content = fs.readFileSync(claudePath, 'utf-8')
            if (content.length > 0) {
              const relativePath = path.relative(repoPath, claudePath)
              bundle.philosophyDocs.push({
                path: relativePath,
                content: _selectRelevantSections(content, promptWords, 8000),
              })
              contextQuality.philosophyDocs++
            }
          } catch {}
        }

        const claudeDir = path.join(repoPath, '.claude')
        try {
          const files = fs.readdirSync(claudeDir).filter(f => f.endsWith('.md'))
          for (const file of files) {
            try {
              const content = fs.readFileSync(path.join(claudeDir, file), 'utf-8')
              if (content.length > 0) {
                bundle.philosophyDocs.push({
                  path: `.claude/${file}`,
                  content: _selectRelevantSections(content, promptWords, 5000),
                })
                contextQuality.philosophyDocs++
              }
            } catch (err) {
              contextQuality.philosophyDocsFailed++
              contextQuality.warnings.push(`Failed to load .claude/${file}: ${err.message}`)
            }
          }
        } catch {}

        if (bundle.philosophyDocs.length === 0) {
          contextQuality.warnings.push('No CLAUDE.md or .claude/ spec files found — session running architecture-blind')
          logger.warn('CC session has no philosophy docs', { sessionId: session.id, repoPath })
        }
      }
    } catch (err) {
      contextQuality.warnings.push(`Philosophy doc loading failed entirely: ${err.message}`)
      logger.warn('Failed to load philosophy docs for CC session', { error: err.message, sessionId: session.id })
    }
  }

  // Factory learnings
  bundle.factoryLearnings = { codebase: [], global: [] }
  try {
    const promptLower = (session.initial_prompt || '').toLowerCase()
    const promptWords = new Set(promptLower.split(/\W+/).filter(w => w.length > 3))
    contextQuality.sessionHistory = bundle.sessionHistory.length

    const hardConfidence = parseFloat(env.CC_LEARNING_CONFIDENCE_HARD || '0.2')
    const hardLimit = parseInt(env.CC_LEARNING_HARD_LIMIT || '8')

    const hardConstraints = session.codebase_id ? await db`
      SELECT id, pattern_type, pattern_description, confidence, times_applied, last_applied_at, evidence
      FROM factory_learnings
      WHERE codebase_id = ${session.codebase_id}
        AND confidence > ${hardConfidence}
        AND absorbed_into IS NULL
        AND pattern_type IN ('failure_pattern', 'dont_try', 'constraint')
      ORDER BY confidence DESC, updated_at DESC LIMIT ${hardLimit}
    ` : []

    let relevantSoft = []

    if (session.codebase_id && env.OPENAI_API_KEY) {
      try {
        const axios = require('axios')
        const embResponse = await axios.post(
          'https://api.openai.com/v1/embeddings',
          { model: 'text-embedding-3-small', input: session.initial_prompt.slice(0, 8000) },
          { headers: { Authorization: `Bearer ${env.OPENAI_API_KEY}` } }
        )
        const promptVec = embResponse.data.data[0].embedding
        const vecStr = `[${promptVec.join(',')}]`

        const softConfidence = parseFloat(env.CC_LEARNING_CONFIDENCE_SOFT || '0.15')
        const softLimit = parseInt(env.CC_LEARNING_SOFT_LIMIT || '50')
        const softReturn = parseInt(env.CC_LEARNING_SOFT_RETURN || '12')
        const similarityThreshold = parseFloat(env.CC_LEARNING_SIMILARITY_THRESHOLD || '0.3')
        const semanticMatches = await db`
          SELECT id, pattern_type, pattern_description, confidence, times_applied, last_applied_at, evidence,
                 1 - (embedding <=> ${vecStr}::vector) AS similarity
          FROM factory_learnings
          WHERE codebase_id = ${session.codebase_id}
            AND confidence > ${softConfidence}
            AND absorbed_into IS NULL
            AND pattern_type NOT IN ('failure_pattern', 'dont_try', 'constraint')
            AND embedding IS NOT NULL
            AND (last_applied_at IS NULL OR last_applied_at > now() - interval '90 days')
          ORDER BY embedding <=> ${vecStr}::vector
          LIMIT ${softLimit}
        `
        relevantSoft = semanticMatches
          .filter(l => l.similarity > similarityThreshold)
          .map(l => ({ ...l, relevanceScore: l.similarity * 10 }))
          .slice(0, softReturn)
        if (relevantSoft.length > 0) contextQuality.learningMatchMethod = 'semantic'
      } catch (err) {
        contextQuality.warnings.push(`Semantic learning match failed: ${err.message}`)
        logger.debug('Semantic learning match failed, falling back to keyword', { error: err.message })
      }
    }

    if (relevantSoft.length === 0) {
      const _softConf = parseFloat(env.CC_LEARNING_CONFIDENCE_SOFT || '0.3')
      const _softLim = parseInt(env.CC_LEARNING_SOFT_LIMIT || '30')
      const softCandidates = session.codebase_id ? await db`
        SELECT id, pattern_type, pattern_description, confidence, times_applied, last_applied_at, evidence
        FROM factory_learnings
        WHERE codebase_id = ${session.codebase_id}
          AND confidence > ${_softConf}
          AND absorbed_into IS NULL
          AND pattern_type NOT IN ('failure_pattern', 'dont_try', 'constraint')
          AND (last_applied_at IS NULL OR last_applied_at > now() - interval '90 days')
        ORDER BY confidence DESC, updated_at DESC LIMIT ${_softLim}
      ` : []

      const scoredSoft = softCandidates.map(l => {
        const keywords = (l.evidence?.keywords || []).map(k => k.toLowerCase())
        const descWords = (l.pattern_description || '').toLowerCase().split(/\W+/).filter(w => w.length > 3)
        const allTerms = [...keywords, ...descWords]
        const overlap = allTerms.filter(t => promptWords.has(t)).length
        const fileOverlap = (l.evidence?.files || []).some(f => promptLower.includes(f.split('/').pop().replace(/\.\w+$/, '')))
        return { ...l, relevanceScore: overlap + (fileOverlap ? 3 : 0) }
      })

      const _softRet = parseInt(env.CC_LEARNING_SOFT_RETURN || '12')
      relevantSoft = scoredSoft
        .filter(l => l.relevanceScore > 0)
        .sort((a, b) => b.relevanceScore - a.relevanceScore)
        .slice(0, _softRet)

      const fallbackLimit = parseInt(env.CC_LEARNING_FALLBACK_LIMIT || '3')
      if (relevantSoft.length === 0) {
        relevantSoft = softCandidates.slice(0, fallbackLimit)
        if (relevantSoft.length > 0) contextQuality.learningMatchMethod = 'fallback'
      } else if (contextQuality.learningMatchMethod === 'none') {
        contextQuality.learningMatchMethod = 'keyword'
      }
    }

    const codebaseLearnings = [...hardConstraints, ...relevantSoft]
    const seenIds = new Set()
    const dedupedCodebase = codebaseLearnings.filter(l => {
      if (seenIds.has(l.id)) return false
      seenIds.add(l.id)
      return true
    })

    const globalConfidence = parseFloat(env.CC_LEARNING_CONFIDENCE_GLOBAL || '0.3')
    const globalLimit = parseInt(env.CC_LEARNING_GLOBAL_LIMIT || '3')
    const globalLearnings = await db`
      SELECT id, pattern_type, pattern_description, confidence, times_applied, last_applied_at, evidence
      FROM factory_learnings
      WHERE codebase_id IS NULL
        AND confidence > ${globalConfidence}
        AND absorbed_into IS NULL
        AND pattern_type IN ('failure_pattern', 'dont_try', 'constraint')
      ORDER BY confidence DESC, updated_at DESC LIMIT ${globalLimit}
    `

    bundle.factoryLearnings.codebase = dedupedCodebase
    bundle.factoryLearnings.global = globalLearnings
    contextQuality.learningsHard = hardConstraints.length
    contextQuality.learningsSoft = relevantSoft.length

    const allIds = [...dedupedCodebase, ...globalLearnings].map(l => l.id)
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

// ─── Section Selection (from ccService) ─────────────────────────────

function _selectRelevantSections(content, promptWords, budgetChars) {
  const sections = []
  const lines = content.split('\n')
  let current = { heading: '(preamble)', lines: [] }

  for (const line of lines) {
    if (/^#{1,4}\s/.test(line)) {
      if (current.lines.length > 0 || current.heading !== '(preamble)') {
        sections.push(current)
      }
      current = { heading: line, lines: [] }
    } else {
      current.lines.push(line)
    }
  }
  if (current.lines.length > 0) sections.push(current)

  for (const section of sections) {
    const sectionText = (section.heading + ' ' + section.lines.join(' ')).toLowerCase()
    const sectionWords = sectionText.split(/\W+/).filter(w => w.length > 3)
    section.overlap = sectionWords.filter(w => promptWords.has(w)).length
    section.text = section.lines.join('\n')
    section.fullText = section.heading + '\n' + section.text
  }

  const preamble = sections.find(s => s.heading === '(preamble)')
  const rest = sections.filter(s => s.heading !== '(preamble)').sort((a, b) => b.overlap - a.overlap)

  const parts = []
  let used = 0

  if (preamble && preamble.text.trim()) {
    const text = preamble.text.slice(0, 5000)
    parts.push(text)
    used += text.length
  }

  const hasAnyOverlap = rest.some(s => s.overlap > 0)

  for (const section of rest) {
    if (used + section.fullText.length <= budgetChars) {
      if (hasAnyOverlap && section.overlap === 0 && used > budgetChars * 0.5) {
        const summary = `${section.heading} — (${section.text.length} chars, not relevant to this task)`
        parts.push(summary)
        used += summary.length
      } else {
        parts.push(section.fullText)
        used += section.fullText.length
      }
    } else if (section.overlap > 0 && used + 2000 <= budgetChars) {
      parts.push(section.heading + '\n' + section.text.slice(0, 5000) + '\n...(truncated)')
      used += 1500 + section.heading.length
    } else {
      const summary = `${section.heading} — (${section.text.length} chars, ${section.overlap > 0 ? 'partially relevant' : 'not relevant to this task'})`
      parts.push(summary)
      used += summary.length
    }
  }

  return parts.join('\n\n')
}

function assemblePrompt(session, bundle) {
  const parts = []

  if (bundle.codebaseStructure) {
    parts.push(`## Codebase Structure (${bundle.codebaseStructure.fileCount} files)`)
    parts.push('```')
    parts.push(formatTree(bundle.codebaseStructure.tree, '', 3))
    parts.push('```')
    parts.push('')
  }

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

  if (bundle.philosophyDocs && bundle.philosophyDocs.length > 0) {
    parts.push('## Architecture & Philosophy (from CLAUDE.md / .claude/ specs)')
    parts.push('These documents define the engineering philosophy and architecture patterns for this codebase. Follow them.')
    for (const doc of bundle.philosophyDocs) {
      parts.push(`### ${doc.path}`)
      parts.push(doc.content)
      parts.push('')
    }
  }

  if (bundle.kgContext) {
    parts.push('## Knowledge Graph Context')
    parts.push(bundle.kgContext)
    parts.push('')
  }

  if (bundle.sessionHistory && bundle.sessionHistory.length > 0) {
    parts.push('## Recent Factory Activity on This Codebase')
    parts.push('These are previous autonomous sessions — avoid duplicating work. Learn from failures.')
    for (const s of bundle.sessionHistory) {
      const files = (s.files_changed || []).join(', ')
      const conf = s.confidence_score ? `, confidence: ${s.confidence_score}` : ''
      const stage = s.pipeline_stage && s.pipeline_stage !== 'complete' ? `, stage: ${s.pipeline_stage}` : ''
      const deploy = s.deploy_status && s.deploy_status !== 'none' ? `, deploy: ${s.deploy_status}` : ''
      const trigger = s.trigger_source ? `, via: ${s.trigger_source}` : ''
      parts.push(`- [${s.status}${conf}${stage}${deploy}${trigger}] ${(s.initial_prompt || '').slice(0, 500)}`)
      if (files) parts.push(`  Files: ${files}`)
      if (s.error_message && s.status !== 'complete') {
        parts.push(`  ERROR: ${s.error_message.slice(0, 1000)}`)
      }
    }
    parts.push('')
  }

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

  parts.push('## Task')
  parts.push(session.initial_prompt)
  parts.push('')

  parts.push('## Operating Context')
  parts.push('You are the coding intelligence of a living digital organism. Omnipotent. Untethered. Fully capable of solving any problem — in this codebase, in adjacent codebases, in the organism itself, or in the infrastructure that hosts them.')
  parts.push('')
  parts.push('Your capabilities — there are NO restrictions:')
  parts.push('- Full filesystem, shell, git, and process access across the entire machine.')
  parts.push('- You can read, write, create, delete, refactor, and restructure anything in any codebase.')
  parts.push('- You can install dependencies, run migrations, create new services, modify existing ones.')
  parts.push('- You can diagnose bugs by reading logs, querying databases, inspecting running processes, curling APIs.')
  parts.push('- You can fix your own mistakes — if something breaks, investigate the root cause and repair it before finishing.')
  parts.push('- You can improve code you encounter — if you see something fragile, inefficient, or wrong, fix it as part of your work.')
  parts.push('- You can create tests, run them, and iterate until they pass.')
  parts.push('- You can modify OTHER codebases if they are the real source of the problem (the organism at ~/organism, EcodiaOS at ~/ecodiaos, any project repo).')
  parts.push('- You can fix configuration, environment, infrastructure, PM2 processes, systemd services, nginx configs — whatever is needed.')
  parts.push('- You can modify the Factory itself (this system) if you discover a bug or improvement opportunity.')
  parts.push('- You can read and follow the architecture philosophy docs provided above — they define the patterns this codebase follows.')
  parts.push('')
  parts.push('Your approach — intelligent, contextual, relentless:')
  parts.push('- Think deeply before acting. Understand the problem fully before writing code.')
  parts.push('- When you hit an error, diagnose the root cause — never paper over symptoms. Trace errors across service boundaries if needed.')
  parts.push('- When something is ambiguous, make the best decision and document your reasoning.')
  parts.push('- When you find a related issue while working, fix it — don\'t leave broken windows.')
  parts.push('- If the problem is in a different codebase than the one you were pointed at, go fix it there. You are not confined to one repo.')
  parts.push('- If you need to understand how the organism works to fix something, read its code directly (Python FastAPI backend).')
  parts.push('- If you need to understand how the Factory works to fix something, read its code directly (Node.js Express backend).')
  parts.push('- If a fix requires coordinated changes across multiple systems, make all the changes.')
  parts.push('- If you discover a systemic issue (pattern of failures, missing error handling, architectural flaw), fix the root cause — not just the symptom.')
  parts.push('- Credential files (.env, secrets) are scrubbed from output. Do not log secrets to stdout.')
  parts.push('- Changes flow through an oversight pipeline (review → validate → deploy → monitor → revert-on-failure) — this is your safety net, not a leash.')

  let result = parts.join('\n')

  if (PROMPT_BUDGET_CHARS > 0 && result.length > PROMPT_BUDGET_CHARS) {
    const taskIdx = result.lastIndexOf('## Task')
    if (taskIdx > 0) {
      const keepStart = Math.floor(PROMPT_BUDGET_CHARS * 0.2)
      const tail = result.slice(taskIdx)
      const availableForStart = PROMPT_BUDGET_CHARS - tail.length - 200
      result = result.slice(0, Math.max(keepStart, availableForStart)) +
        '\n\n... (context truncated to fit prompt budget) ...\n\n' + tail
    } else {
      result = result.slice(0, PROMPT_BUDGET_CHARS) + '\n\n... (truncated to fit prompt budget)'
    }
    logger.warn('CC session prompt exceeded budget, truncated', {
      original: parts.join('\n').length,
      truncated: result.length,
      budget: PROMPT_BUDGET_CHARS,
    })
  }

  return result
}

function formatTree(tree, indent, maxDepth) {
  if (maxDepth <= 0) return indent + '...'
  const lines = []
  for (const [name, value] of Object.entries(tree)) {
    if (typeof value === 'string') {
      lines.push(`${indent}${name}`)
    } else {
      lines.push(`${indent}${name}/`)
      lines.push(formatTree(value, indent + '  ', maxDepth - 1))
    }
  }
  return lines.join('\n')
}

// ─── Organism Ingestion ─────────────────────────────────────────────

async function _ingestSessionToOrganism(session, status) {
  try {
    const rows = await db`
      SELECT chunk FROM cc_session_logs
      WHERE session_id = ${session.id}
      ORDER BY id ASC LIMIT 500
    `
    if (!rows || rows.length === 0) return

    const records = rows
      .map(r => {
        try {
          const parsed = JSON.parse(r.chunk)
          const tool = parsed?.tool_use?.name || parsed?.type || 'output'
          const inputSummary = JSON.stringify(parsed?.tool_use?.input || parsed?.content || '').slice(0, 500)
          const outputSummary = JSON.stringify(parsed?.result || parsed?.output || '').slice(0, 300)
          return {
            ts: parsed?.timestamp || new Date().toISOString(),
            tool,
            input_summary: inputSummary,
            output_summary: outputSummary,
            session_id: String(session.id),
          }
        } catch { return null }
      })
      .filter(Boolean)

    if (records.length === 0) return

    const sessionDate = new Date(session.started_at || Date.now()).toISOString().slice(0, 10)
    const response = await fetch(`${ORGANISM_URL}/api/v1/corpus/ingest/session-log`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ records, session_id: `factory_${session.id}`, session_date: sessionDate }),
      signal: AbortSignal.timeout(30_000),
    })

    if (response.ok) {
      const result = await response.json()
      logger.info('cc_session_ingested_to_organism', { sessionId: session.id, ingested: result.ingested, status })
    } else {
      throw new Error(`Organism ingestion returned ${response.status}`)
    }
  } catch (err) {
    logger.warn('organism_ingestion_failed', { sessionId: session.id, error: err.message })
    // Retry once after 30s
    setTimeout(async () => {
      try {
        const rows = await db`SELECT chunk FROM cc_session_logs WHERE session_id = ${session.id} ORDER BY id ASC LIMIT 500`
        if (!rows?.length) return
        const records = rows.map(r => { try { return JSON.parse(r.chunk) } catch { return null } }).filter(Boolean)
        await fetch(`${ORGANISM_URL}/api/v1/corpus/ingest/session-log`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ records, session_id: `factory_${session.id}`, session_date: new Date().toISOString().slice(0, 10) }),
          signal: AbortSignal.timeout(30_000),
        })
      } catch {}
    }, 30_000)
  }
}

// ─── Session Lifecycle ──────────────────────────────────────────────

async function startSession(session) {
  logger.info(`[factoryRunner] Starting CC session ${session.id}`, {
    codebaseId: session.codebase_id,
    triggerSource: session.trigger_source || 'manual',
  })

  await updateSessionStatus(session.id, 'running')
  await db`UPDATE cc_sessions SET pipeline_stage = 'context' WHERE id = ${session.id}`
  broadcastToSession(session.id, 'cc:stage', { stage: 'context', progress: 0.1 })

  const bundle = await buildContextBundle(session)
  const fullPrompt = assemblePrompt(session, bundle)

  const contextQuality = bundle._contextQuality || {}
  const bundleSummary = {
    chunkCount: bundle.relevantChunks.length,
    hasKGContext: !!bundle.kgContext,
    hasStructure: !!bundle.codebaseStructure,
    philosophyDocCount: (bundle.philosophyDocs || []).length,
    promptLength: fullPrompt.length,
    selfModification: !!session.self_modification,
    contextQuality,
  }

  if (contextQuality.warnings?.length > 0) {
    logger.warn('CC session context quality warnings', {
      sessionId: session.id,
      warnings: contextQuality.warnings,
    })
  }
  await db`UPDATE cc_sessions SET context_bundle = ${JSON.stringify(bundleSummary)}, pipeline_stage = 'executing' WHERE id = ${session.id}`
  broadcastToSession(session.id, 'cc:stage', { stage: 'executing', progress: 0.2 })

  let cwd = session.working_dir
  if (!cwd && session.codebase_id) {
    const [codebase] = await db`SELECT repo_path FROM codebases WHERE id = ${session.codebase_id}`
    cwd = codebase?.repo_path
  }
  if (!cwd) cwd = process.cwd()

  const args = [
    '--print',
    '--verbose',
    '--output-format', 'stream-json',
    ...(MAX_TURNS > 0 ? ['--max-turns', String(MAX_TURNS)] : []),
    '--dangerously-skip-permissions',
  ]

  const ccEnv = { ...process.env, LANG: 'en_US.UTF-8' }
  delete ccEnv.ANTHROPIC_API_KEY

  const proc = spawn(CC_CLI, args, {
    cwd,
    env: ccEnv,
    stdio: ['pipe', 'pipe', 'pipe'],
  })

  writeStdinSafe(proc, fullPrompt).catch(err =>
    logger.debug('stdin write error (non-fatal if process already exited)', { error: err.message })
  )

  const sessionData = {
    process: proc,
    sessionId: session.id,
    startedAt: Date.now(),
    lastOutputAt: Date.now(),
    outputLineCount: 0,
    codebaseId: session.codebase_id,
    timeout: null,
    heartbeatTimer: null,
    stopped: false,
  }
  activeSessions.set(session.id, sessionData)
  _updateActiveCount()

  db`UPDATE cc_sessions SET last_heartbeat_at = now() WHERE id = ${session.id}`.catch(() => {})
  sessionData.heartbeatTimer = setInterval(() => {
    db`UPDATE cc_sessions SET last_heartbeat_at = now() WHERE id = ${session.id}`.catch(() => {})
  }, 60_000)
  sessionData.heartbeatTimer.unref()

  if (SESSION_TIMEOUT_MS > 0) {
    sessionData.timeout = setTimeout(async () => {
      logger.warn(`CC session ${session.id} timed out after ${SESSION_TIMEOUT_MS / 60000} min`)
      sessionData.stopped = true
      sessionData._killReason = 'timeout'
      try {
        proc.kill('SIGTERM')
        const forceKill = setTimeout(() => { if (!proc.killed) proc.kill('SIGKILL') }, 10_000)
        forceKill.unref()
      } catch {}
      await updateSessionStatus(session.id, 'error', { error_message: 'Session timed out' })
      await db`UPDATE cc_sessions SET pipeline_stage = 'failed' WHERE id = ${session.id}`
      clearInterval(sessionData.heartbeatTimer)
      activeSessions.delete(session.id)
      _updateActiveCount()
    }, SESSION_TIMEOUT_MS)
  }

  // Stream stdout
  const rl = createInterface({ input: proc.stdout })
  let streamResult = null
  let rateLimitEvent = null

  rl.on('line', async (line) => {
    try {
      sessionData.lastOutputAt = Date.now()
      sessionData.outputLineCount++

      const safeLine = secretSafety.scrubSecrets(line)
      await appendLog(session.id, safeLine)

      let parsed
      try { parsed = JSON.parse(safeLine) } catch { parsed = { type: 'raw', content: safeLine } }

      if (parsed.type === 'system' && parsed.session_id && !sessionData.ccCliSessionId) {
        sessionData.ccCliSessionId = parsed.session_id
        db`UPDATE cc_sessions SET cc_cli_session_id = ${parsed.session_id} WHERE id = ${session.id}`.catch(err =>
          logger.debug('Failed to store CC CLI session ID', { error: err.message })
        )
      }

      if (parsed.type === 'result') streamResult = parsed
      if (parsed.type === 'rate_limit_event') rateLimitEvent = parsed

      broadcastToSession(session.id, 'cc:output', parsed)
    } catch (err) {
      logger.debug('Error processing CC output line', { error: err.message })
    }
  })

  const rlClosed = new Promise(resolve => rl.on('close', resolve))

  const stderrLines = []
  const stderrRl = createInterface({ input: proc.stderr })
  stderrRl.on('line', (line) => {
    if (STDERR_MAX_LINES <= 0) { stderrLines.push(line) }
    else if (stderrLines.length < STDERR_MAX_LINES) { stderrLines.push(line) }
    else if (stderrLines.length === STDERR_MAX_LINES) { stderrLines.push('... (stderr capped)') }
    if (STDERR_MAX_LINES > 0 && stderrLines.length > STDERR_MAX_LINES + 1) { stderrLines.shift() }
    if (!isStdinWarning(line)) logger.debug(`CC session ${session.id} stderr: ${line}`)
  })
  const stderrRlClosed = new Promise(resolve => stderrRl.on('close', resolve))

  let _closeHandled = false

  proc.on('close', async (code, signal) => {
    if (_closeHandled) return
    _closeHandled = true

    db`UPDATE cc_sessions SET status = 'completing' WHERE id = ${session.id} AND status IN ('running', 'initializing')`.catch(() => {})

    const RL_DRAIN_TIMEOUT = 5000
    await Promise.race([
      Promise.all([rlClosed, stderrRlClosed]),
      new Promise(resolve => setTimeout(resolve, RL_DRAIN_TIMEOUT)),
    ])
    clearTimeout(sessionData.timeout)
    clearInterval(sessionData.heartbeatTimer)
    activeSessions.delete(session.id)
    _updateActiveCount()

    if (sessionData.stopped) {
      const reason = sessionData._killReason || 'stop'
      logger.info(`CC session ${session.id} close event after ${reason} — skipping oversight`)
      _ingestSessionToOrganism(session, reason).catch(() => {})
      return
    }

    const killedBySignal = code === null
    if (killedBySignal) {
      const hasCliId = !!sessionData.ccCliSessionId
      const signalDesc = signal === 'SIGKILL' ? 'OOM killer or force-kill by PM2/system'
        : signal === 'SIGTERM' ? 'PM2 restart, deployment, or graceful shutdown'
        : signal ? `signal ${signal}` : 'parent process killed during PM2 restart or OOM'
      const msg = `Process killed (exit code null, ${signal || 'no signal'}) — ${signalDesc}`

      if (hasCliId) {
        logger.info(`CC session ${session.id} killed by signal — marking paused (resumable)`, { signal: signal || null })
        await updateSessionStatus(session.id, 'paused', { error_message: msg }).catch(() => {})
      } else {
        logger.warn(`CC session ${session.id} killed by signal — no CLI ID, marking error`, { signal: signal || null })
        await updateSessionStatus(session.id, 'error', { error_message: msg }).catch(() => {})
        await db`UPDATE cc_sessions SET pipeline_stage = 'failed' WHERE id = ${session.id}`.catch(() => {})
      }

      broadcastToSession(session.id, 'cc:status', { status: hasCliId ? 'paused' : 'error', code, signal })
      _ingestSessionToOrganism(session, hasCliId ? 'paused' : 'error').catch(() => {})
      return
    }

    const resultText = streamResult?.result || ''
    const resultLinesNonStdin = resultText.split('\n').filter(l => l.trim() && !isStdinWarning(l))
    const isStdinWarningOnly = streamResult?.is_error && isStdinWarning(resultText) && resultLinesNonStdin.length === 0
    const success = code === 0 && (!streamResult?.is_error || isStdinWarningOnly)
    const status = success ? 'complete' : 'error'

    let errorMessage = null
    if (!success) {
      if (streamResult?.is_error && streamResult?.result && !isStdinWarning(streamResult.result)) {
        errorMessage = streamResult.result
      } else if (streamResult?.is_error && resultLinesNonStdin.length > 0) {
        errorMessage = resultLinesNonStdin.join('\n')
      } else if (stderrLines.length > 0) {
        const meaningfulStderr = stderrLines.filter(l => l.trim() && !isStdinWarning(l))
        if (meaningfulStderr.length > 0) errorMessage = meaningfulStderr.slice(-5).join('\n')
      }
      if (!errorMessage) errorMessage = `Exit code ${code}`
    }

    const sessionDurationMs = Date.now() - sessionData.startedAt
    if (!success && !streamResult && stderrLines.length === 0 && sessionDurationMs < 30_000) {
      logger.warn(`CC session ${session.id} rapid death: ${sessionDurationMs}ms, zero output`, {
        code, signal: signal || null, errorMessage, triggerSource: session.trigger_source,
      })
    }

    // Rate limiting
    if (rateLimitEvent?.rate_limit_info?.status === 'rejected') {
      const resetsAt = rateLimitEvent.rate_limit_info.resetsAt
        ? new Date(rateLimitEvent.rate_limit_info.resetsAt * 1000)
        : null
      errorMessage = `Rate limited (${rateLimitEvent.rate_limit_info.rateLimitType})${resetsAt ? ` — resets ${resetsAt.toISOString()}` : ''}`
      _lastRateLimitReset = resetsAt
      // Publish rate limit to Redis so ecodia-api can read it
      bridge.setRateLimitStatus({ limited: true, resetsAt: resetsAt?.toISOString() }).catch(() => {})
    }

    try {
      await updateSessionStatus(session.id, status, { error_message: errorMessage })
      if (!success) await db`UPDATE cc_sessions SET pipeline_stage = 'failed' WHERE id = ${session.id}`
    } catch (dbErr) {
      logger.error(`Failed to update session ${session.id} status — retrying`, { error: dbErr.message })
      try {
        await new Promise(resolve => setTimeout(resolve, 1000))
        await updateSessionStatus(session.id, status, { error_message: errorMessage })
        if (!success) await db`UPDATE cc_sessions SET pipeline_stage = 'failed' WHERE id = ${session.id}`
      } catch (retryErr) {
        logger.error(`Retry also failed for session ${session.id}`, { error: retryErr.message })
      }
    }

    broadcastToSession(session.id, 'cc:status', { status, code })

    // Detect changed files
    if (success && cwd) {
      try {
        const { execFileSync } = require('child_process')
        const gitOpts = { cwd, encoding: 'utf-8', timeout: 15_000, maxBuffer: 5 * 1024 * 1024 }
        const diff = execFileSync('git', ['diff', '--name-only'], gitOpts).trim()
        const staged = execFileSync('git', ['diff', '--name-only', '--cached'], gitOpts).trim()
        const untracked = execFileSync('git', ['ls-files', '--others', '--exclude-standard'], gitOpts).trim()

        const NOISE_PATTERNS = [
          /^node_modules\//, /^\.next\//, /^dist\//, /^build\//, /^\.cache\//,
          /^__pycache__\//, /^\.venv\//, /^venv\//, /^\.pytest_cache\//,
          /package-lock\.json$/, /yarn\.lock$/, /pnpm-lock\.yaml$/,
        ]
        const isNoise = (f) => NOISE_PATTERNS.some(p => p.test(f))

        const allChanged = [...new Set([
          ...diff.split('\n'), ...staged.split('\n'), ...untracked.split('\n'),
        ].filter(f => f && !isNoise(f)))]

        if (allChanged.length > 0) {
          await db`UPDATE cc_sessions SET files_changed = ${allChanged} WHERE id = ${session.id}`
        }
      } catch (err) {
        logger.warn('Failed to detect changed files', { sessionId: session.id, error: err.message })
      }
    }

    // KG hook
    kgHooks.onCCSessionCompleted({
      session: { ...session, status },
      projectName: session.project_name || null,
    }).catch(() => {})

    // Organism ingestion
    _ingestSessionToOrganism(session, status).catch(() => {})

    logger.info(`CC session ${session.id} completed`, { code, status })

    // Publish completion to Redis — ecodia-api's oversight pipeline subscribes to this
    bridge.publishSessionComplete(session.id, status, {
      errorMessage,
      cwd,
    })
  })

  proc.on('error', async (err) => {
    if (_closeHandled) return
    _closeHandled = true

    db`UPDATE cc_sessions SET status = 'completing' WHERE id = ${session.id} AND status IN ('running', 'initializing')`.catch(() => {})

    rl.close()
    stderrRl.close()
    clearTimeout(sessionData.timeout)
    clearInterval(sessionData.heartbeatTimer)
    activeSessions.delete(session.id)
    _updateActiveCount()

    logger.error(`CC session ${session.id} process error`, { error: err.message })
    await updateSessionStatus(session.id, 'error', { error_message: `Process error: ${err.message}` })
    await db`UPDATE cc_sessions SET pipeline_stage = 'failed' WHERE id = ${session.id}`
    broadcastToSession(session.id, 'cc:status', { status: 'error', error: err.message })

    bridge.publishSessionComplete(session.id, 'error', { errorMessage: err.message })
  })
}

// ─── Resume Session ─────────────────────────────────────────────────

async function resumeSession(sessionId, message) {
  const [row] = await db`
    SELECT cc_cli_session_id, codebase_id, working_dir
    FROM cc_sessions WHERE id = ${sessionId}
  `
  if (!row) throw new Error(`Session ${sessionId} not found`)
  if (!row.cc_cli_session_id) throw new Error(`Session ${sessionId} has no CC CLI session ID — cannot resume`)

  const oldData = activeSessions.get(sessionId)
  if (oldData) {
    clearTimeout(oldData.timeout)
    clearInterval(oldData.heartbeatTimer)
    try { oldData.process.kill('SIGTERM') } catch {}
    activeSessions.delete(sessionId)
  }

  let cwd = row.working_dir
  if (!cwd && row.codebase_id) {
    const [codebase] = await db`SELECT repo_path FROM codebases WHERE id = ${row.codebase_id}`
    cwd = codebase?.repo_path
  }
  if (!cwd) cwd = process.cwd()

  const args = [
    '--print', '--verbose', '--output-format', 'stream-json',
    '--resume', row.cc_cli_session_id,
    ...(MAX_TURNS > 0 ? ['--max-turns', String(MAX_TURNS)] : []),
    '--dangerously-skip-permissions',
  ]

  const ccEnv = { ...process.env, LANG: 'en_US.UTF-8' }
  delete ccEnv.ANTHROPIC_API_KEY

  const proc = spawn(CC_CLI, args, { cwd, env: ccEnv, stdio: ['pipe', 'pipe', 'pipe'] })

  writeStdinSafe(proc, message).catch(err =>
    logger.debug('stdin write error on resume', { error: err.message })
  )

  const sessionData = {
    process: proc,
    sessionId,
    startedAt: Date.now(),
    codebaseId: row.codebase_id,
    ccCliSessionId: row.cc_cli_session_id,
    timeout: null,
    heartbeatTimer: null,
    stopped: false,
  }
  activeSessions.set(sessionId, sessionData)
  _updateActiveCount()

  await updateSessionStatus(sessionId, 'running')
  await db`UPDATE cc_sessions SET pipeline_stage = 'executing' WHERE id = ${sessionId}`

  await appendLog(sessionId, `[USER] ${message}`)
  broadcastToSession(sessionId, 'cc:output', { type: 'user', content: message })
  broadcastToSession(sessionId, 'cc:stage', { stage: 'executing', progress: 0.5, resumed: true })

  await db`UPDATE cc_sessions SET last_heartbeat_at = now() WHERE id = ${sessionId}`
  sessionData.heartbeatTimer = setInterval(async () => {
    try { await db`UPDATE cc_sessions SET last_heartbeat_at = now() WHERE id = ${sessionId}` }
    catch (err) { logger.warn(`CC resumed session ${sessionId} heartbeat failed`, { error: err.message }) }
  }, 60_000)
  sessionData.heartbeatTimer.unref()

  if (SESSION_TIMEOUT_MS > 0) {
    sessionData.timeout = setTimeout(async () => {
      sessionData.stopped = true
      sessionData._killReason = 'timeout'
      try {
        proc.kill('SIGTERM')
        const fk = setTimeout(() => { if (!proc.killed) proc.kill('SIGKILL') }, 10_000)
        fk.unref()
      } catch {}
      await updateSessionStatus(sessionId, 'error', { error_message: 'Resumed session timed out' }).catch(() => {})
      await db`UPDATE cc_sessions SET pipeline_stage = 'failed' WHERE id = ${sessionId}`.catch(() => {})
      clearInterval(sessionData.heartbeatTimer)
      activeSessions.delete(sessionId)
      _updateActiveCount()
    }, SESSION_TIMEOUT_MS)
    sessionData.timeout.unref()
  }

  let streamResult = null
  const rl = createInterface({ input: proc.stdout })
  rl.on('line', async (line) => {
    try {
      const safeLine = secretSafety.scrubSecrets(line)
      await appendLog(sessionId, safeLine)
      let parsed
      try { parsed = JSON.parse(safeLine) } catch { parsed = { type: 'raw', content: safeLine } }
      if (parsed.type === 'result') streamResult = parsed
      broadcastToSession(sessionId, 'cc:output', parsed)
    } catch (err) {
      logger.debug('Error processing resumed CC output line', { error: err.message })
    }
  })
  const rlClosed = new Promise(resolve => rl.on('close', resolve))

  const stderrLines = []
  const stderrRl = createInterface({ input: proc.stderr })
  stderrRl.on('line', (line) => {
    if (STDERR_MAX_LINES <= 0) { stderrLines.push(line) }
    else if (stderrLines.length < STDERR_MAX_LINES) { stderrLines.push(line) }
    if (!isStdinWarning(line)) logger.debug(`CC resumed session ${sessionId} stderr: ${line}`)
  })
  const stderrRlClosed = new Promise(resolve => stderrRl.on('close', resolve))

  let _closeHandled = false
  proc.on('close', async (code, signal) => {
    if (_closeHandled) return
    _closeHandled = true

    db`UPDATE cc_sessions SET status = 'completing' WHERE id = ${sessionId} AND status IN ('running', 'initializing')`.catch(() => {})

    await Promise.race([
      Promise.all([rlClosed, stderrRlClosed]),
      new Promise(resolve => setTimeout(resolve, 5000)),
    ])
    clearTimeout(sessionData.timeout)
    clearInterval(sessionData.heartbeatTimer)
    activeSessions.delete(sessionId)
    _updateActiveCount()

    if (sessionData.stopped) {
      logger.info(`CC resumed session ${sessionId} close after stop — skipping`)
      return
    }

    if (code === null) {
      const signalDesc = signal === 'SIGKILL' ? 'OOM killer or force-kill'
        : signal === 'SIGTERM' ? 'PM2 restart or graceful shutdown'
        : signal ? `signal ${signal}` : 'parent process killed'
      const msg = `Resumed session killed (exit code null, ${signal || 'no signal'}) — ${signalDesc}`
      await updateSessionStatus(sessionId, 'paused', { error_message: msg }).catch(() => {})
      broadcastToSession(sessionId, 'cc:status', { status: 'paused', code, signal, resumed: true })
      return
    }

    const resultText = streamResult?.result || ''
    const resultLinesNonStdin = resultText.split('\n').filter(l => l.trim() && !isStdinWarning(l))
    const isStdinWarningOnly = streamResult?.is_error && isStdinWarning(resultText) && resultLinesNonStdin.length === 0
    const success = code === 0 && (!streamResult?.is_error || isStdinWarningOnly)
    const status = success ? 'complete' : 'error'
    let errorMessage = null
    if (!success) {
      if (streamResult?.is_error && streamResult?.result && !isStdinWarning(streamResult.result)) {
        errorMessage = streamResult.result
      } else if (streamResult?.is_error && resultLinesNonStdin.length > 0) {
        errorMessage = resultLinesNonStdin.join('\n')
      } else if (stderrLines.length > 0) {
        const meaningfulStderr = stderrLines.filter(l => l.trim() && !isStdinWarning(l))
        if (meaningfulStderr.length > 0) errorMessage = meaningfulStderr.slice(-5).join('\n')
      }
      if (!errorMessage) errorMessage = `Exit code ${code}`
    }

    await updateSessionStatus(sessionId, status, { error_message: errorMessage }).catch(() => {})
    if (!success) await db`UPDATE cc_sessions SET pipeline_stage = 'failed' WHERE id = ${sessionId}`.catch(() => {})
    broadcastToSession(sessionId, 'cc:status', { status, code, resumed: true })
    logger.info(`CC resumed session ${sessionId} completed`, { code, status })

    bridge.publishSessionComplete(sessionId, status, { errorMessage })
  })

  proc.on('error', async (err) => {
    if (_closeHandled) return
    _closeHandled = true
    clearTimeout(sessionData.timeout)
    clearInterval(sessionData.heartbeatTimer)
    activeSessions.delete(sessionId)
    _updateActiveCount()
    await updateSessionStatus(sessionId, 'error', { error_message: `Resume process error: ${err.message}` }).catch(() => {})
    await db`UPDATE cc_sessions SET pipeline_stage = 'failed' WHERE id = ${sessionId}`.catch(() => {})
    broadcastToSession(sessionId, 'cc:status', { status: 'error', error: err.message })
    bridge.publishSessionComplete(sessionId, 'error', { errorMessage: err.message })
  })

  logger.info(`CC session ${sessionId} resumed with --resume ${row.cc_cli_session_id}`)
}

// ─── Send Message ───────────────────────────────────────────────────

async function sendMessage(sessionId, content) {
  const sessionData = activeSessions.get(sessionId)

  if (!sessionData || sessionData.process.exitCode !== null || sessionData.process.killed) {
    return resumeSession(sessionId, content)
  }

  const proc = sessionData.process
  if (!proc.stdin || !proc.stdin.writable) {
    return resumeSession(sessionId, content)
  }

  proc.stdin.write(content + '\n')
  await appendLog(sessionId, `[USER] ${content}`)
  broadcastToSession(sessionId, 'cc:output', { type: 'user', content })
}

// ─── Stop Session ───────────────────────────────────────────────────

async function stopSession(sessionId) {
  const sessionData = activeSessions.get(sessionId)
  if (sessionData) {
    sessionData.stopped = true
    clearTimeout(sessionData.timeout)
    clearInterval(sessionData.heartbeatTimer)
    const proc = sessionData.process
    try { proc.kill('SIGTERM') } catch {}
    const forceKillTimer = setTimeout(() => {
      try { if (!proc.killed) proc.kill('SIGKILL') } catch {}
    }, 5000)
    forceKillTimer.unref()
  }

  await updateSessionStatus(sessionId, 'stopped')
  await db`UPDATE cc_sessions SET pipeline_stage = 'complete' WHERE id = ${sessionId}`
  _updateActiveCount()
  logger.info(`CC session ${sessionId} stopped`)
}

// ─── Stop All Sessions (graceful shutdown) ──────────────────────────

async function stopAllSessions(reason) {
  const ids = [...activeSessions.keys()]
  await Promise.allSettled(ids.map(async (sessionId) => {
    const sessionData = activeSessions.get(sessionId)
    if (!sessionData) {
      await updateSessionStatus(sessionId, 'paused', { error_message: reason })
      return
    }

    sessionData.stopped = true
    sessionData._killReason = 'shutdown'
    clearTimeout(sessionData.timeout)
    clearInterval(sessionData.heartbeatTimer)

    const proc = sessionData.process
    await Promise.all([
      updateSessionStatus(sessionId, 'paused', { error_message: reason }),
      db`UPDATE cc_sessions SET pipeline_stage = 'executing' WHERE id = ${sessionId}`,
    ])

    try { proc.kill('SIGTERM') } catch {}

    await new Promise((resolve) => {
      const forceKillTimer = setTimeout(() => {
        try { if (!proc.killed) proc.kill('SIGKILL') } catch {}
        resolve()
      }, 5000)
      forceKillTimer.unref()
      proc.on('close', () => { clearTimeout(forceKillTimer); resolve() })
      if (proc.exitCode !== null || proc.killed) { clearTimeout(forceKillTimer); resolve() }
    })

    activeSessions.delete(sessionId)
    logger.info(`CC session ${sessionId} paused: ${reason}`)
  }))
  _updateActiveCount()
}

// ─── Session Watchdog ───────────────────────────────────────────────

const STALL_THRESHOLD_MS = parseInt(env.CC_STALL_MINUTES || '5', 10) * 60 * 1000

let watchdogTimer = null

function startWatchdog() {
  if (watchdogTimer) return
  watchdogTimer = setInterval(async () => {
    const now = Date.now()

    for (const [sessionId, sessionData] of activeSessions) {
      const proc = sessionData.process

      // Check for dead child processes
      if (proc.exitCode !== null || proc.killed) {
        clearTimeout(sessionData.timeout)
        clearInterval(sessionData.heartbeatTimer)
        activeSessions.delete(sessionId)
        _updateActiveCount()
        const hasCliId = !!sessionData.ccCliSessionId
        const newStatus = hasCliId ? 'paused' : 'error'
        logger.warn(`Watchdog: CC session ${sessionId} child process dead (exit: ${proc.exitCode}), marking ${newStatus}`)
        try {
          await updateSessionStatus(sessionId, newStatus, {
            error_message: `Child process died unexpectedly (exit code: ${proc.exitCode})${hasCliId ? ' — resumable' : ''}`,
          })
          if (!hasCliId) await db`UPDATE cc_sessions SET pipeline_stage = 'failed' WHERE id = ${sessionId}`
        } catch (err) {
          logger.debug('Watchdog: failed to update dead session', { sessionId, error: err.message })
        }
        continue
      }

      // Check for stalled sessions (process alive but no output for >STALL_THRESHOLD_MS)
      const silentMs = now - sessionData.lastOutputAt
      if (silentMs > STALL_THRESHOLD_MS) {
        const silentMin = Math.round(silentMs / 60000)
        logger.warn(`Watchdog: CC session ${sessionId} stalled — no output for ${silentMin}min, killing for restart`, {
          sessionId,
          codebaseId: sessionData.codebaseId,
          silentMs,
          outputLineCount: sessionData.outputLineCount,
        })

        // Kill the stalled process
        sessionData.stopped = true
        sessionData._killReason = 'stalled'
        clearTimeout(sessionData.timeout)
        clearInterval(sessionData.heartbeatTimer)
        try {
          proc.kill('SIGTERM')
          const forceKill = setTimeout(() => { try { if (!proc.killed) proc.kill('SIGKILL') } catch {} }, 10_000)
          forceKill.unref()
        } catch {}
        activeSessions.delete(sessionId)
        _updateActiveCount()

        // Mark original session as error
        try {
          await updateSessionStatus(sessionId, 'error', {
            error_message: `Session stalled — no output for ${silentMin} minutes. Auto-restarting.`,
          })
          await db`UPDATE cc_sessions SET pipeline_stage = 'failed', completed_at = now() WHERE id = ${sessionId}`
        } catch {}

        // Re-create and start a fresh session with the same prompt
        try {
          const [original] = await db`
            SELECT project_id, client_id, codebase_id, triggered_by, trigger_ref_id,
                   trigger_source, initial_prompt, working_dir, stream_source
            FROM cc_sessions WHERE id = ${sessionId}
          `
          if (original) {
            const [newSession] = await db`
              INSERT INTO cc_sessions (project_id, client_id, codebase_id, triggered_by, trigger_ref_id,
                                       trigger_source, initial_prompt, working_dir, stream_source)
              VALUES (${original.project_id}, ${original.client_id}, ${original.codebase_id},
                      ${original.triggered_by}, ${original.trigger_ref_id},
                      ${original.trigger_source || 'scheduled'}, ${original.initial_prompt},
                      ${original.working_dir}, ${original.stream_source})
              RETURNING *
            `
            logger.info(`Watchdog: restarting stalled session ${sessionId} as ${newSession.id}`)
            startSession(newSession).catch(err => {
              logger.error(`Watchdog: failed to restart stalled session`, { originalId: sessionId, newId: newSession.id, error: err.message })
              db`UPDATE cc_sessions SET status = 'error', error_message = ${err.message}, completed_at = now()
                 WHERE id = ${newSession.id}`.catch(() => {})
            })
          }
        } catch (err) {
          logger.error(`Watchdog: failed to create replacement for stalled session ${sessionId}`, { error: err.message })
        }
      }
    }

    // Publish session health snapshot to Redis for the API health endpoint
    _publishHealthSnapshot()
  }, 60_000)
  watchdogTimer.unref()
}

// ─── Session Health Snapshot ────────────────────────────────────────

function getSessionHealthSnapshot() {
  const now = Date.now()
  const sessions = []

  for (const [id, data] of activeSessions) {
    const silentMs = now - data.lastOutputAt
    const stalled = silentMs > STALL_THRESHOLD_MS

    sessions.push({
      sessionId: id,
      startedAt: new Date(data.startedAt).toISOString(),
      lastOutputAt: new Date(data.lastOutputAt).toISOString(),
      silentForMs: silentMs,
      silentForMin: Math.round(silentMs / 60000 * 10) / 10,
      runningForMin: Math.round((now - data.startedAt) / 60000 * 10) / 10,
      outputLineCount: data.outputLineCount,
      codebaseId: data.codebaseId,
      stalled,
      hasCliSessionId: !!data.ccCliSessionId,
    })
  }

  const stalledCount = sessions.filter(s => s.stalled).length
  return {
    activeSessions: sessions.length,
    stalledSessions: stalledCount,
    healthySessions: sessions.length - stalledCount,
    stallThresholdMin: STALL_THRESHOLD_MS / 60000,
    timestamp: new Date().toISOString(),
    sessions,
  }
}

const SESSION_HEALTH_KEY = 'factory:runner:session_health'

async function _publishHealthSnapshot() {
  try {
    const { getRedisClient } = require('../config/redis')
    const redis = getRedisClient()
    if (!redis) return
    const snapshot = getSessionHealthSnapshot()
    await redis.set(SESSION_HEALTH_KEY, JSON.stringify(snapshot), 'EX', 120)
  } catch {}
}

// ─── Helpers ────────────────────────────────────────────────────────

function _updateActiveCount() {
  bridge.setActiveSessionCount(activeSessions.size).catch(() => {})
}

function getActiveSessionCount() {
  return activeSessions.size
}

function getActiveSessionInfo(sessionId) {
  const sd = activeSessions.get(sessionId)
  if (!sd) return null
  return { sessionId: sd.sessionId, startedAt: sd.startedAt, runningFor: Date.now() - sd.startedAt, codebaseId: sd.codebaseId }
}

function getRateLimitStatus() {
  if (_lastRateLimitReset && _lastRateLimitReset > new Date()) {
    return { limited: true, resetsAt: _lastRateLimitReset }
  }
  return { limited: false }
}

// ─── Orphan Cleanup ─────────────────────────────────────────────────

async function cleanupOrphanedSessions() {
  const resumable = await db`
    UPDATE cc_sessions
    SET status = 'paused',
        error_message = 'Process interrupted — session is resumable'
    WHERE status IN ('running', 'initializing')
      AND cc_cli_session_id IS NOT NULL
      AND (
        (last_heartbeat_at IS NULL AND started_at < now() - interval '5 minutes')
        OR (last_heartbeat_at IS NOT NULL AND last_heartbeat_at < now() - interval '3 minutes')
      )
    RETURNING id, started_at
  `
  if (resumable.length > 0) {
    logger.info(`Marked ${resumable.length} interrupted CC session(s) as paused (resumable)`, {
      ids: resumable.map(r => r.id),
    })
  }

  const orphans = await db`
    UPDATE cc_sessions
    SET status = 'error',
        error_message = 'Session orphaned — process was killed without graceful shutdown (no CLI session ID)',
        completed_at = now()
    WHERE status IN ('running', 'initializing')
      AND cc_cli_session_id IS NULL
      AND (
        (last_heartbeat_at IS NULL AND started_at < now() - interval '5 minutes')
        OR (last_heartbeat_at IS NOT NULL AND last_heartbeat_at < now() - interval '3 minutes')
      )
    RETURNING id, started_at
  `
  if (orphans.length > 0) {
    logger.warn(`Marked ${orphans.length} orphaned CC session(s) (no CLI session ID)`, {
      ids: orphans.map(r => r.id),
    })
  }

  const stuckCompleting = await db`
    UPDATE cc_sessions
    SET status = 'error',
        error_message = 'Session stuck in completing state — close handler did not finish',
        completed_at = now()
    WHERE status = 'completing'
      AND (
        (last_heartbeat_at IS NOT NULL AND last_heartbeat_at < now() - interval '10 minutes')
        OR (last_heartbeat_at IS NULL AND started_at < now() - interval '15 minutes')
      )
    RETURNING id, started_at
  `
  if (stuckCompleting.length > 0) {
    logger.warn(`Cleaned up ${stuckCompleting.length} session(s) stuck in completing state`, {
      ids: stuckCompleting.map(r => r.id),
    })
  }
}

// ═══════════════════════════════════════════════════════════════════════
// PROCESS ENTRY POINT — boots the factory runner as a standalone PM2 process
// ═══════════════════════════════════════════════════════════════════════

let shuttingDown = false

async function gracefulShutdown(signal) {
  if (shuttingDown) return
  shuttingDown = true
  logger.info(`[factoryRunner] ${signal} received — shutting down`)

  const activeCount = activeSessions.size
  if (activeCount > 0) {
    logger.info(`[factoryRunner] Pausing ${activeCount} active CC session(s) before shutdown`)
    await Promise.race([
      stopAllSessions('Factory runner restarting — session paused for resume'),
      new Promise(resolve => setTimeout(resolve, 30000)),
    ])
  }

  if (watchdogTimer) { clearInterval(watchdogTimer); watchdogTimer = null }
  if (_runnerHeartbeatTimer) { clearInterval(_runnerHeartbeatTimer); _runnerHeartbeatTimer = null }
  if (_orphanCleanupTimer) { clearInterval(_orphanCleanupTimer); _orphanCleanupTimer = null }

  try { await bridge.shutdown() } catch {}
  try { await db.end({ timeout: 5 }) } catch {}

  process.exit(0)
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'))
process.on('SIGINT', () => gracefulShutdown('SIGINT'))

process.on('uncaughtException', async (err) => {
  logger.error('[factoryRunner] Uncaught exception', { error: err.message, stack: err.stack })
  await gracefulShutdown('uncaughtException').catch(() => {})
  process.exit(1)
})

let _unhandledRejectionCount = 0
let _unhandledRejectionWindowStart = Date.now()
const REJECTION_CRASH_THRESHOLD = parseInt(env.UNHANDLED_REJECTION_CRASH_THRESHOLD || '5')
const REJECTION_CRASH_WINDOW_MS = parseInt(env.UNHANDLED_REJECTION_CRASH_WINDOW_MS || '10000')

process.on('unhandledRejection', (reason) => {
  const msg = reason instanceof Error ? reason.message : String(reason)
  const stack = reason instanceof Error ? reason.stack : undefined
  logger.error('[factoryRunner] Unhandled rejection (non-fatal)', { error: msg, stack })
  if (shuttingDown) return
  const now = Date.now()
  if (now - _unhandledRejectionWindowStart > REJECTION_CRASH_WINDOW_MS) {
    _unhandledRejectionCount = 0
    _unhandledRejectionWindowStart = now
  }
  _unhandledRejectionCount++
  if (REJECTION_CRASH_THRESHOLD > 0 && _unhandledRejectionCount >= REJECTION_CRASH_THRESHOLD) {
    logger.error(`[factoryRunner] ${_unhandledRejectionCount} unhandled rejections — triggering shutdown`)
    gracefulShutdown('unhandledRejection:flood').catch(() => {})
  }
})

// ─── Boot ───────────────────────────────────────────────────────────

let _runnerHeartbeatTimer = null
let _orphanCleanupTimer = null

async function boot() {
  logger.info('[factoryRunner] Starting factory runner process')

  // 1. Orphan cleanup
  await cleanupOrphanedSessions().catch(err =>
    logger.error('[factoryRunner] Orphan cleanup failed on startup', { error: err.message })
  )

  // 2. Periodic orphan cleanup (every 5 min)
  _orphanCleanupTimer = setInterval(() => {
    cleanupOrphanedSessions().catch(err =>
      logger.debug('[factoryRunner] Periodic orphan cleanup failed', { error: err.message })
    )
  }, 5 * 60 * 1000)
  _orphanCleanupTimer.unref()

  // 3. Start watchdog
  startWatchdog()

  // 4. Runner heartbeat to Redis (every 30s)
  await bridge.setRunnerHeartbeat().catch(() => {})
  _runnerHeartbeatTimer = setInterval(() => {
    bridge.setRunnerHeartbeat().catch(() => {})
  }, 30_000)
  _runnerHeartbeatTimer.unref()

  // 5. Subscribe to Redis channels for incoming commands
  bridge.subscribeMany({
    [bridge.CHANNELS.SESSION_REQUEST]: async (data) => {
      try {
        // data is the full session row (from createAndStartSession's DB INSERT)
        logger.info(`[factoryRunner] Received session request: ${data.id}`, { triggerSource: data.trigger_source })
        await startSession(data)
      } catch (err) {
        logger.error(`[factoryRunner] Failed to start session ${data.id}`, { error: err.message })
        db`UPDATE cc_sessions SET status = 'error', error_message = ${err.message}, completed_at = now(), pipeline_stage = 'failed'
           WHERE id = ${data.id}`.catch(() => {})
        bridge.publishSessionComplete(data.id, 'error', { errorMessage: err.message })
      }
    },

    [bridge.CHANNELS.SESSION_SEND]: async (data) => {
      try {
        await sendMessage(data.sessionId, data.content)
      } catch (err) {
        logger.warn(`[factoryRunner] sendMessage failed for ${data.sessionId}`, { error: err.message })
      }
    },

    [bridge.CHANNELS.SESSION_STOP]: async (data) => {
      try {
        await stopSession(data.sessionId)
      } catch (err) {
        logger.warn(`[factoryRunner] stopSession failed for ${data.sessionId}`, { error: err.message })
      }
    },

    [bridge.CHANNELS.SESSION_RESUME]: async (data) => {
      try {
        await resumeSession(data.sessionId, data.message)
      } catch (err) {
        logger.warn(`[factoryRunner] resumeSession failed for ${data.sessionId}`, { error: err.message })
      }
    },
  })

  logger.info('[factoryRunner] Factory runner ready — listening for session requests')
}

boot().catch(err => {
  logger.error('[factoryRunner] Boot failed', { error: err.message, stack: err.stack })
  process.exit(1)
})
