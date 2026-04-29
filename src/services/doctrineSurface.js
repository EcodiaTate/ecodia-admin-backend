/**
 * Doctrine Surface — keyword-grep doctrine injection for conductor-prompt ingresses.
 *
 * This is the Node-side counterpart to ~/ecodiaos/scripts/hooks/brief-consistency-check.sh
 * (specifically Check 5, the [CONTEXT-SURFACE WARN] block). It walks the same
 * doctrine corpus (patterns/, clients/, docs/secrets/), reads `triggers:` frontmatter
 * keywords from each .md file, and finds files whose triggers match tokens in an
 * incoming prompt or message.
 *
 * Used by:
 *   - schedulerPollerService.fireTask  (cron-fire prompt ingress)
 *   - osSessionService._sendMessageImpl (Tate-message + drained-queue ingress)
 *
 * Both ingresses funnel into the conductor's user-message stream. This module
 * surfaces relevant durable doctrine at the moment the prompt arrives, so the
 * conductor sees keyword-matched files BEFORE the unconditional <recent_doctrine>
 * (recency) and <relevant_memory> (Neo4j semantic) blocks already injected by
 * osSessionService.
 *
 * Design constraints (per drafts/context-surface-injection-points-recon-2026-04-29.md):
 *   - Sub-100ms typical. Caches the keyword index in module scope, mtime-invalidated.
 *   - Strips [APPLIED] / [NOT-APPLIED] / [BRIEF-CHECK WARN] / [CONTEXT-SURFACE WARN]
 *     / [CRED-SURFACE WARN] / [FORCING WARN] tag lines BEFORE scanning, mirroring
 *     ~/ecodiaos/patterns/hooks-must-not-fire-inside-applied-pattern-tags.md.
 *   - Capped at 6 surfaces by default (configurable) to avoid flooding.
 *   - Skips trivially-short keywords (<4 chars) to avoid common-letter false positives.
 *   - Suppresses files whose basename or path is already referenced in the prompt
 *     (mirrors brief-consistency-check.sh suppression rule).
 *
 * Public API:
 *   surfaceDoctrineForPrompt(text, options?) → string|null
 *     Returns the body for a <doctrine_surface>...</doctrine_surface> block,
 *     or null if 0 hits / disabled.
 *   surfaceDoctrineBlock(text, options?) → string|null
 *     Convenience: returns the fully-wrapped <doctrine_surface> block or null.
 *   matchedFiles(text, options?) → array
 *     Returns structured matches for telemetry/tests.
 *   stripTagLines(text) → string
 *     Strips tag-prefix lines from input text.
 *
 * Env:
 *   OS_DOCTRINE_SURFACE_ENABLED (default 'true') — set to 'false' to disable.
 */

const fs = require('fs')
const path = require('path')

const DOCTRINE_DIRS = [
  '/home/tate/ecodiaos/patterns',
  '/home/tate/ecodiaos/clients',
  '/home/tate/ecodiaos/docs/secrets',
]

const DEFAULT_MAX_SURFACES = 6
const MIN_KEYWORD_LENGTH = 4

// Tag-line prefixes to strip before scanning. Lines starting with these (after
// optional leading whitespace) are removed entirely from the scan text.
// Mirrors ~/ecodiaos/scripts/hooks/lib/strip-tag-lines.sh discipline (per
// patterns/hooks-must-not-fire-inside-applied-pattern-tags.md).
const TAG_LINE_PREFIXES = [
  '[APPLIED]',
  '[NOT-APPLIED]',
  '[BRIEF-CHECK WARN]',
  '[BRIEF-CHECK INFO]',
  '[CONTEXT-SURFACE WARN]',
  '[CONTEXT-SURFACE PRIMARY]',
  '[CONTEXT-SURFACE ALSO]',
  '[CRED-SURFACE WARN]',
  '[FORCING WARN]',
  '[FORK-NUDGE]',
  '[STATUS-BOARD-CONTEXT SUGGEST]',
  '[DOCTRINE-CROSS-REF SUGGEST]',
  '[MACRO-VALIDATION WARN]',
  '[COWORK-FIRST WARN]',
  '[ANTHROPIC-FIRST WARN]',
  '[INFO]',
]

// Cache shape:
//   { entries: [{file, base, dir, keywords:[lc strings]}], mtime: max-mtime }
// Module-scoped so repeated calls don't re-walk the corpus.
let _cache = null

/**
 * Strip tag lines from input text. A tag line is one whose first non-whitespace
 * content matches one of TAG_LINE_PREFIXES. Returns the cleaned text.
 */
function stripTagLines(text) {
  if (!text || typeof text !== 'string') return ''
  const lines = text.split('\n')
  const kept = []
  for (const line of lines) {
    const trimmed = line.trimStart()
    let isTag = false
    for (const prefix of TAG_LINE_PREFIXES) {
      if (trimmed.startsWith(prefix)) {
        isTag = true
        break
      }
    }
    if (!isTag) kept.push(line)
  }
  return kept.join('\n')
}

/**
 * Read the triggers: line from a .md file's first 10 lines and tokenise it.
 * Returns an array of lowercased keywords (length >= MIN_KEYWORD_LENGTH, no
 * glob/wildcard chars).
 */
function readTriggers(filePath) {
  let header
  try {
    const fd = fs.openSync(filePath, 'r')
    const buf = Buffer.alloc(2048)
    const n = fs.readSync(fd, buf, 0, buf.length, 0)
    fs.closeSync(fd)
    header = buf.slice(0, n).toString('utf8')
  } catch {
    return []
  }
  const lines = header.split('\n').slice(0, 10)
  const trigLine = lines.find(l => /^triggers:/i.test(l.trim()))
  if (!trigLine) return []
  const body = trigLine.replace(/^triggers:\s*/i, '').trim()
  if (!body) return []
  const out = []
  for (const raw of body.split(',')) {
    const kw = raw.trim().toLowerCase()
    if (kw.length < MIN_KEYWORD_LENGTH) continue
    if (/[*?[\]]/.test(kw)) continue
    out.push(kw)
  }
  return out
}

/**
 * Walk doctrine dirs and build the keyword index. Returns the index plus the
 * max mtime observed (used as the cache invalidation key).
 */
function buildIndex() {
  const entries = []
  let maxMtime = 0
  for (const dir of DOCTRINE_DIRS) {
    let stat
    try { stat = fs.statSync(dir) } catch { continue }
    if (!stat.isDirectory()) continue
    if (stat.mtimeMs > maxMtime) maxMtime = stat.mtimeMs
    let files
    try { files = fs.readdirSync(dir) } catch { continue }
    for (const f of files) {
      if (!f.endsWith('.md')) continue
      if (f === 'INDEX.md') continue
      const full = path.join(dir, f)
      let fstat
      try { fstat = fs.statSync(full) } catch { continue }
      if (!fstat.isFile()) continue
      if (fstat.mtimeMs > maxMtime) maxMtime = fstat.mtimeMs
      const keywords = readTriggers(full)
      if (keywords.length === 0) continue
      entries.push({
        file: full,
        base: f,
        dir: path.basename(dir),
        keywords,
      })
    }
  }
  return { entries, mtime: maxMtime }
}

/**
 * Get the keyword index, rebuilding if any doctrine dir or entry mtime has
 * advanced past the cached mtime. Catches additions, deletions, edits.
 */
function getIndex() {
  if (_cache) {
    let staleNeeded = false
    for (const dir of DOCTRINE_DIRS) {
      try {
        const s = fs.statSync(dir)
        if (s.mtimeMs > _cache.mtime) { staleNeeded = true; break }
      } catch { staleNeeded = true; break }
    }
    if (!staleNeeded) {
      for (const entry of _cache.entries) {
        try {
          const s = fs.statSync(entry.file)
          if (s.mtimeMs > _cache.mtime) { staleNeeded = true; break }
        } catch { staleNeeded = true; break }
      }
    }
    if (!staleNeeded) return _cache
  }
  _cache = buildIndex()
  return _cache
}

/**
 * Read a short body summary from a .md file (first non-trivial content line
 * after frontmatter and the first H1).
 */
function readShortDescription(filePath, maxLen = 140) {
  try {
    const fd = fs.openSync(filePath, 'r')
    const buf = Buffer.alloc(4096)
    const n = fs.readSync(fd, buf, 0, buf.length, 0)
    fs.closeSync(fd)
    const text = buf.slice(0, n).toString('utf8')
    const lines = text.split('\n')
    let inFrontmatter = false
    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed) continue
      if (trimmed === '---') { inFrontmatter = !inFrontmatter; continue }
      if (inFrontmatter) continue
      if (trimmed.startsWith('triggers:')) continue
      if (trimmed.startsWith('# ')) continue
      const collapsed = trimmed.replace(/\s+/g, ' ')
      return collapsed.length > maxLen
        ? collapsed.slice(0, maxLen) + '…'
        : collapsed
    }
  } catch {}
  return ''
}

/**
 * Surface durable doctrine relevant to a prompt by keyword-greping the doctrine
 * corpus. Designed for sub-100ms typical execution.
 *
 * @param {string} text - prompt or message body
 * @param {object} [options]
 * @param {number} [options.maxSurfaces=6] - cap on number of files surfaced
 * @param {string[]} [options.skipDirs] - basenames of doctrine subdirs to skip
 * @returns {string|null} The body for a <doctrine_surface> block, or null
 */
function surfaceDoctrineForPrompt(text, options = {}) {
  if (process.env.OS_DOCTRINE_SURFACE_ENABLED === 'false') return null
  if (!text || typeof text !== 'string') return null
  const maxSurfaces = options.maxSurfaces || DEFAULT_MAX_SURFACES
  const skipDirs = new Set(options.skipDirs || [])

  // Strip tag lines first so the surface doesn't fire inside its own
  // [APPLIED] / [CONTEXT-SURFACE WARN] explanations.
  const cleaned = stripTagLines(text)
  if (!cleaned.trim()) return null
  const lc = cleaned.toLowerCase()

  const { entries } = getIndex()
  // For each doctrine file, find every keyword that hits in the prompt.
  // Suppress files whose basename or full path is already referenced.
  const hits = []
  for (const entry of entries) {
    if (skipDirs.has(entry.dir)) continue
    if (cleaned.includes(entry.base)) continue
    if (cleaned.includes(entry.file)) continue
    const matchedKeywords = []
    for (const kw of entry.keywords) {
      if (lc.includes(kw)) matchedKeywords.push(kw)
    }
    if (matchedKeywords.length > 0) {
      hits.push({
        file: entry.file,
        base: entry.base,
        dir: entry.dir,
        matchedKeywords,
      })
    }
  }
  if (hits.length === 0) return null

  // Sort by keyword-match count desc (frequency-weighted), then by basename
  // ascending for stability.
  hits.sort((a, b) => {
    if (b.matchedKeywords.length !== a.matchedKeywords.length) {
      return b.matchedKeywords.length - a.matchedKeywords.length
    }
    return a.base.localeCompare(b.base)
  })

  const top = hits.slice(0, maxSurfaces)
  const lines = []
  lines.push('This message mentions trigger keywords from the following durable doctrine files. Read any that apply BEFORE acting:')
  lines.push('')
  for (const h of top) {
    const desc = readShortDescription(h.file)
    const kwSummary = h.matchedKeywords.slice(0, 3).join(', ')
    const kwExtra = h.matchedKeywords.length > 3 ? ` (+${h.matchedKeywords.length - 3} more)` : ''
    const descSuffix = desc ? `\n   ${desc}` : ''
    lines.push(`- ${h.file} (matched: ${kwSummary}${kwExtra})${descSuffix}`)
  }
  if (hits.length > maxSurfaces) {
    lines.push('')
    lines.push(`(${hits.length - maxSurfaces} additional matches suppressed by maxSurfaces=${maxSurfaces} cap.)`)
  }
  return lines.join('\n')
}

/**
 * Surface as a fully-wrapped <doctrine_surface> block. Convenience wrapper.
 * Returns null if no surfaces.
 */
function surfaceDoctrineBlock(text, options = {}) {
  const body = surfaceDoctrineForPrompt(text, options)
  if (!body) return null
  return `<doctrine_surface>\n${body}\n</doctrine_surface>`
}

/**
 * For telemetry and tests: return the matched files as a structured array,
 * not a formatted block.
 */
function matchedFiles(text, options = {}) {
  if (process.env.OS_DOCTRINE_SURFACE_ENABLED === 'false') return []
  if (!text || typeof text !== 'string') return []
  const maxSurfaces = options.maxSurfaces || DEFAULT_MAX_SURFACES
  const skipDirs = new Set(options.skipDirs || [])
  const cleaned = stripTagLines(text)
  if (!cleaned.trim()) return []
  const lc = cleaned.toLowerCase()
  const { entries } = getIndex()
  const hits = []
  for (const entry of entries) {
    if (skipDirs.has(entry.dir)) continue
    if (cleaned.includes(entry.base)) continue
    if (cleaned.includes(entry.file)) continue
    const matchedKeywords = []
    for (const kw of entry.keywords) {
      if (lc.includes(kw)) matchedKeywords.push(kw)
    }
    if (matchedKeywords.length > 0) {
      hits.push({
        file: entry.file,
        base: entry.base,
        dir: entry.dir,
        matchedKeywords,
      })
    }
  }
  hits.sort((a, b) => {
    if (b.matchedKeywords.length !== a.matchedKeywords.length) {
      return b.matchedKeywords.length - a.matchedKeywords.length
    }
    return a.base.localeCompare(b.base)
  })
  return hits.slice(0, maxSurfaces)
}

// Test-only: clear the module-scoped cache.
function _clearCacheForTest() { _cache = null }

module.exports = {
  surfaceDoctrineForPrompt,
  surfaceDoctrineBlock,
  matchedFiles,
  stripTagLines,
  _clearCacheForTest,
}
