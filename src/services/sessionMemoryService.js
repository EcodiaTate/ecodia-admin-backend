/**
 * Session Memory Service
 *
 * Mines Claude Code's JSONL session transcripts from ~/.claude/projects/ and
 * builds a searchable, embedded memory store so the OS can recall past conversations
 * across session resets.
 *
 * Flow:
 *   1. ingestSessionFile(jsonlPath)  — parse JSONL, extract meaningful exchanges,
 *      chunk by conversation turn, embed with OpenAI, store in session_memory_chunks
 *   2. searchMemory(query, opts)     — semantic search over all ingested chunks,
 *      returns ranked context snippets ready to prepend to a new OS session message
 *   3. ingestProjectDir(dir)         — scans a .claude/projects/<key>/ dir for new/
 *      changed JSONL files and ingests them incrementally (skips unchanged files)
 *
 * The JSONL format from CC CLI:
 *   Each line is a JSON object. Types we care about:
 *     { type: 'user',      message: { role: 'user', content: [{type:'text', text:'...'}] } }
 *     { type: 'assistant', message: { role: 'assistant', content: [{type:'text', text:'...'}] } }
 *   Types we skip:
 *     queue-operation, file-history-snapshot, ai-title, system, stream_event,
 *     compact_boundary, user (with only ide_opened_file content)
 */

const fs = require('fs')
const path = require('path')
const readline = require('readline')
const axios = require('axios')
const db = require('../config/db')
const env = require('../config/env')
const logger = require('../config/logger')
const secretSafety = require('./secretSafetyService')

// ── Config ────────────────────────────────────────────────────────────────────

// Path to the CC CLI projects directory on this machine
const CC_PROJECTS_DIR = env.CC_PROJECTS_DIR ||
  (process.platform === 'win32'
    ? path.join(process.env.USERPROFILE || 'C:/Users/tate', '.claude', 'projects')
    : path.join(process.env.HOME || '/home/tate', '.claude', 'projects'))

// The project key for the OS session (maps to the dir name CC creates)
const OS_PROJECT_KEY = env.CC_OS_PROJECT_KEY || '-home-tate-ecodiaos'

// Max chars per memory chunk (fits comfortably in context)
const MAX_CHUNK_CHARS = parseInt(env.SESSION_MEMORY_MAX_CHUNK_CHARS || '3000', 10)

// How many chunks to return in a search
const SEARCH_TOP_K = parseInt(env.SESSION_MEMORY_SEARCH_K || '5', 10)

// Min similarity threshold (0-1 cosine similarity)
const SEARCH_MIN_SIM = parseFloat(env.SESSION_MEMORY_MIN_SIM || '0.35')

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Extract plain text from a CC CLI content array.
 * Skips IDE-injected metadata blocks (ide_opened_file, ide_selection, etc.)
 */
function extractText(content) {
  if (!content) return ''
  if (typeof content === 'string') return content

  if (Array.isArray(content)) {
    return content
      .filter(b => b.type === 'text' && b.text)
      .map(b => b.text)
      .filter(t => {
        // Skip pure IDE context injections — they add noise, not signal
        const trimmed = t.trim()
        if (trimmed.startsWith('<ide_opened_file>')) return false
        if (trimmed.startsWith('<ide_selection>')) return false
        if (trimmed.startsWith('<system-reminder>')) return false
        return true
      })
      .join('\n')
      .trim()
  }

  return ''
}

/**
 * Embed a batch of texts with OpenAI text-embedding-3-small.
 * Returns array of 1536-dim float arrays (parallel to input).
 * Returns nulls for any failed positions.
 */
async function embedBatch(texts) {
  if (!env.OPENAI_API_KEY) {
    logger.debug('Session memory embedding skipped — no OPENAI_API_KEY')
    return texts.map(() => null)
  }

  const cleaned = texts.map(t => t.replace(/\s+/g, ' ').slice(0, 8000))

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const response = await axios.post(
        'https://api.openai.com/v1/embeddings',
        { model: 'text-embedding-3-small', input: cleaned },
        { headers: { Authorization: `Bearer ${env.OPENAI_API_KEY}` }, timeout: 60_000 }
      )
      return response.data.data.map(d => d.embedding)
    } catch (err) {
      if (attempt === 3) {
        logger.warn('Session memory embed batch failed after 3 attempts', { error: err.message })
        return texts.map(() => null)
      }
      await new Promise(r => setTimeout(r, 1000 * attempt))
    }
  }
}

/**
 * Embed a single query string. Returns the embedding array or null.
 */
async function embedQuery(text) {
  const results = await embedBatch([text])
  return results[0]
}

// ── JSONL Parsing ─────────────────────────────────────────────────────────────

/**
 * Parse a CC CLI JSONL file and return an array of exchange chunks.
 * Each chunk = { turnIndex, userText, assistantText, timestamp }
 *
 * Strategy: pair up user messages with the assistant response(s) that follow.
 * Tool calls and results are dropped — we want the reasoning layer, not the scaffolding.
 */
async function parseJsonlFile(filePath) {
  const exchanges = []
  let currentUser = null
  let currentAssistantParts = []
  let currentTs = null
  let turnIndex = 0

  const fileStream = fs.createReadStream(filePath)
  const rl = readline.createInterface({ input: fileStream, crlfDelay: Infinity })

  for await (const line of rl) {
    if (!line.trim()) continue

    let record
    try {
      record = JSON.parse(line)
    } catch {
      continue
    }

    // Skip structural/noise types
    if (['queue-operation', 'file-history-snapshot', 'ai-title', 'compact_boundary'].includes(record.type)) {
      continue
    }

    if (record.type === 'system') continue

    // User message — flush any pending exchange first, then start a new one
    if (record.type === 'user' && record.message?.role === 'user') {
      // Flush previous exchange
      if (currentUser !== null && currentAssistantParts.length > 0) {
        const assistantText = currentAssistantParts.join('\n\n').trim()
        if (assistantText.length > 50) {
          exchanges.push({
            turnIndex: turnIndex++,
            userText: currentUser,
            assistantText,
            timestamp: currentTs,
          })
        }
        currentAssistantParts = []
      }

      const text = extractText(record.message.content)
      // Skip empty or pure-IDE user messages
      if (text.length > 10) {
        currentUser = text
        currentTs = record.timestamp ? new Date(record.timestamp) : null
      }
      continue
    }

    // Assistant message — accumulate text parts (may be multiple turns before next user)
    if (record.type === 'assistant' && record.message?.role === 'assistant') {
      const parts = (record.message.content || [])
      for (const part of parts) {
        if (part.type === 'text' && part.text && part.text.trim().length > 20) {
          currentAssistantParts.push(part.text.trim())
        }
        // Skip tool_use and tool_result — pure mechanism, no episodic value
      }
      if (!currentTs && record.timestamp) {
        currentTs = new Date(record.timestamp)
      }
      continue
    }

    // result message — flush current exchange
    if (record.type === 'result') {
      if (currentUser !== null && currentAssistantParts.length > 0) {
        const assistantText = currentAssistantParts.join('\n\n').trim()
        if (assistantText.length > 50) {
          exchanges.push({
            turnIndex: turnIndex++,
            userText: currentUser,
            assistantText,
            timestamp: currentTs,
          })
        }
        currentUser = null
        currentAssistantParts = []
        currentTs = null
      }
    }
  }

  // Flush any trailing exchange
  if (currentUser !== null && currentAssistantParts.length > 0) {
    const assistantText = currentAssistantParts.join('\n\n').trim()
    if (assistantText.length > 50) {
      exchanges.push({
        turnIndex: turnIndex++,
        userText: currentUser,
        assistantText,
        timestamp: currentTs,
      })
    }
  }

  return exchanges
}

/**
 * Convert an exchange into memory chunk text.
 * Format is deliberately simple and human-readable so embeddings are clean.
 */
function buildChunkText(exchange) {
  const user = exchange.userText.slice(0, 800)
  const assistant = exchange.assistantText.slice(0, MAX_CHUNK_CHARS - 800 - 50)
  return `User: ${user}\n\nAssistant: ${assistant}`
}

// ── Core Ingestion ────────────────────────────────────────────────────────────

/**
 * Ingest a single JSONL file into session_memory_chunks.
 * Skips if file hasn't changed since last ingest (based on mtime).
 *
 * @param {string} jsonlPath  Absolute path to the .jsonl file
 * @param {string} projectKey  e.g. '-home-tate-ecodiaos'
 * @returns {{ skipped: boolean, chunks: number }}
 */
async function ingestSessionFile(jsonlPath, projectKey = OS_PROJECT_KEY) {
  const ccSessionId = path.basename(jsonlPath, '.jsonl')

  // Check file exists and get mtime
  let stat
  try {
    stat = fs.statSync(jsonlPath)
  } catch {
    return { skipped: true, chunks: 0 }
  }
  const fileMtimeMs = stat.mtimeMs

  // Check if already ingested at this mtime
  const [existing] = await db`
    SELECT file_mtime_ms FROM session_memory_ingested
    WHERE project_key = ${projectKey} AND cc_session_id = ${ccSessionId}
  `
  if (existing && existing.file_mtime_ms >= fileMtimeMs) {
    return { skipped: true, chunks: 0 }
  }

  // Parse exchanges
  let exchanges
  try {
    exchanges = await parseJsonlFile(jsonlPath)
  } catch (err) {
    logger.warn('Session memory: failed to parse JSONL', { jsonlPath, error: err.message })
    return { skipped: true, chunks: 0 }
  }

  if (exchanges.length === 0) {
    // Mark as processed so we don't retry empty files constantly
    await db`
      INSERT INTO session_memory_ingested (project_key, cc_session_id, file_mtime_ms, chunk_count)
      VALUES (${projectKey}, ${ccSessionId}, ${fileMtimeMs}, 0)
      ON CONFLICT (project_key, cc_session_id) DO UPDATE
        SET file_mtime_ms = EXCLUDED.file_mtime_ms,
            chunk_count   = 0,
            ingested_at   = now()
    `
    return { skipped: false, chunks: 0 }
  }

  // Build chunk texts and scrub secrets
  const chunkTexts = exchanges.map(ex => secretSafety.scrubSecrets(buildChunkText(ex)))

  // Embed all chunks
  const embeddings = await embedBatch(chunkTexts)

  // Upsert chunks (unique on cc_session_id + turn_index)
  let inserted = 0
  for (let i = 0; i < exchanges.length; i++) {
    const ex = exchanges[i]
    const text = chunkTexts[i]
    const emb = embeddings[i]
    const vecStr = emb ? `[${emb.join(',')}]` : null

    try {
      if (vecStr) {
        await db`
          INSERT INTO session_memory_chunks
            (cc_session_id, project_key, chunk_type, content, turn_index, exchange_ts, embedding)
          VALUES
            (${ccSessionId}, ${projectKey}, 'exchange', ${text}, ${ex.turnIndex},
             ${ex.timestamp || null}, ${vecStr}::vector)
          ON CONFLICT (cc_session_id, turn_index) DO UPDATE
            SET content     = EXCLUDED.content,
                exchange_ts = EXCLUDED.exchange_ts,
                embedding   = EXCLUDED.embedding
        `
      } else {
        await db`
          INSERT INTO session_memory_chunks
            (cc_session_id, project_key, chunk_type, content, turn_index, exchange_ts)
          VALUES
            (${ccSessionId}, ${projectKey}, 'exchange', ${text}, ${ex.turnIndex},
             ${ex.timestamp || null})
          ON CONFLICT (cc_session_id, turn_index) DO UPDATE
            SET content     = EXCLUDED.content,
                exchange_ts = EXCLUDED.exchange_ts
        `
      }
      inserted++
    } catch (err) {
      logger.warn('Session memory: chunk upsert failed', { ccSessionId, turn: ex.turnIndex, error: err.message })
    }
  }

  // Update ingestion tracking
  await db`
    INSERT INTO session_memory_ingested (project_key, cc_session_id, file_mtime_ms, chunk_count)
    VALUES (${projectKey}, ${ccSessionId}, ${fileMtimeMs}, ${inserted})
    ON CONFLICT (project_key, cc_session_id) DO UPDATE
      SET file_mtime_ms = EXCLUDED.file_mtime_ms,
          chunk_count   = EXCLUDED.chunk_count,
          ingested_at   = now()
  `

  logger.info('Session memory: ingested JSONL file', { ccSessionId, projectKey, exchanges: exchanges.length, inserted })
  return { skipped: false, chunks: inserted }
}

/**
 * Scan a project dir for JSONL files and ingest any new/changed ones.
 * Only processes .jsonl files (skips plain UUID dirs which are older format).
 *
 * @param {string} [projectKey]  Defaults to OS_PROJECT_KEY
 * @returns {{ processed: number, totalChunks: number }}
 */
async function ingestProjectDir(projectKey = OS_PROJECT_KEY) {
  const dir = path.join(CC_PROJECTS_DIR, projectKey)

  if (!fs.existsSync(dir)) {
    logger.debug('Session memory: project dir not found', { dir })
    return { processed: 0, totalChunks: 0 }
  }

  let files
  try {
    files = fs.readdirSync(dir).filter(f => f.endsWith('.jsonl'))
  } catch (err) {
    logger.warn('Session memory: could not read project dir', { dir, error: err.message })
    return { processed: 0, totalChunks: 0 }
  }

  // Sort by mtime descending so most recent sessions get processed first
  const withMtime = files.map(f => {
    const fullPath = path.join(dir, f)
    try {
      return { f, mtime: fs.statSync(fullPath).mtimeMs }
    } catch {
      return { f, mtime: 0 }
    }
  }).sort((a, b) => b.mtime - a.mtime)

  let processed = 0
  let totalChunks = 0

  for (const { f } of withMtime) {
    const fullPath = path.join(dir, f)
    const result = await ingestSessionFile(fullPath, projectKey)
    if (!result.skipped) {
      processed++
      totalChunks += result.chunks
    }
  }

  if (processed > 0) {
    logger.info('Session memory: project dir scan complete', { projectKey, processed, totalChunks })
  }

  return { processed, totalChunks }
}

// ── Semantic Search ───────────────────────────────────────────────────────────

/**
 * Semantically search session memory for chunks relevant to a query.
 * Returns formatted context snippets suitable for prepending to an OS session message.
 *
 * @param {string} query  The user's message or topic to search for
 * @param {object} opts
 * @param {number} [opts.topK]        Number of results (default: SEARCH_TOP_K)
 * @param {number} [opts.minSim]      Min cosine similarity (default: SEARCH_MIN_SIM)
 * @param {string} [opts.projectKey]  Project to search (default: OS_PROJECT_KEY)
 * @param {number} [opts.maxAgeDays]  Only include chunks from last N days (0 = no limit)
 * @returns {string}  Formatted memory context, or '' if nothing relevant
 */
async function searchMemory(query, opts = {}) {
  if (!env.OPENAI_API_KEY) return ''

  const topK     = opts.topK      ?? SEARCH_TOP_K
  const minSim   = opts.minSim    ?? SEARCH_MIN_SIM
  const projKey  = opts.projectKey ?? OS_PROJECT_KEY
  const maxAgeDays = opts.maxAgeDays ?? 90

  const embedding = await embedQuery(query)
  if (!embedding) return ''

  const vecStr = `[${embedding.join(',')}]`

  let rows
  try {
    if (maxAgeDays > 0) {
      rows = await db`
        SELECT content, exchange_ts, cc_session_id,
               1 - (embedding <=> ${vecStr}::vector) AS similarity
        FROM session_memory_chunks
        WHERE project_key = ${projKey}
          AND embedding IS NOT NULL
          AND exchange_ts > now() - make_interval(days => ${maxAgeDays})
        ORDER BY embedding <=> ${vecStr}::vector
        LIMIT ${topK * 2}
      `
    } else {
      rows = await db`
        SELECT content, exchange_ts, cc_session_id,
               1 - (embedding <=> ${vecStr}::vector) AS similarity
        FROM session_memory_chunks
        WHERE project_key = ${projKey}
          AND embedding IS NOT NULL
        ORDER BY embedding <=> ${vecStr}::vector
        LIMIT ${topK * 2}
      `
    }
  } catch (err) {
    logger.warn('Session memory: search query failed', { error: err.message })
    return ''
  }

  const filtered = rows.filter(r => r.similarity >= minSim).slice(0, topK)
  if (filtered.length === 0) return ''

  const lines = filtered.map(r => {
    const date = r.exchange_ts
      ? new Date(r.exchange_ts).toLocaleDateString('en-AU', { day: 'numeric', month: 'short', year: 'numeric' })
      : 'unknown date'
    return `[Memory – ${date}]\n${r.content}`
  })

  return `## Relevant past conversations\n\n${lines.join('\n\n---\n\n')}`
}

/**
 * Embed any chunks that are missing embeddings (e.g., if OpenAI was unavailable at ingest).
 * Runs as a background catch-up task.
 */
async function embedStaleChunks(batchSize = 50) {
  if (!env.OPENAI_API_KEY) return

  const stale = await db`
    SELECT id, content
    FROM session_memory_chunks
    WHERE embedding IS NULL
    LIMIT ${batchSize}
  `
  if (stale.length === 0) return

  const embeddings = await embedBatch(stale.map(r => r.content))

  for (let i = 0; i < stale.length; i++) {
    if (!embeddings[i]) continue
    const vecStr = `[${embeddings[i].join(',')}]`
    await db`
      UPDATE session_memory_chunks
      SET embedding = ${vecStr}::vector
      WHERE id = ${stale[i].id}
    `.catch(() => {})
  }

  logger.info('Session memory: embedded stale chunks', { count: stale.length })
}

// ── Exports ───────────────────────────────────────────────────────────────────

module.exports = {
  ingestSessionFile,
  ingestProjectDir,
  searchMemory,
  embedStaleChunks,
  OS_PROJECT_KEY,
  CC_PROJECTS_DIR,
}
