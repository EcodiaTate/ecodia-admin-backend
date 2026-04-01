const logger = require('../config/logger')
const db = require('../config/db')

// Playwright test runner — executes E2E tests on behalf of CC sessions
// TODO: Implement once Playwright is installed on VPS

async function runTests({ spec, url, projectId, ccSessionId }) {
  logger.info(`Running Playwright tests: ${spec} against ${url}`)

  // TODO: Execute playwright test with spec, capture results
  // Store results in playwright_runs table

  logger.warn('Playwright test runner not yet implemented')
  return { passed: [], failed: [], exitCode: null }
}

module.exports = { runTests }
