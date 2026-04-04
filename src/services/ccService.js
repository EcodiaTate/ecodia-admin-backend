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

// Codebase-level lock — prevents two CC sessions from writing to the same repo concurrently.
// Maps codebaseId → { sessionId, resolve } so the next session can wait or fail fast.
const _codebaseLocks = new Map()

function acquireCodebaseLock(codebaseId, sessionId) {
  if (!codebaseId) return true  // no codebase = no lock needed
  const existing = _codebaseLocks.get(codebaseId)
  if (existing && existing.sessionId !== sessionId) {
    return false  // another session holds the lock
  }
  _codebaseLocks.set(codebaseId, { sessionId })
  return true
}

function releaseCodebaseLock(codebaseId, sessionId) {
  if (!codebaseId) return
  const lock = _codebaseLocks.get(codebaseId)
  if (lock && lock.sessionId === sessionId) {
    _codebaseLocks.delete(codebaseId)
  }
}

// Rate limit tracking — prevents spawning sessions when CLI is rate-limited
let _lastRateLimitReset = null

// Prompt budget — 0 = unlimited (let full context flow to CC).
// Non-zero: cap total assembled prompt chars to prevent exceeding CC's context window.
const PROMPT_BUDGET_CHARS = parseInt(env.CC_PROMPT_BUDGET_CHARS || '0', 10)

// Stderr cap — 0 = unlimited (capture everything for full observability)
const STDERR_MAX_LINES = parseInt(env.CC_STDERR_MAX_LINES || '0', 10)

const CC_CLI = env.CLAUDE_CLI_PATH || 'claude'
const MAX_TURNS = env.CC_MAX_TURNS ? parseInt(env.CC_MAX_TURNS, 10) : 0  // 0 = unlimited (flag omitted)
const _timeoutMinutes = parseInt(env.CC_TIMEOUT_MINUTES || '0', 10)
const SESSION_TIMEOUT_MS = _timeoutMinutes > 0 ? _timeoutMinutes * 60 * 1000 : 0  // 0 = no timeout

// ─── Context Bundle Builder ─────────────────────────────────────────

async function buildContextBundle(session) {
  const bundle = {
    codebaseStructure: null,
    relevantChunks: [],
    kgContext: null,
    prompt: session.initial_prompt,
  }

  // Context quality report — tracks what loaded vs failed so the Cortex
  // and oversight pipeline can see exactly what context a session had.
  // This is the difference between "it had full context" and "it was blind".
  const contextQuality = {
    codebaseStructure: 'skipped',  // loaded | failed | skipped
    relevantChunks: 0,
    kgContext: 'skipped',
    philosophyDocs: 0,
    philosophyDocsFailed: 0,
    sessionHistory: 0,
    learningsHard: 0,
    learningsSoft: 0,
    learningMatchMethod: 'none',   // semantic | keyword | fallback | none
    warnings: [],
  }
  bundle._contextQuality = contextQuality

  // Get codebase context if linked
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
      // Semantic search for relevant code
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

  // Get KG context
  try {
    const kgContext = await kg.getContext(session.initial_prompt)
    bundle.kgContext = kgContext
    contextQuality.kgContext = kgContext ? 'loaded' : 'empty'
  } catch (err) {
    contextQuality.kgContext = 'failed'
    contextQuality.warnings.push(`KG context failed: ${err.message}`)
    logger.warn('Failed to get KG context for CC session', { error: err.message, sessionId: session.id })
  }

  // Get recent Factory session history for this codebase
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

  // Get CLAUDE.md and spec files for the codebase — these are the architecture
  // philosophy docs that guide every decision. Without them, CC sessions are
  // smart but context-blind: they don't know the patterns to follow.
  //
  // Task-aware loading: instead of blindly truncating at N chars, we split
  // docs into sections (## headings) and score each section for relevance
  // to the current task prompt. High-relevance sections get full content;
  // low-relevance sections get a one-line summary. This means CC sessions
  // targeting "deployment" get the deployment sections in full, not the
  // first 4000 chars of the file (which might be about email triage).
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

        // CLAUDE.md files (top-level and subdirectories)
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
          } catch { /* file doesn't exist for this codebase */ }
        }

        // .claude/ spec files — architecture specs that encode deep system knowledge
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
        } catch { /* no .claude/ directory */ }

        // Warn if no philosophy docs loaded at all
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

  // Get factory learnings (cross-session knowledge)
  // Two categories injected:
  // 1. Hard constraints (failure_pattern, dont_try, constraint) — always injected for this codebase
  // 2. Relevance-matched learnings — keyword overlap with current task prompt
  bundle.factoryLearnings = { codebase: [], global: [] }
  try {
    const promptLower = (session.initial_prompt || '').toLowerCase()
    const promptWords = new Set(promptLower.split(/\W+/).filter(w => w.length > 3))

    contextQuality.sessionHistory = bundle.sessionHistory.length

    // Hard constraints: always inject — these are "don't do X" learnings that should never be missed
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

    // Soft learnings: two-tier matching
    // Tier 1: Semantic similarity (if embeddings exist) — catches "deploy health" ↔ "post-deploy monitoring"
    // Tier 2: Keyword overlap fallback — catches exact term matches
    let relevantSoft = []

    // Try semantic matching first (uses same embedding infra as codebase intelligence)
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

        const softConfidence = parseFloat(env.CC_LEARNING_CONFIDENCE_SOFT || '0.3')
        const softLimit = parseInt(env.CC_LEARNING_SOFT_LIMIT || '30')
        const softReturn = parseInt(env.CC_LEARNING_SOFT_RETURN || '5')
        const similarityThreshold = parseFloat(env.CC_LEARNING_SIMILARITY_THRESHOLD || '0.35')
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

    // Keyword fallback: if semantic returned nothing or wasn't available
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

      const _softRet = parseInt(env.CC_LEARNING_SOFT_RETURN || '5')
      relevantSoft = scoredSoft
        .filter(l => l.relevanceScore > 0)
        .sort((a, b) => b.relevanceScore - a.relevanceScore)
        .slice(0, _softRet)

      // If no keyword matches, fall back to top N by confidence
      const fallbackLimit = parseInt(env.CC_LEARNING_FALLBACK_LIMIT || '3')
      if (relevantSoft.length === 0) {
        relevantSoft = softCandidates.slice(0, fallbackLimit)
        if (relevantSoft.length > 0) contextQuality.learningMatchMethod = 'fallback'
      } else if (contextQuality.learningMatchMethod === 'none') {
        contextQuality.learningMatchMethod = 'keyword'
      }
    }

    const codebaseLearnings = [...hardConstraints, ...relevantSoft]
    // Deduplicate by ID
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

    // Track that these learnings were applied
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

// ─── Task-Aware Section Selection ──────────────────────────────────
// Splits a markdown document into ## sections, scores each by word overlap
// with the task prompt, and returns high-relevance sections in full +
// low-relevance sections as one-line summaries. Ensures the budget is
// spent on content that matters for THIS task.

function _selectRelevantSections(content, promptWords, budgetChars) {
  // Split on any markdown heading (# through ####). CLAUDE.md and .claude/ spec
  // files use mixed heading levels — splitting only on ## missed # and ### sections,
  // dumping their content into the previous section's body unsplittable.
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

  // Score each section by word overlap with prompt
  for (const section of sections) {
    const sectionText = (section.heading + ' ' + section.lines.join(' ')).toLowerCase()
    const sectionWords = sectionText.split(/\W+/).filter(w => w.length > 3)
    section.overlap = sectionWords.filter(w => promptWords.has(w)).length
    section.text = section.lines.join('\n')
    section.fullText = section.heading + '\n' + section.text
  }

  // Sort by relevance (high first), preamble always first
  const preamble = sections.find(s => s.heading === '(preamble)')
  const rest = sections.filter(s => s.heading !== '(preamble)').sort((a, b) => b.overlap - a.overlap)

  const parts = []
  let used = 0

  // Always include preamble (usually short)
  if (preamble && preamble.text.trim()) {
    const text = preamble.text.slice(0, 5000)
    parts.push(text)
    used += text.length
  }

  // If no sections have keyword overlap (short/generic prompt), include sections in
  // natural order up to budget rather than summarising everything into one-liners.
  const hasAnyOverlap = rest.some(s => s.overlap > 0)

  // Include high-relevance sections in full, low-relevance as summaries
  for (const section of rest) {
    if (used + section.fullText.length <= budgetChars) {
      // Fits in budget — include in full (always include if no overlap scoring was possible)
      if (hasAnyOverlap && section.overlap === 0 && used > budgetChars * 0.5) {
        // Low relevance AND past half budget — summarise to save room
        const summary = `${section.heading} — (${section.text.length} chars, not relevant to this task)`
        parts.push(summary)
        used += summary.length
      } else {
        parts.push(section.fullText)
        used += section.fullText.length
      }
    } else if (section.overlap > 0 && used + 2000 <= budgetChars) {
      // Relevant but over budget — include truncated
      parts.push(section.heading + '\n' + section.text.slice(0, 5000) + '\n...(truncated)')
      used += 1500 + section.heading.length
    } else {
      // Low relevance or no budget — one-line summary
      const summary = `${section.heading} — (${section.text.length} chars, ${section.overlap > 0 ? 'partially relevant' : 'not relevant to this task'})`
      parts.push(summary)
      used += summary.length
    }
  }

  return parts.join('\n\n')
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

  // Architecture philosophy & spec files
  if (bundle.philosophyDocs && bundle.philosophyDocs.length > 0) {
    parts.push('## Architecture & Philosophy (from CLAUDE.md / .claude/ specs)')
    parts.push('These documents define the engineering philosophy and architecture patterns for this codebase. Follow them.')
    for (const doc of bundle.philosophyDocs) {
      parts.push(`### ${doc.path}`)
      parts.push(doc.content)
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
    parts.push('These are previous autonomous sessions — avoid duplicating work. Learn from failures.')
    for (const s of bundle.sessionHistory) {
      const files = (s.files_changed || []).join(', ')
      const conf = s.confidence_score ? `, confidence: ${s.confidence_score}` : ''
      const stage = s.pipeline_stage && s.pipeline_stage !== 'complete' ? `, stage: ${s.pipeline_stage}` : ''
      const deploy = s.deploy_status && s.deploy_status !== 'none' ? `, deploy: ${s.deploy_status}` : ''
      const trigger = s.trigger_source ? `, via: ${s.trigger_source}` : ''
      parts.push(`- [${s.status}${conf}${stage}${deploy}${trigger}] ${(s.initial_prompt || '').slice(0, 500)}`)
      if (files) parts.push(`  Files: ${files}`)
      // Full error context for failed sessions — this is what future sessions need to learn from
      if (s.error_message && s.status !== 'complete') {
        parts.push(`  ERROR: ${s.error_message.slice(0, 1000)}`)
      }
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

  // Operating context
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

  // Enforce prompt budget — truncate from the middle (keep task + operating context at end)
  // 0 = unlimited — let full context flow
  if (PROMPT_BUDGET_CHARS > 0 && result.length > PROMPT_BUDGET_CHARS) {
    const taskIdx = result.lastIndexOf('## Task')
    if (taskIdx > 0) {
      // Keep first 20% + last section (task + operating context)
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

// ─── Organism Ingestion ─────────────────────────────────────────────
// After every Factory CC session, push the session log lines to the
// organism's corpus ingestion endpoint so the reasoning becomes part
// of the organism's memory. Fire-and-forget, never blocks the pipeline.

const ORGANISM_URL = env.ORGANISM_API_URL || 'http://localhost:8000'

async function _ingestSessionToOrganism(session, status) {
  try {
    // Read session log lines from DB
    const rows = await db`
      SELECT chunk FROM cc_session_logs
      WHERE session_id = ${session.id}
      ORDER BY id ASC
      LIMIT 500
    `
    if (!rows || rows.length === 0) return

    // Build session log records — only lines with tool_use or result content
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
        } catch {
          return null
        }
      })
      .filter(Boolean)

    if (records.length === 0) return

    const sessionDate = new Date(session.started_at || Date.now()).toISOString().slice(0, 10)

    const response = await fetch(`${ORGANISM_URL}/api/v1/corpus/ingest/session-log`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        records,
        session_id: `factory_${session.id}`,
        session_date: sessionDate,
      }),
      signal: AbortSignal.timeout(30_000),
    })

    if (response.ok) {
      const result = await response.json()
      logger.info('cc_session_ingested_to_organism', {
        sessionId: session.id,
        ingested: result.ingested,
        status,
      })
    } else {
      throw new Error(`Organism ingestion returned ${response.status}: ${await response.text().catch(() => 'no body')}`)
    }
  } catch (err) {
    logger.warn('organism_ingestion_failed', { sessionId: session.id, error: err.message })

    // Retry once after 30s — organism may be temporarily overloaded
    setTimeout(async () => {
      try {
        const rows = await db`
          SELECT chunk FROM cc_session_logs
          WHERE session_id = ${session.id} ORDER BY id ASC LIMIT 500
        `
        if (!rows?.length) return
        const records = rows.map(r => { try { return JSON.parse(r.chunk) } catch { return null } }).filter(Boolean)
        const res = await fetch(`${ORGANISM_URL}/api/v1/corpus/ingest/session-log`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ records, session_id: `factory_${session.id}`, session_date: new Date().toISOString().slice(0, 10) }),
          signal: AbortSignal.timeout(30_000),
        })
        if (res.ok) {
          logger.info('organism_ingestion_retry_succeeded', { sessionId: session.id })
        } else {
          logger.error('organism_ingestion_retry_failed', { sessionId: session.id, status: res.status })
        }
      } catch (retryErr) {
        logger.error('organism_ingestion_retry_failed', { sessionId: session.id, error: retryErr.message })
      }
    }, 30_000)
  }
}

// ─── Session Lifecycle ──────────────────────────────────────────────

async function startSession(session) {
  logger.info(`Starting CC session ${session.id}`, {
    codebaseId: session.codebase_id,
    triggerSource: session.trigger_source || 'manual',
  })

  // Acquire codebase lock — prevents concurrent sessions from clobbering git state
  if (!acquireCodebaseLock(session.codebase_id, session.id)) {
    const msg = `Codebase ${session.codebase_id} is locked by another session — cannot start concurrently`
    logger.warn(msg, { sessionId: session.id })
    await updateSessionStatus(session.id, 'error', { error_message: msg })
    await db`UPDATE cc_sessions SET pipeline_stage = 'failed' WHERE id = ${session.id}`
    return
  }

  await updateSessionStatus(session.id, 'running')
  await db`UPDATE cc_sessions SET pipeline_stage = 'context' WHERE id = ${session.id}`
  broadcastToSession(session.id, 'cc:stage', { stage: 'context', progress: 0.1 })

  // Build context bundle
  const bundle = await buildContextBundle(session)
  const fullPrompt = assemblePrompt(session, bundle)

  // Store context bundle + quality report (without full chunk content to save space)
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

  // Log quality warnings so the Cortex can see degraded context
  if (contextQuality.warnings?.length > 0) {
    logger.warn('CC session context quality warnings', {
      sessionId: session.id,
      warnings: contextQuality.warnings,
      quality: {
        structure: contextQuality.codebaseStructure,
        chunks: contextQuality.relevantChunks,
        kg: contextQuality.kgContext,
        docs: contextQuality.philosophyDocs,
        learningMethod: contextQuality.learningMatchMethod,
      },
    })
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
    ...(MAX_TURNS > 0 ? ['--max-turns', String(MAX_TURNS)] : []),
    '--dangerously-skip-permissions',
    '-p', fullPrompt,
  ]

  // Strip ANTHROPIC_API_KEY so CC uses console auth (not API key)
  const ccEnv = { ...process.env, LANG: 'en_US.UTF-8' }
  delete ccEnv.ANTHROPIC_API_KEY

  const proc = spawn(CC_CLI, args, {
    cwd,
    env: ccEnv,
    stdio: ['pipe', 'pipe', 'pipe'],  // stdin piped — allows sendMessage() for interactive sessions
  })

  const sessionData = {
    process: proc,
    sessionId: session.id,
    startedAt: Date.now(),
    codebaseId: session.codebase_id,
    timeout: null,
    heartbeatTimer: null,
    stopped: false,  // Set by stopSession() — prevents close handler from overwriting status/running oversight
  }
  activeSessions.set(session.id, sessionData)

  // Write initial heartbeat and start periodic updates
  db`UPDATE cc_sessions SET last_heartbeat_at = now() WHERE id = ${session.id}`.catch(() => {})
  sessionData.heartbeatTimer = setInterval(() => {
    db`UPDATE cc_sessions SET last_heartbeat_at = now() WHERE id = ${session.id}`.catch(() => {})
  }, 60_000) // every 60s
  sessionData.heartbeatTimer.unref()

  // Set timeout (0 = unlimited — skip entirely)
  if (SESSION_TIMEOUT_MS > 0) {
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
      clearInterval(sessionData.heartbeatTimer)
      activeSessions.delete(session.id)
      releaseCodebaseLock(session.codebase_id, session.id)
    }, SESSION_TIMEOUT_MS)
  }

  // Stream stdout line by line
  const rl = createInterface({ input: proc.stdout })
  // Track the stream-json result and rate limit events from stdout
  let streamResult = null
  let rateLimitEvent = null

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

      // Capture result and rate limit events for error extraction
      if (parsed.type === 'result') streamResult = parsed
      if (parsed.type === 'rate_limit_event') rateLimitEvent = parsed

      broadcastToSession(session.id, 'cc:output', parsed)
    } catch (err) {
      logger.debug('Error processing CC output line', { error: err.message })
    }
  })

  // Wait for readline to finish processing all buffered stdout lines.
  // proc.on('close') can fire before readline emits the last 'line' events,
  // causing streamResult to be null and the real error to be missed.
  const rlClosed = new Promise(resolve => rl.on('close', resolve))

  // Stderr — 0 = unlimited (full observability). Non-zero keeps last N lines.
  const stderrLines = []
  const stderrRl = createInterface({ input: proc.stderr })
  stderrRl.on('line', (line) => {
    if (STDERR_MAX_LINES <= 0) {
      // Unlimited — capture everything
      stderrLines.push(line)
    } else if (stderrLines.length < STDERR_MAX_LINES) {
      stderrLines.push(line)
    } else if (stderrLines.length === STDERR_MAX_LINES) {
      stderrLines.push('... (stderr capped)')
    }
    // When capped, shift to keep the LAST N lines
    if (STDERR_MAX_LINES > 0 && stderrLines.length > STDERR_MAX_LINES + 1) {
      stderrLines.shift()
    }
    logger.debug(`CC session ${session.id} stderr: ${line}`)
  })
  const stderrRlClosed = new Promise(resolve => stderrRl.on('close', resolve))

  // Idempotent close guard — prevents double-execution if close fires multiple times
  let _closeHandled = false

  // Process exit — wait for readline to drain before reading streamResult
  proc.on('close', async (code, signal) => {
    if (_closeHandled) return
    _closeHandled = true

    // Timeout the readline drain — if readline hangs, don't block forever
    const RL_DRAIN_TIMEOUT = 5000
    await Promise.race([
      Promise.all([rlClosed, stderrRlClosed]),
      new Promise(resolve => setTimeout(resolve, RL_DRAIN_TIMEOUT)),
    ])
    clearTimeout(sessionData.timeout)
    clearInterval(sessionData.heartbeatTimer)
    activeSessions.delete(session.id)
    releaseCodebaseLock(session.codebase_id, session.id)

    // If stopSession() already handled this session, don't overwrite its status
    // or trigger the oversight pipeline. The human deliberately cancelled it.
    if (sessionData.stopped) {
      logger.info(`CC session ${session.id} close event after stop — skipping oversight`)
      // Still ingest to organism (useful learning even from partial sessions)
      _ingestSessionToOrganism(session, 'stopped').catch(() => {})
      return
    }

    // Treat stdin-only warnings as non-errors — CC CLI emits is_error for the warning
    // but the session actually completed fine
    const isStdinWarningOnly = streamResult?.is_error &&
      streamResult?.result?.includes('no stdin data received') &&
      !streamResult?.result?.replace(/.*no stdin data received[^\n]*/, '').trim()
    const success = code === 0 && (!streamResult?.is_error || isStdinWarningOnly)
    const status = success ? 'complete' : 'error'

    // Extract error from stream-json result first (has the real error),
    // fall back to stderr, then exit code/signal
    let errorMessage = null
    if (!success) {
      if (streamResult?.is_error && streamResult?.result &&
          !streamResult.result.includes('no stdin data received')) {
        errorMessage = streamResult.result
      } else if (stderrLines.length > 0) {
        // Filter CC CLI noise (stdin warnings, debug lines) before using stderr as error
        const meaningfulStderr = stderrLines.filter(l =>
          l.trim() && !l.includes('no stdin data received')
        )
        if (meaningfulStderr.length > 0) {
          errorMessage = meaningfulStderr.slice(-5).join('\n')
        }
      }
      // If no meaningful error extracted yet, classify by exit code/signal
      if (!errorMessage) {
        if (code === null && signal) {
          errorMessage = `Process killed by ${signal} (exit code null) — likely PM2 restart, OOM, or deployment`
        } else if (code === null) {
          errorMessage = `Process exited abnormally (exit code null, no signal) — likely parent process killed during PM2 restart or OOM`
        } else {
          errorMessage = `Exit code ${code}`
        }
      }
    }

    // Detect rate limiting and record for backoff
    if (rateLimitEvent?.rate_limit_info?.status === 'rejected') {
      const resetsAt = rateLimitEvent.rate_limit_info.resetsAt
        ? new Date(rateLimitEvent.rate_limit_info.resetsAt * 1000)
        : null
      logger.warn(`CC session ${session.id} rate-limited`, {
        rateLimitType: rateLimitEvent.rate_limit_info.rateLimitType,
        resetsAt: resetsAt?.toISOString(),
      })
      errorMessage = `Rate limited (${rateLimitEvent.rate_limit_info.rateLimitType})${resetsAt ? ` — resets ${resetsAt.toISOString()}` : ''}`
      // Store rate limit reset time so callers can back off
      _lastRateLimitReset = resetsAt
    }

    try {
      await updateSessionStatus(session.id, status, {
        error_message: errorMessage,
      })

      // If failed, mark pipeline as failed immediately
      if (!success) {
        await db`UPDATE cc_sessions SET pipeline_stage = 'failed' WHERE id = ${session.id}`
      }
    } catch (dbErr) {
      logger.error(`Failed to update session ${session.id} status in DB`, { error: dbErr.message, status })
    }

    broadcastToSession(session.id, 'cc:status', { status, code })

    // Detect changed files via git BEFORE triggering oversight
    if (success && cwd) {
      try {
        const { execFileSync } = require('child_process')
        const gitOpts = { cwd, encoding: 'utf-8', timeout: 15_000, maxBuffer: 5 * 1024 * 1024 }
        const diff = execFileSync('git', ['diff', '--name-only'], gitOpts).trim()
        const staged = execFileSync('git', ['diff', '--name-only', '--cached'], gitOpts).trim()
        const untracked = execFileSync('git', ['ls-files', '--others', '--exclude-standard'], gitOpts).trim()

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

    // Organism corpus ingestion — push session log lines as training episodes
    _ingestSessionToOrganism(session, status).catch(() => {})

    logger.info(`CC session ${session.id} completed`, { code, status })

    // Trigger full oversight pipeline: review → validate → deploy → monitor
    // Pipeline will set pipeline_stage through its own stages (testing → deploying → complete/failed)
    const oversight = require('./factoryOversightService')
    oversight.runPostSessionPipeline(session.id).catch(err => {
      logger.error(`Oversight pipeline failed for session ${session.id}`, { error: err.message })
      // Oversight failed — mark as failed (not complete!) so the dirty working dir
      // gets cleaned up and the uncommitted changes don't leak into the next session.
      db`UPDATE cc_sessions SET pipeline_stage = 'failed', deploy_status = 'failed' WHERE id = ${session.id}`.catch(() => {})
      // Clean uncommitted changes left by CC — prevents them from being committed
      // as part of a subsequent unrelated session's git add -A
      if (cwd) {
        try {
          const { execFileSync: execFS } = require('child_process')
          execFS('git', ['checkout', '.'], { cwd, encoding: 'utf-8', timeout: 10_000 })
          execFS('git', ['clean', '-fd'], { cwd, encoding: 'utf-8', timeout: 10_000 })
        } catch {}
      }
    })
  })

  proc.on('error', async (err) => {
    if (_closeHandled) return  // close handler already ran
    _closeHandled = true
    rl.close()
    stderrRl.close()
    clearTimeout(sessionData.timeout)
    clearInterval(sessionData.heartbeatTimer)
    activeSessions.delete(session.id)
    releaseCodebaseLock(session.codebase_id, session.id)

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
  if (!proc.stdin || !proc.stdin.writable) throw new Error('Session stdin is not writable')

  proc.stdin.write(content + '\n')
  await appendLog(sessionId, `[USER] ${content}`)
  broadcastToSession(sessionId, 'cc:output', { type: 'user', content })
}

// ─── Stop Session ───────────────────────────────────────────────────

async function stopSession(sessionId) {
  const sessionData = activeSessions.get(sessionId)
  if (sessionData) {
    // Mark as stopped BEFORE killing — the close handler checks this flag
    // to avoid overwriting 'stopped' → 'error' and triggering oversight
    sessionData.stopped = true

    clearTimeout(sessionData.timeout)
    clearInterval(sessionData.heartbeatTimer)

    const proc = sessionData.process
    proc.kill('SIGTERM')

    // Force kill after 5s if still alive
    setTimeout(() => {
      if (!proc.killed) proc.kill('SIGKILL')
    }, 5000)

    // Don't delete from activeSessions here — let the close handler do it
    // after seeing the stopped flag. This prevents a window where the session
    // is neither in activeSessions nor properly cleaned up.
  }

  // 'stopped' distinguishes human-cancelled from naturally-completed sessions
  await updateSessionStatus(sessionId, 'stopped')
  await db`UPDATE cc_sessions SET pipeline_stage = 'complete' WHERE id = ${sessionId}`
  logger.info(`CC session ${sessionId} stopped`)
}

// ─── Stop All Sessions (graceful shutdown) ─────────────────────────

async function stopAllSessions(reason) {
  const ids = [...activeSessions.keys()]
  await Promise.allSettled(ids.map(async (sessionId) => {
    const sessionData = activeSessions.get(sessionId)
    if (!sessionData) {
      // No in-memory data — just update DB
      await updateSessionStatus(sessionId, 'stopped', { error_message: reason })
      await db`UPDATE cc_sessions SET pipeline_stage = 'complete' WHERE id = ${sessionId}`
      return
    }

    // Mark as stopped before killing — prevents close handler from
    // overwriting status to 'error' and running the oversight pipeline
    sessionData.stopped = true

    clearTimeout(sessionData.timeout)
    clearInterval(sessionData.heartbeatTimer)

    const proc = sessionData.process
    // Update DB first — if the main process gets killed before child exits,
    // the session is already marked 'stopped' (not left as 'running' → orphan)
    // Parallelize both writes to reduce time spent before killing the child
    await Promise.all([
      updateSessionStatus(sessionId, 'stopped', { error_message: reason }),
      db`UPDATE cc_sessions SET pipeline_stage = 'complete' WHERE id = ${sessionId}`,
    ])

    try { proc.kill('SIGTERM') } catch {}

    // Wait for child to actually exit (up to 5s), then force-kill.
    // Reduced from 8s to fit within the parent's 10s shutdown budget.
    await new Promise((resolve) => {
      const forceKillTimer = setTimeout(() => {
        try { if (!proc.killed) proc.kill('SIGKILL') } catch {}
        resolve()
      }, 5000)
      forceKillTimer.unref()
      proc.on('close', () => { clearTimeout(forceKillTimer); resolve() })
      // If already exited, resolve immediately
      if (proc.exitCode !== null || proc.killed) { clearTimeout(forceKillTimer); resolve() }
    })

    activeSessions.delete(sessionId)
    logger.info(`CC session ${sessionId} stopped: ${reason}`)
  }))
}

// ─── Session Watchdog ──────────────────────────────────────────
// Periodically checks that child processes in activeSessions are still alive.
// If a child died without triggering 'close'/'error' events (rare but possible
// with SIGKILL, OOM killer, etc.), this catches the zombie and updates the DB.

const WATCHDOG_INTERVAL_MS = 60_000 // 1 minute

let watchdogTimer = null

function startWatchdog() {
  if (watchdogTimer) return
  watchdogTimer = setInterval(async () => {
    for (const [sessionId, sessionData] of activeSessions) {
      const proc = sessionData.process
      // exitCode is non-null once the process has exited
      if (proc.exitCode !== null || proc.killed) {
        logger.warn(`Watchdog: CC session ${sessionId} child process is dead (exit: ${proc.exitCode}), cleaning up`)
        clearTimeout(sessionData.timeout)
        clearInterval(sessionData.heartbeatTimer)
        activeSessions.delete(sessionId)
        try {
          await updateSessionStatus(sessionId, 'error', {
            error_message: `Child process died unexpectedly (exit code: ${proc.exitCode})`,
          })
          await db`UPDATE cc_sessions SET pipeline_stage = 'failed' WHERE id = ${sessionId}`
        } catch (err) {
          logger.debug('Watchdog: failed to update dead session', { sessionId, error: err.message })
        }
      }
    }
  }, WATCHDOG_INTERVAL_MS)
  // Don't keep process alive just for the watchdog
  watchdogTimer.unref()
}

function stopWatchdog() {
  if (watchdogTimer) {
    clearInterval(watchdogTimer)
    watchdogTimer = null
  }
}

// Start watchdog on module load
startWatchdog()

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

/**
 * Check if Claude CLI is currently rate-limited.
 * Returns { limited: true, resetsAt: Date } if limited, { limited: false } otherwise.
 */
function getRateLimitStatus() {
  if (_lastRateLimitReset && _lastRateLimitReset > new Date()) {
    return { limited: true, resetsAt: _lastRateLimitReset }
  }
  return { limited: false }
}

module.exports = {
  startSession,
  sendMessage,
  stopSession,
  stopAllSessions,
  stopWatchdog,
  getActiveSessionInfo,
  getActiveSessionCount,
  getRateLimitStatus,
  buildContextBundle,
}
