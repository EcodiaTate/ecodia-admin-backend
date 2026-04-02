const { spawn } = require('child_process')
const path = require('path')
const fs = require('fs')
const db = require('../config/db')
const logger = require('../config/logger')

// Playwright test runner — executes E2E tests on behalf of CC sessions.
// Spawns `npx playwright test` and streams output, capturing pass/fail results.
// Stores results in playwright_runs table for historical confidence scoring.

const PLAYWRIGHT_TIMEOUT = 3 * 60 * 1000  // 3 min max

async function runTests({ spec, url, projectId, ccSessionId }) {
  if (!spec && !url) {
    logger.debug('Playwright: no spec or url provided, skipping')
    return { passed: [], failed: [], exitCode: null, skipped: true }
  }

  const startTime = Date.now()
  let playwrightConfig = null

  // Find playwright config in the project directory
  if (projectId) {
    try {
      const [codebase] = await db`SELECT repo_path FROM codebases WHERE id = ${projectId}`
      if (codebase?.repo_path) {
        const configTs = path.join(codebase.repo_path, 'playwright.config.ts')
        const configJs = path.join(codebase.repo_path, 'playwright.config.js')
        if (fs.existsSync(configTs)) playwrightConfig = { cwd: codebase.repo_path, configFile: configTs }
        else if (fs.existsSync(configJs)) playwrightConfig = { cwd: codebase.repo_path, configFile: configJs }
      }
    } catch (err) {
      logger.debug('Playwright: failed to look up codebase', { error: err.message })
    }
  }

  if (!playwrightConfig) {
    logger.debug('Playwright: no playwright.config found for project, skipping')
    return { passed: [], failed: [], exitCode: null, skipped: true }
  }

  logger.info(`Running Playwright tests: ${spec || 'all'} in ${playwrightConfig.cwd}`)

  return new Promise((resolve) => {
    const args = ['playwright', 'test', '--reporter=json']
    if (spec) args.push(spec)
    if (url) args.push('--project=chromium')  // default to chromium when URL given

    let stdout = ''
    let stderr = ''
    let timedOut = false

    const proc = spawn('npx', args, {
      cwd: playwrightConfig.cwd,
      env: {
        ...process.env,
        ...(url ? { PLAYWRIGHT_BASE_URL: url } : {}),
        CI: '1',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    const timeout = setTimeout(() => {
      timedOut = true
      proc.kill('SIGTERM')
      logger.warn('Playwright: test run timed out', { ccSessionId })
    }, PLAYWRIGHT_TIMEOUT)

    proc.stdout.on('data', (chunk) => { stdout += chunk.toString() })
    proc.stderr.on('data', (chunk) => { stderr += chunk.toString() })

    proc.on('close', async (exitCode) => {
      clearTimeout(timeout)
      const durationMs = Date.now() - startTime

      const result = parsePlaywrightJson(stdout, stderr, exitCode, timedOut)
      result.durationMs = durationMs

      logger.info(`Playwright: ${result.passed.length} passed, ${result.failed.length} failed (exit: ${exitCode})`, { ccSessionId })

      // Store results
      if (ccSessionId) {
        try {
          await db`
            INSERT INTO playwright_runs (cc_session_id, codebase_id, passed_count, failed_count,
              failed_tests, exit_code, duration_ms, timed_out, raw_output)
            VALUES (${ccSessionId}, ${projectId || null},
                    ${result.passed.length}, ${result.failed.length},
                    ${JSON.stringify(result.failed)}, ${exitCode},
                    ${durationMs}, ${timedOut}, ${(stdout + stderr).slice(-10000)})
          `.catch(() => {})
        } catch {}
      }

      resolve(result)
    })

    proc.on('error', (err) => {
      clearTimeout(timeout)
      logger.debug('Playwright: spawn error', { error: err.message })
      resolve({ passed: [], failed: [], exitCode: 1, error: err.message })
    })
  })
}

function parsePlaywrightJson(stdout, stderr, exitCode, timedOut) {
  if (timedOut) {
    return { passed: [], failed: ['TIMEOUT: test run exceeded time limit'], exitCode: 1 }
  }

  // Try JSON reporter output first (--reporter=json outputs to stdout)
  try {
    // Playwright JSON output may be mixed with other output — find the JSON object
    const jsonMatch = stdout.match(/(\{[\s\S]*"stats"[\s\S]*\})/)
    if (jsonMatch) {
      const report = JSON.parse(jsonMatch[1])
      const passed = []
      const failed = []

      function walkSuites(suites) {
        if (!suites) return
        for (const suite of suites) {
          if (suite.specs) {
            for (const spec of suite.specs) {
              const title = `${suite.title} > ${spec.title}`
              const ok = spec.tests?.every(t => t.results?.every(r => r.status === 'passed' || r.status === 'skipped'))
              if (ok) passed.push(title)
              else failed.push(title)
            }
          }
          walkSuites(suite.suites)
        }
      }

      walkSuites(report.suites)
      return { passed, failed, exitCode }
    }
  } catch {
    // Fall through to text parsing
  }

  // Text-based fallback: parse "X passed", "X failed" from stderr/stdout
  const combined = stdout + stderr
  const passMatch = combined.match(/(\d+)\s+passed/)
  const failMatch = combined.match(/(\d+)\s+failed/)

  const passCount = passMatch ? parseInt(passMatch[1]) : (exitCode === 0 ? 1 : 0)
  const failCount = failMatch ? parseInt(failMatch[1]) : (exitCode !== 0 ? 1 : 0)

  return {
    passed: Array.from({ length: passCount }, (_, i) => `test-${i + 1}`),
    failed: failCount > 0 ? [`${failCount} test(s) failed — see logs`] : [],
    exitCode,
  }
}

module.exports = { runTests }
