const db = require('../config/db')
const logger = require('../config/logger')
const path = require('path')
const fs = require('fs')

// ═══════════════════════════════════════════════════════════════════════
// SECRET SAFETY SERVICE
//
// Three gates protect secrets from reaching any LLM:
// 1. File path check (before reading content)
// 2. Content scrubbing (before embedding or prompting)
// 3. Output post-filter (after CC session output)
//
// Uses DB-stored blocklist + .gitignore patterns.
// ═══════════════════════════════════════════════════════════════════════

let cachedBlocklist = null
let cacheExpiry = 0

async function getBlocklist() {
  if (cachedBlocklist && Date.now() < cacheExpiry) return cachedBlocklist
  const rows = await db`SELECT pattern FROM secret_blocklist`
  cachedBlocklist = rows.map(r => r.pattern)
  cacheExpiry = Date.now() + 5 * 60_000 // cache 5 min
  return cachedBlocklist
}

// ─── .gitignore Parsing ─────────────────────────────────────────────

function parseGitignore(repoPath) {
  const gitignorePath = path.join(repoPath, '.gitignore')
  try {
    const content = fs.readFileSync(gitignorePath, 'utf-8')
    return content
      .split('\n')
      .map(l => l.trim())
      .filter(l => l && !l.startsWith('#'))
  } catch {
    return []
  }
}

// ─── Glob Pattern Matching ──────────────────────────────────────────

function matchesGlob(filePath, pattern) {
  // Normalize path separators
  const normalized = filePath.replace(/\\/g, '/')

  // Convert glob to regex
  let regex = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&') // escape special chars (except * and ?)
    .replace(/\*\*/g, '{{GLOBSTAR}}')
    .replace(/\*/g, '[^/]*')
    .replace(/\?/g, '[^/]')
    .replace(/\{\{GLOBSTAR\}\}/g, '.*')

  // If pattern doesn't start with /, match anywhere in path
  if (!pattern.startsWith('/')) {
    regex = '(^|/)' + regex
  }

  try {
    return new RegExp(regex + '(/|$)', 'i').test(normalized)
  } catch {
    return false
  }
}

// ─── Gate 1: File Path Check ────────────────────────────────────────

async function isSecretPath(filePath, repoPath) {
  const blocklist = await getBlocklist()
  const gitignorePatterns = repoPath ? parseGitignore(repoPath) : []

  const allPatterns = [...blocklist, ...gitignorePatterns]

  for (const pattern of allPatterns) {
    if (matchesGlob(filePath, pattern)) {
      return true
    }
  }

  // Always block common secret file names regardless of pattern (case-insensitive)
  const basename = path.basename(filePath).toLowerCase()
  const hardBlocked = [
    '.env', '.env.local', '.env.production', '.env.development', '.env.staging', '.env.test',
    'credentials.json', 'service-account.json', 'serviceaccount.json', 'service_account.json',
    '.npmrc', '.pypirc', '.netrc', '.docker/config.json',
    'id_rsa', 'id_ed25519', 'id_ecdsa', 'id_dsa',
    '.htpasswd', 'shadow', 'passwd',
  ]
  if (hardBlocked.includes(basename)) return true
  // Block any .env.* variant
  if (basename.startsWith('.env.') || basename === '.env') return true

  return false
}

// ─── Gate 2: Content Scrubbing ──────────────────────────────────────

const SECRET_PATTERNS = [
  // API keys (various formats) — bounded quantifiers to prevent ReDoS
  /(?:api[_-]?key|apikey|api_secret)\s*[:=]\s*['"]?[\w\-./+=]{20,256}['"]?/gi,
  // Bearer tokens
  /Bearer\s+[\w\-./+=]{20,512}/g,
  // AWS keys
  /AKIA[0-9A-Z]{16}/g,
  /(?:aws_secret_access_key|aws_access_key_id)\s*[:=]\s*['"]?[\w/+=]{20,256}['"]?/gi,
  // Private keys
  /-----BEGIN (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----[\s\S]{10,8192}?-----END (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----/g,
  // JWT tokens (3 base64 segments)
  /eyJ[A-Za-z0-9_-]{10,512}\.[A-Za-z0-9_-]{10,512}\.[A-Za-z0-9_-]{10,512}/g,
  // Generic secret assignments — bounded value length
  /(?:password|passwd|pwd|secret|token|auth_token|access_token|refresh_token)\s*[:=]\s*['"][^'"]{8,256}['"]/gi,
  // Connection strings with credentials (postgres, postgresql, mysql, mongodb, mongodb+srv, redis, amqp)
  /(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis|amqp):\/\/[^:]+:[^@]+@[^\s'"]{1,512}/gi,
  // Anthropic/OpenAI keys
  /sk-[a-zA-Z0-9]{20,128}/g,
  /sk-ant-[a-zA-Z0-9\-]{20,128}/g,
  // Google API keys
  /AIza[0-9A-Za-z\-_]{35}/g,
  // GitHub tokens
  /gh[ps]_[A-Za-z0-9_]{36,255}/g,
  // Supabase keys
  /sbp_[a-f0-9]{40}/g,
]

function scrubSecrets(content) {
  let scrubbed = content
  for (const pattern of SECRET_PATTERNS) {
    scrubbed = scrubbed.replace(pattern, '[REDACTED]')
  }
  return scrubbed
}

// ─── Gate 3: Content Safety Validation ──────────────────────────────

function validateContentSafety(content) {
  for (const pattern of SECRET_PATTERNS) {
    // Reset lastIndex for global regexes
    pattern.lastIndex = 0
    if (pattern.test(content)) {
      return false
    }
  }
  return true
}

// ─── Bulk File Filter ───────────────────────────────────────────────

async function filterSafeFiles(filePaths, repoPath) {
  const safe = []
  for (const fp of filePaths) {
    if (!(await isSecretPath(fp, repoPath))) {
      safe.push(fp)
    }
  }
  return safe
}

module.exports = {
  isSecretPath,
  scrubSecrets,
  validateContentSafety,
  filterSafeFiles,
  getBlocklist,
}
