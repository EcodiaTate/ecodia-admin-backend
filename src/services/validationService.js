const { execFileSync } = require('child_process')
const fs = require('fs')
const path = require('path')
const db = require('../config/db')
const logger = require('../config/logger')
const env = require('../config/env')

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
    const timedOut = err.killed || /ETIMEDOUT|timed out/i.test(err.message)
    return {
      passed: false,
      output: (err.stdout || err.stderr || err.message || '').slice(-5000),
      exitCode: err.status || 1,
      timedOut,
    }
  }
}

function detectProjectType(repoPath) {
  const hasFile = (f) => fs.existsSync(path.join(repoPath, f))
  const hasDir = (d) => fs.existsSync(path.join(repoPath, d)) && fs.statSync(path.join(repoPath, d)).isDirectory()

  // Check if deps are installed (no point running tests without them)
  const hasDeps = hasDir('node_modules') || hasDir('venv') || hasDir('.venv') || hasDir('target')

  if (hasFile('package.json')) {
    let pkg
    try {
      pkg = JSON.parse(fs.readFileSync(path.join(repoPath, 'package.json'), 'utf-8'))
    } catch {
      return { runtime: 'node', hasTests: false, hasLint: false, hasTypecheck: false, hasPlaywright: false, depsInstalled: false }
    }
    const depsReady = hasDir('node_modules')
    return {
      runtime: 'node',
      depsInstalled: depsReady,
      hasTests: depsReady && !!pkg.scripts?.test,
      hasLint: depsReady && (!!pkg.scripts?.lint || hasFile('.eslintrc.js') || hasFile('.eslintrc.json') || hasFile('eslint.config.js') || hasFile('eslint.config.mjs')),
      hasTypecheck: depsReady && hasFile('tsconfig.json'),
      hasPlaywright: depsReady && (hasFile('playwright.config.ts') || hasFile('playwright.config.js')),
      testCmd: depsReady && pkg.scripts?.test ? ['npm', ['test', '--', '--passWithNoTests']] : null,
      lintCmd: depsReady && pkg.scripts?.lint ? ['npm', ['run', 'lint']] : depsReady && (hasFile('eslint.config.js') || hasFile('eslint.config.mjs')) ? ['npx', ['eslint', '.']] : null,
      typecheckCmd: depsReady && hasFile('tsconfig.json') ? ['npx', ['tsc', '--noEmit']] : null,
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

  // Confidence score — heuristic baseline, then blend with historical outcomes
  const W = {
    baselineNoDeps:   parseFloat(env.VALIDATION_BASELINE_NO_DEPS       || '0.55'),
    testsPass:        parseFloat(env.VALIDATION_WEIGHT_TESTS_PASS       || '0.4'),
    testsNull:        parseFloat(env.VALIDATION_WEIGHT_TESTS_NULL       || '0.2'),
    lintPass:         parseFloat(env.VALIDATION_WEIGHT_LINT_PASS        || '0.2'),
    lintNull:         parseFloat(env.VALIDATION_WEIGHT_LINT_NULL        || '0.1'),
    typecheckPass:    parseFloat(env.VALIDATION_WEIGHT_TYPECHECK_PASS   || '0.2'),
    typecheckNull:    parseFloat(env.VALIDATION_WEIGHT_TYPECHECK_NULL   || '0.1'),
    playwrightPass:   parseFloat(env.VALIDATION_WEIGHT_PLAYWRIGHT_PASS  || '0.1'),
    playwrightNull:   parseFloat(env.VALIDATION_WEIGHT_PLAYWRIGHT_NULL  || '0.05'),
    allPassBonus:     parseFloat(env.VALIDATION_WEIGHT_ALL_PASS_BONUS   || '0.1'),
    historyMinSamples: parseInt(env.VALIDATION_HISTORY_MIN_SAMPLES     || '5', 10),
    historyMaxSamples: parseInt(env.VALIDATION_HISTORY_MAX_SAMPLES     || '50', 10),
    historyMinWeight:  parseFloat(env.VALIDATION_HISTORY_MIN_WEIGHT    || '0.3'),
  }

  let heuristic = 0
  const noDepsInstalled = !project.depsInstalled

  if (noDepsInstalled) {
    heuristic = W.baselineNoDeps
    logger.info(`Validation: deps not installed for ${project.runtime} project — baseline confidence ${heuristic}`, { sessionId })
  } else {
    if (results.testPassed === true) heuristic += W.testsPass
    else if (results.testPassed === null) heuristic += W.testsNull
    if (results.lintPassed === true) heuristic += W.lintPass
    else if (results.lintPassed === null) heuristic += W.lintNull
    if (results.typecheckPassed === true) heuristic += W.typecheckPass
    else if (results.typecheckPassed === null) heuristic += W.typecheckNull
    if (results.playwrightPassed === true) heuristic += W.playwrightPass
    else if (results.playwrightPassed === null) heuristic += W.playwrightNull
    const anyFailed = [results.testPassed, results.lintPassed, results.typecheckPassed].some(v => v === false)
    if (!anyFailed) heuristic += W.allPassBonus
  }
  heuristic = Math.min(heuristic, 1.0)

  // Blend with historical outcome data (learned confidence)
  let confidence = heuristic
  try {
    const [history] = await db`
      SELECT
        count(*) FILTER (WHERE outcome = 'success')::int AS successes,
        count(*)::int AS total
      FROM validation_runs
      WHERE codebase_id = ${session.codebase_id}
        AND test_passed IS NOT DISTINCT FROM ${results.testPassed}
        AND lint_passed IS NOT DISTINCT FROM ${results.lintPassed}
        AND outcome IS NOT NULL
    `

    if (history.total >= W.historyMinSamples) {
      const historicalRate = history.successes / history.total
      // Weight shifts from 100% heuristic → min weight as data accumulates
      const heuristicWeight = Math.max(W.historyMinWeight, 1.0 - (history.total / W.historyMaxSamples))
      confidence = (heuristic * heuristicWeight) + (historicalRate * (1 - heuristicWeight))

      // No floor cap: if historical data screams 0% success, let confidence go there.
      // The oversight pipeline needs to know the truth — blocking at 0.4 hides real failure signals.

      logger.info(`Validation confidence: heuristic=${heuristic.toFixed(2)}, historical=${historicalRate.toFixed(2)} (n=${history.total}), blended=${confidence.toFixed(2)}`, { sessionId })
    }
  } catch (err) {
    logger.debug('Historical confidence lookup failed (using heuristic)', { error: err.message })
  }

  confidence = Number.isFinite(confidence) ? Math.max(0, Math.min(confidence, 1.0)) : heuristic

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
