const { execFileSync } = require('child_process')
const fs = require('fs')
const path = require('path')
const db = require('../config/db')
const logger = require('../config/logger')

// ═══════════════════════════════════════════════════════════════════════
// VALIDATION SERVICE
//
// Runs automated tests, lint, and type-checks after CC makes changes.
// Produces a confidence score (0.0 - 1.0) used to gate deployment.
// ═══════════════════════════════════════════════════════════════════════

const TEST_TIMEOUT = 5 * 60 * 1000   // 5 min
const LINT_TIMEOUT = 60 * 1000        // 1 min
const TYPECHECK_TIMEOUT = 2 * 60 * 1000 // 2 min

function runCommand(cmd, args, cwd, timeout) {
  try {
    const output = execFileSync(cmd, args, {
      cwd,
      encoding: 'utf-8',
      timeout,
      maxBuffer: 5 * 1024 * 1024,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    return { passed: true, output: output.slice(-5000), exitCode: 0 }
  } catch (err) {
    return {
      passed: false,
      output: (err.stdout || err.stderr || err.message || '').slice(-5000),
      exitCode: err.status || 1,
    }
  }
}

function detectProjectType(repoPath) {
  const hasFile = (f) => fs.existsSync(path.join(repoPath, f))

  if (hasFile('package.json')) {
    const pkg = JSON.parse(fs.readFileSync(path.join(repoPath, 'package.json'), 'utf-8'))
    return {
      runtime: 'node',
      hasTests: !!pkg.scripts?.test,
      hasLint: !!pkg.scripts?.lint || hasFile('.eslintrc.js') || hasFile('.eslintrc.json') || hasFile('eslint.config.js') || hasFile('eslint.config.mjs'),
      hasTypecheck: hasFile('tsconfig.json'),
      hasPlaywright: hasFile('playwright.config.ts') || hasFile('playwright.config.js'),
      testCmd: pkg.scripts?.test ? ['npm', ['test', '--', '--passWithNoTests']] : null,
      lintCmd: pkg.scripts?.lint ? ['npm', ['run', 'lint']] : hasFile('eslint.config.js') || hasFile('eslint.config.mjs') ? ['npx', ['eslint', '.']] : null,
      typecheckCmd: hasFile('tsconfig.json') ? ['npx', ['tsc', '--noEmit']] : null,
    }
  }

  if (hasFile('pyproject.toml') || hasFile('setup.py') || hasFile('requirements.txt')) {
    return {
      runtime: 'python',
      hasTests: hasFile('tests') || hasFile('test'),
      hasLint: true,
      hasTypecheck: hasFile('mypy.ini') || hasFile('pyproject.toml'),
      hasPlaywright: false,
      testCmd: ['python', ['-m', 'pytest', '--tb=short', '-q']],
      lintCmd: ['ruff', ['check', '.']],
      typecheckCmd: hasFile('mypy.ini') || hasFile('pyproject.toml') ? ['mypy', ['.']] : null,
    }
  }

  if (hasFile('Cargo.toml')) {
    return {
      runtime: 'rust',
      hasTests: true,
      hasLint: true,
      hasTypecheck: false,
      hasPlaywright: false,
      testCmd: ['cargo', ['test']],
      lintCmd: ['cargo', ['clippy']],
      typecheckCmd: null,
    }
  }

  return { runtime: 'unknown', hasTests: false, hasLint: false, hasTypecheck: false, hasPlaywright: false }
}

async function validateChanges(sessionId) {
  const startTime = Date.now()

  const [session] = await db`
    SELECT cs.*, cb.repo_path, cb.language
    FROM cc_sessions cs
    LEFT JOIN codebases cb ON cs.codebase_id = cb.id
    WHERE cs.id = ${sessionId}
  `

  if (!session) throw new Error(`Session ${sessionId} not found`)

  const repoPath = session.repo_path || session.working_dir
  if (!repoPath || !fs.existsSync(repoPath)) {
    throw new Error(`No valid repo path for session ${sessionId}`)
  }

  const project = detectProjectType(repoPath)
  const results = {
    testPassed: null, testOutput: null, testExitCode: null,
    lintPassed: null, lintOutput: null,
    typecheckPassed: null, typecheckOutput: null,
    playwrightPassed: null,
  }

  // Run tests
  if (project.hasTests && project.testCmd) {
    const [cmd, args] = project.testCmd
    const testResult = runCommand(cmd, args, repoPath, TEST_TIMEOUT)
    results.testPassed = testResult.passed
    results.testOutput = testResult.output
    results.testExitCode = testResult.exitCode
    logger.info(`Validation tests: ${testResult.passed ? 'PASS' : 'FAIL'}`, { sessionId })
  }

  // Run linter
  if (project.hasLint && project.lintCmd) {
    const [cmd, args] = project.lintCmd
    const lintResult = runCommand(cmd, args, repoPath, LINT_TIMEOUT)
    results.lintPassed = lintResult.passed
    results.lintOutput = lintResult.output
    logger.info(`Validation lint: ${lintResult.passed ? 'PASS' : 'FAIL'}`, { sessionId })
  }

  // Run type-check
  if (project.hasTypecheck && project.typecheckCmd) {
    const [cmd, args] = project.typecheckCmd
    const typeResult = runCommand(cmd, args, repoPath, TYPECHECK_TIMEOUT)
    results.typecheckPassed = typeResult.passed
    results.typecheckOutput = typeResult.output
    logger.info(`Validation typecheck: ${typeResult.passed ? 'PASS' : 'FAIL'}`, { sessionId })
  }

  // Confidence score
  let confidence = 0
  if (results.testPassed === true) confidence += 0.4
  else if (results.testPassed === null) confidence += 0.2 // no tests = partial credit
  if (results.lintPassed === true) confidence += 0.2
  else if (results.lintPassed === null) confidence += 0.1
  if (results.typecheckPassed === true) confidence += 0.2
  else if (results.typecheckPassed === null) confidence += 0.1
  if (results.playwrightPassed === true) confidence += 0.1
  else if (results.playwrightPassed === null) confidence += 0.05
  // Bonus for no failures at all
  const anyFailed = [results.testPassed, results.lintPassed, results.typecheckPassed].some(v => v === false)
  if (!anyFailed) confidence += 0.1
  confidence = Math.min(confidence, 1.0)

  const durationMs = Date.now() - startTime

  // Store results
  await db`
    INSERT INTO validation_runs (cc_session_id, codebase_id, test_passed, test_output, test_exit_code,
      lint_passed, lint_output, typecheck_passed, typecheck_output, playwright_passed, confidence_score, duration_ms)
    VALUES (${sessionId}, ${session.codebase_id}, ${results.testPassed}, ${results.testOutput}, ${results.testExitCode},
      ${results.lintPassed}, ${results.lintOutput}, ${results.typecheckPassed}, ${results.typecheckOutput},
      ${results.playwrightPassed}, ${confidence}, ${durationMs})
  `

  // Update session
  await db`
    UPDATE cc_sessions
    SET confidence_score = ${confidence}, pipeline_stage = 'testing'
    WHERE id = ${sessionId}
  `

  logger.info(`Validation complete for session ${sessionId}: confidence=${confidence.toFixed(2)}`, {
    testPassed: results.testPassed, lintPassed: results.lintPassed,
    typecheckPassed: results.typecheckPassed, durationMs,
  })

  return { ...results, confidence, durationMs }
}

module.exports = { validateChanges, detectProjectType }
