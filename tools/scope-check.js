#!/usr/bin/env node
//
// tools/scope-check.js
//
// Pre-push scope-diff checker. Hard-fails if a git diff touches files
// outside a declared scope list. Use before pushing to client repos
// (e.g. Ordit at bitbucket.org/fireauditors1/be) to catch scope creep
// before a PR lands.
//
// Usage:
//   node tools/scope-check.js --scope-file <path> [options]
//
// Options:
//   --scope-file <path>   Required. Plain text file, one glob/path per line.
//                         Lines starting with # are comments. Blank lines ignored.
//                         Entries ending in / match any file under that directory.
//   --base <ref>          Git ref to diff from (default: origin/uat)
//   --head <ref>          Git ref to diff to   (default: HEAD)
//   --cwd <dir>           Target repo directory (default: current dir)
//   --help                Print this help and exit
//
// Scope file example:
//   # Ordit PR 213 - Cognito observability
//   src/users/users.service.ts
//   src/users/dto/*.ts
//   src/auth/auth.service.ts
//
// Exit codes:
//   0 = all changed files are IN_SCOPE
//   1 = one or more OUT_OF_SCOPE files, or fatal error
//

'use strict'

const { execFileSync } = require('child_process')
const fs = require('fs')
const path = require('path')
const minimatch = require('minimatch')

// ── Help ─────────────────────────────────────────────────────────────

const args = process.argv.slice(2)

if (args.includes('--help') || args.includes('-h')) {
  printUsage()
  process.exit(0)
}

// ── Arg parsing ──────────────────────────────────────────────────────

function getArg(flag) {
  const idx = args.indexOf(flag)
  return idx !== -1 ? args[idx + 1] || null : null
}

const scopeFile = getArg('--scope-file')
const base      = getArg('--base') || 'origin/uat'
const head      = getArg('--head') || 'HEAD'
const cwdArg    = getArg('--cwd')
const cwd       = cwdArg ? path.resolve(cwdArg) : process.cwd()

if (!scopeFile) {
  console.error('ERROR: --scope-file is required')
  printUsage()
  process.exit(1)
}

// ── Load scope patterns ──────────────────────────────────────────────

const scopeFilePath = path.resolve(scopeFile)

if (!fs.existsSync(scopeFilePath)) {
  console.error(`ERROR: scope file not found: ${scopeFilePath}`)
  process.exit(1)
}

const patterns = fs.readFileSync(scopeFilePath, 'utf-8')
  .split('\n')
  .map(l => l.trim())
  .filter(l => l && !l.startsWith('#'))

if (patterns.length === 0) {
  console.error('ERROR: scope file has no patterns (all lines are blank or comments)')
  process.exit(1)
}

// ── Get changed files ────────────────────────────────────────────────

let changedFiles
try {
  const out = execFileSync(
    'git', ['diff', '--name-only', `${base}...${head}`],
    { cwd, encoding: 'utf-8', maxBuffer: 10 * 1024 * 1024 }
  ).trim()
  changedFiles = out ? out.split('\n') : []
} catch (err) {
  console.error(`ERROR: git diff failed (is --base "${base}" reachable?): ${err.message}`)
  process.exit(1)
}

if (changedFiles.length === 0) {
  console.log(`No changed files between ${base}...${head}. Nothing to check.`)
  process.exit(0)
}

// ── Match each file against scope patterns ───────────────────────────

function inScope(filePath) {
  for (const pattern of patterns) {
    // Entries ending in / match any file under that directory
    const glob = pattern.endsWith('/') ? `${pattern}**` : pattern
    if (minimatch(filePath, glob, { dot: true })) return true
    // Exact match as belt-and-braces (minimatch handles this but be explicit)
    if (filePath === pattern) return true
  }
  return false
}

const results = changedFiles.map(f => ({
  file: f,
  status: inScope(f) ? 'IN_SCOPE' : 'OUT_OF_SCOPE',
}))

const outOfScope = results.filter(r => r.status === 'OUT_OF_SCOPE')

// ── Print results table ──────────────────────────────────────────────

const maxFileLen = Math.max(...results.map(r => r.file.length), 4)

console.log(`\nDiff: ${base}...${head}  (${changedFiles.length} file${changedFiles.length === 1 ? '' : 's'})`)
console.log(`Scope file: ${scopeFilePath}  (${patterns.length} pattern${patterns.length === 1 ? '' : 's'})\n`)
console.log(`${'STATUS'.padEnd(12)} | FILE`)
console.log(`${'-'.repeat(12)}-+-${'-'.repeat(Math.min(maxFileLen, 100))}`)

for (const { file, status } of results) {
  const label = status === 'OUT_OF_SCOPE' ? `OUT_OF_SCOPE` : 'IN_SCOPE'
  console.log(`${label.padEnd(12)} | ${file}`)
}

// ── Final verdict ────────────────────────────────────────────────────

if (outOfScope.length > 0) {
  console.log(`
> ERROR: ${outOfScope.length} file${outOfScope.length === 1 ? '' : 's'} outside declared scope. Either:
> - Update the scope file to include these paths (if they really belong in this PR)
> - Revert the changes to these files (if they were improvised)
> - Split into a second PR (if they are a separate platform concern)`)
  process.exit(1)
}

console.log(`\nAll ${changedFiles.length} file${changedFiles.length === 1 ? '' : 's'} IN_SCOPE. Good to push.`)
process.exit(0)

// ── Usage ────────────────────────────────────────────────────────────

function printUsage() {
  console.log(`
Usage: node tools/scope-check.js --scope-file <path> [options]

Options:
  --scope-file <path>   Required. Plain text file, one glob/path per line.
                        Lines starting with # are comments. Blank lines ignored.
                        Entries ending in / match any file under that directory.
  --base <ref>          Git ref to diff from (default: origin/uat)
  --head <ref>          Git ref to diff to   (default: HEAD)
  --cwd <dir>           Target repo directory (default: current dir)
  --help                Print this help and exit

Scope file example:
  # Ordit PR 213 - Cognito observability
  src/users/users.service.ts
  src/users/dto/*.ts
  src/auth/auth.service.ts
  src/auth/

Exit codes:
  0 = all changed files are IN_SCOPE
  1 = one or more OUT_OF_SCOPE files, or fatal error
`.trim())
}
