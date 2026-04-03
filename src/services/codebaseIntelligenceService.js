const { execFileSync } = require('child_process')
const crypto = require('crypto')
const path = require('path')
const fs = require('fs')
const axios = require('axios')
const db = require('../config/db')
const env = require('../config/env')
const logger = require('../config/logger')
const secretSafety = require('./secretSafetyService')

// ═══════════════════════════════════════════════════════════════════════
// CODEBASE INTELLIGENCE SERVICE
//
// Chunks, embeds, and indexes every registered codebase. Git-aware:
// only re-indexes files that changed since last sync. All content
// passes through secret safety gates before touching any LLM.
//
// Storage: PostgreSQL with pgvector for semantic search.
// Embeddings: OpenAI text-embedding-3-small (1536 dims).
// ═══════════════════════════════════════════════════════════════════════

const MAX_CHUNK_TOKENS = 800
const CHARS_PER_TOKEN = 4
const MAX_CHUNK_CHARS = MAX_CHUNK_TOKENS * CHARS_PER_TOKEN

// ─── Language Detection ─────────────────────────────────────────────

const LANG_MAP = {
  '.js': 'javascript', '.jsx': 'javascript',
  '.ts': 'typescript', '.tsx': 'typescript',
  '.py': 'python',
  '.rs': 'rust',
  '.go': 'go',
  '.java': 'java',
  '.rb': 'ruby',
  '.php': 'php',
  '.swift': 'swift',
  '.kt': 'kotlin',
  '.sql': 'sql',
  '.sh': 'shell', '.bash': 'shell',
  '.css': 'css', '.scss': 'scss',
  '.html': 'html', '.htm': 'html',
  '.json': 'json',
  '.yaml': 'yaml', '.yml': 'yaml',
  '.md': 'markdown',
  '.vue': 'vue',
  '.svelte': 'svelte',
}

const SKIP_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.svg', '.ico', '.webp', '.avif',
  '.mp3', '.mp4', '.wav', '.ogg', '.webm',
  '.woff', '.woff2', '.ttf', '.eot', '.otf',
  '.pdf', '.doc', '.docx', '.xls', '.xlsx',
  '.zip', '.tar', '.gz', '.bz2', '.7z', '.rar',
  '.exe', '.dll', '.so', '.dylib', '.bin',
  '.lock', '.map',
  '.sqlite', '.db',
])

const SKIP_DIRS = new Set([
  'node_modules', '.git', '.next', '.nuxt', '.output', 'dist', 'build',
  '__pycache__', '.pytest_cache', '.mypy_cache', '.ruff_cache',
  'venv', '.venv', 'env', '.tox',
  'coverage', '.nyc_output', '.turbo',
  'target',
  '.gradle', '.idea', '.vscode',
])

function detectLanguage(filePath) {
  const ext = path.extname(filePath).toLowerCase()
  return LANG_MAP[ext] || null
}

// Files to always skip by exact name
const SKIP_FILES = new Set([
  'package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', 'bun.lockb',
  'composer.lock', 'Gemfile.lock', 'poetry.lock', 'Pipfile.lock',
  'Cargo.lock', 'go.sum',
  '.DS_Store', 'Thumbs.db',
])

function shouldSkipFile(filePath) {
  const ext = path.extname(filePath).toLowerCase()
  if (SKIP_EXTENSIONS.has(ext)) return true

  const basename = path.basename(filePath)
  if (SKIP_FILES.has(basename)) return true

  const parts = filePath.replace(/\\/g, '/').split('/')
  for (const part of parts) {
    if (SKIP_DIRS.has(part)) return true
  }

  return false
}

// ─── Git Operations (execFileSync — no shell injection) ─────────────

function gitExec(args, cwd) {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf-8', maxBuffer: 10 * 1024 * 1024, timeout: 60_000 }).trim()
  } catch (err) {
    logger.warn(`Git command failed: git ${args.join(' ')}`, { error: err.message, cwd })
    return null
  }
}

async function syncCodebase(codebaseId) {
  const [codebase] = await db`SELECT * FROM codebases WHERE id = ${codebaseId}`
  if (!codebase) throw new Error(`Codebase ${codebaseId} not found`)

  if (codebase.mirror_path && fs.existsSync(codebase.mirror_path)) {
    gitExec(['fetch', '--all', '--prune'], codebase.mirror_path)
  }

  if (fs.existsSync(codebase.repo_path)) {
    // Stash any in-progress changes (e.g. mid-CC-session files), pull, then restore.
    const stashOut = gitExec(['stash', '--include-untracked'], codebase.repo_path)
    const stashed = stashOut && !stashOut.includes('No local changes')

    // Try fast-forward first (clean linear history). If that fails (diverged branches),
    // fall back to rebase so local commits replay on top of remote — this is the exact
    // scenario that was causing "fatal: Not possible to fast-forward, aborting." in prod.
    const ffResult = gitExec(['pull', '--ff-only'], codebase.repo_path)
    if (ffResult === null) {
      logger.info('Fast-forward pull failed, falling back to rebase', { repoPath: codebase.repo_path })
      const rebaseResult = gitExec(['pull', '--rebase'], codebase.repo_path)
      if (rebaseResult === null) {
        // Rebase failed (conflicts) — abort to leave repo in clean state
        gitExec(['rebase', '--abort'], codebase.repo_path)
        logger.error('Pull rebase failed (conflicts) — aborting rebase, repo unchanged', { repoPath: codebase.repo_path })
      }
    }

    if (stashed) {
      const popResult = gitExec(['stash', 'pop'], codebase.repo_path)
      if (popResult === null) {
        // Stash pop conflict — drop the stash entry to avoid it piling up,
        // the files are still in the working dir as conflict markers
        logger.warn('Stash pop had conflicts — dropping stash, check working dir', { repoPath: codebase.repo_path })
        gitExec(['stash', 'drop'], codebase.repo_path)
      }
    }
  }

  await db`UPDATE codebases SET last_synced_at = now() WHERE id = ${codebaseId}`
  return codebase
}

function getHeadSha(repoPath) {
  return gitExec(['rev-parse', 'HEAD'], repoPath)
}

function getChangedFiles(repoPath, sinceCommit) {
  if (!sinceCommit) {
    const output = gitExec(['ls-files'], repoPath)
    return output ? output.split('\n').filter(Boolean) : []
  }

  const head = getHeadSha(repoPath)
  if (sinceCommit === head) return []

  const output = gitExec(['diff', '--name-only', `${sinceCommit}..HEAD`], repoPath)
  return output ? output.split('\n').filter(Boolean) : []
}

// ─── Chunking ───────────────────────────────────────────────────────

function chunkFile(content, language) {
  const lines = content.split('\n')

  if (content.length <= MAX_CHUNK_CHARS) {
    return [{ content, startLine: 1, endLine: lines.length }]
  }

  const chunks = []
  let currentChunk = []
  let currentSize = 0
  let chunkStartLine = 1

  const splitPatterns = {
    javascript: /^(?:function\s|const\s+\w+\s*=\s*(?:async\s+)?function|class\s|module\.exports|export\s+(?:default\s+)?(?:function|class|const))/,
    typescript: /^(?:function\s|const\s+\w+\s*=\s*(?:async\s+)?function|class\s|export\s+(?:default\s+)?(?:function|class|const|interface|type)|interface\s|type\s)/,
    python: /^(?:def\s|class\s|async\s+def\s)/,
    rust: /^(?:fn\s|pub\s+fn\s|impl\s|struct\s|enum\s|trait\s|mod\s)/,
    go: /^(?:func\s|type\s)/,
  }

  const splitPattern = splitPatterns[language]

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const lineSize = line.length + 1

    const isNewBlock = splitPattern && splitPattern.test(line.trimStart())

    if (isNewBlock && currentSize > MAX_CHUNK_CHARS / 3 && currentChunk.length > 0) {
      chunks.push({
        content: currentChunk.join('\n'),
        startLine: chunkStartLine,
        endLine: chunkStartLine + currentChunk.length - 1,
      })
      currentChunk = [line]
      currentSize = lineSize
      chunkStartLine = i + 1
    } else if (currentSize + lineSize > MAX_CHUNK_CHARS && currentChunk.length > 0) {
      chunks.push({
        content: currentChunk.join('\n'),
        startLine: chunkStartLine,
        endLine: chunkStartLine + currentChunk.length - 1,
      })
      currentChunk = [line]
      currentSize = lineSize
      chunkStartLine = i + 1
    } else {
      currentChunk.push(line)
      currentSize += lineSize
    }
  }

  if (currentChunk.length > 0) {
    chunks.push({
      content: currentChunk.join('\n'),
      startLine: chunkStartLine,
      endLine: chunkStartLine + currentChunk.length - 1,
    })
  }

  return chunks
}

// ─── Indexing ───────────────────────────────────────────────────────

async function indexCodebase(codebaseId) {
  const [codebase] = await db`SELECT * FROM codebases WHERE id = ${codebaseId}`
  if (!codebase) throw new Error(`Codebase ${codebaseId} not found`)
  if (!fs.existsSync(codebase.repo_path)) {
    logger.warn(`Repo path does not exist: ${codebase.repo_path}`)
    return { indexed: 0, skipped: 0 }
  }

  const headSha = getHeadSha(codebase.repo_path)
  if (!headSha) return { indexed: 0, skipped: 0 }
  if (headSha === codebase.last_commit_sha) {
    return { indexed: 0, skipped: 0, reason: 'no changes' }
  }

  const changedFiles = getChangedFiles(codebase.repo_path, codebase.last_commit_sha)
  if (changedFiles.length === 0 && codebase.last_commit_sha) {
    return { indexed: 0, skipped: 0, reason: 'no file changes' }
  }

  const safeFiles = await secretSafety.filterSafeFiles(changedFiles, codebase.repo_path)
  const filesToIndex = safeFiles.filter(f => !shouldSkipFile(f))

  let indexed = 0
  let skipped = 0

  for (const relPath of filesToIndex) {
    try {
      const absPath = path.join(codebase.repo_path, relPath)
      if (!fs.existsSync(absPath)) {
        await db`DELETE FROM code_chunks WHERE codebase_id = ${codebaseId} AND file_path = ${relPath}`
        continue
      }

      const stat = fs.statSync(absPath)
      if (stat.size > 500_000) {
        skipped++
        continue
      }

      const content = fs.readFileSync(absPath, 'utf-8')
      const language = detectLanguage(relPath)
      const safeContent = secretSafety.scrubSecrets(content)
      const chunks = chunkFile(safeContent, language)

      await db`DELETE FROM code_chunks WHERE codebase_id = ${codebaseId} AND file_path = ${relPath}`

      for (let i = 0; i < chunks.length; i++) {
        const chunk = chunks[i]
        const contentHash = crypto.createHash('sha256').update(chunk.content).digest('hex')

        await db`
          INSERT INTO code_chunks (codebase_id, file_path, chunk_index, content, content_hash, language, start_line, end_line, commit_sha)
          VALUES (${codebaseId}, ${relPath}, ${i}, ${chunk.content}, ${contentHash}, ${language}, ${chunk.startLine}, ${chunk.endLine}, ${headSha})
        `
      }

      indexed++
    } catch (err) {
      logger.debug(`Failed to index file ${relPath}`, { error: err.message })
      skipped++
    }
  }

  await db`
    UPDATE codebases
    SET last_indexed_at = now(), last_commit_sha = ${headSha}
    WHERE id = ${codebaseId}
  `

  logger.info(`Indexed codebase ${codebase.name}: ${indexed} files, ${skipped} skipped`, {
    codebaseId, headSha,
  })

  return { indexed, skipped, headSha }
}

// ─── Embedding ──────────────────────────────────────────────────────

async function embedStaleChunks(batchSize = 50) {
  if (!env.OPENAI_API_KEY) {
    logger.debug('Code chunk embedding skipped — no OpenAI API key')
    return 0
  }

  const staleChunks = await db`
    SELECT id, file_path, content, language
    FROM code_chunks
    WHERE embedding IS NULL
    ORDER BY indexed_at ASC
    LIMIT ${batchSize}
  `

  if (staleChunks.length === 0) return 0

  const texts = staleChunks.map(c => {
    const prefix = c.language ? `[${c.language}] ` : ''
    return `${prefix}${c.file_path}\n${c.content.slice(0, 8000)}`
  })

  try {
    const response = await axios.post(
      'https://api.openai.com/v1/embeddings',
      { model: 'text-embedding-3-small', input: texts },
      { headers: { Authorization: `Bearer ${env.OPENAI_API_KEY}` } }
    )

    const embeddings = response.data.data.map(d => d.embedding)

    for (let i = 0; i < staleChunks.length; i++) {
      if (embeddings[i]) {
        const vecStr = `[${embeddings[i].join(',')}]`
        await db`
          UPDATE code_chunks
          SET embedding = ${vecStr}::vector
          WHERE id = ${staleChunks[i].id}
        `
      }
    }

    logger.info(`Embedded ${staleChunks.length} code chunks`)
    return staleChunks.length
  } catch (err) {
    logger.warn('Code chunk embedding batch failed', { error: err.message })
    return 0
  }
}

// ─── Semantic Search ────────────────────────────────────────────────

async function queryCodebase(codebaseId, query, { limit = 20 } = {}) {
  if (!env.OPENAI_API_KEY) return []

  let queryEmbedding
  try {
    const response = await axios.post(
      'https://api.openai.com/v1/embeddings',
      { model: 'text-embedding-3-small', input: query },
      { headers: { Authorization: `Bearer ${env.OPENAI_API_KEY}` } }
    )
    queryEmbedding = response.data.data[0].embedding
  } catch (err) {
    logger.warn('Query embedding failed', { error: err.message })
    return []
  }

  const vecStr = `[${queryEmbedding.join(',')}]`
  const results = await db`
    SELECT
      id, file_path, chunk_index, content, language, start_line, end_line,
      1 - (embedding <=> ${vecStr}::vector) AS similarity
    FROM code_chunks
    WHERE codebase_id = ${codebaseId}
      AND embedding IS NOT NULL
    ORDER BY embedding <=> ${vecStr}::vector
    LIMIT ${limit}
  `

  return results
}

async function queryAllCodebases(query, { limit = 20 } = {}) {
  if (!env.OPENAI_API_KEY) return []

  let queryEmbedding
  try {
    const response = await axios.post(
      'https://api.openai.com/v1/embeddings',
      { model: 'text-embedding-3-small', input: query },
      { headers: { Authorization: `Bearer ${env.OPENAI_API_KEY}` } }
    )
    queryEmbedding = response.data.data[0].embedding
  } catch (err) {
    logger.warn('Query embedding failed', { error: err.message })
    return []
  }

  const vecStr = `[${queryEmbedding.join(',')}]`
  const results = await db`
    SELECT
      cc.id, cc.file_path, cc.chunk_index, cc.content, cc.language,
      cc.start_line, cc.end_line,
      cb.name AS codebase_name,
      1 - (cc.embedding <=> ${vecStr}::vector) AS similarity
    FROM code_chunks cc
    JOIN codebases cb ON cb.id = cc.codebase_id
    WHERE cc.embedding IS NOT NULL
    ORDER BY cc.embedding <=> ${vecStr}::vector
    LIMIT ${limit}
  `

  return results
}

// ─── Structure ──────────────────────────────────────────────────────

async function getCodebaseStructure(codebaseId) {
  const files = await db`
    SELECT DISTINCT file_path, language
    FROM code_chunks
    WHERE codebase_id = ${codebaseId}
    ORDER BY file_path ASC
  `

  const tree = {}
  for (const { file_path, language } of files) {
    const parts = file_path.split('/')
    let current = tree
    for (let i = 0; i < parts.length - 1; i++) {
      if (!current[parts[i]]) current[parts[i]] = {}
      current = current[parts[i]]
    }
    current[parts[parts.length - 1]] = language || 'file'
  }

  return { tree, fileCount: files.length }
}

// ─── Stats ──────────────────────────────────────────────────────────

async function getCodebaseStats(codebaseId) {
  const [stats] = await db`
    SELECT
      count(*)::int AS total_chunks,
      count(*) FILTER (WHERE embedding IS NOT NULL)::int AS embedded_chunks,
      count(DISTINCT file_path)::int AS total_files,
      count(DISTINCT language) FILTER (WHERE language IS NOT NULL)::int AS languages
    FROM code_chunks
    WHERE codebase_id = ${codebaseId}
  `
  return stats
}

module.exports = {
  syncCodebase,
  indexCodebase,
  embedStaleChunks,
  queryCodebase,
  queryAllCodebases,
  getCodebaseStructure,
  getCodebaseStats,
  getHeadSha,
  detectLanguage,
}
