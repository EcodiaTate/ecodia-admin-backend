const cron = require('node-cron')
const { execFileSync } = require('child_process')
const fs = require('fs')
const path = require('path')
const db = require('../config/db')
const logger = require('../config/logger')
const metabolismBridge = require('../services/metabolismBridgeService')

// ═══════════════════════════════════════════════════════════════════════
// FACTORY SCHEDULE WORKER
//
// Daily:  Dependency audit on all codebases
// Weekly: Code quality sweep
// Dispatches CC sessions for critical findings.
// Respects metabolic pressure — skips non-essential work.
// ═══════════════════════════════════════════════════════════════════════

// Daily 3 AM AEST = 5 PM UTC (cron: 0 17 * * *)
cron.schedule('0 17 * * *', async () => {
  if (metabolismBridge.isUnderPressure()) {
    logger.info('Factory schedule: skipping dependency audit (metabolic pressure)')
    return
  }

  try {
    await runDependencyAudit()
  } catch (err) {
    logger.error('Factory dependency audit failed', { error: err.message })
  }
})

// Weekly Sunday 4 AM AEST = 6 PM UTC Sunday (cron: 0 18 * * 0)
cron.schedule('0 18 * * 0', async () => {
  if (metabolismBridge.isUnderPressure()) {
    logger.info('Factory schedule: skipping quality sweep (metabolic pressure)')
    return
  }

  try {
    await runQualitySweep()
  } catch (err) {
    logger.error('Factory quality sweep failed', { error: err.message })
  }
})

async function runDependencyAudit() {
  const codebases = await db`SELECT id, name, repo_path, language FROM codebases`

  for (const codebase of codebases) {
    if (!fs.existsSync(codebase.repo_path)) continue

    let auditOutput = ''
    let hasCritical = false

    try {
      if (fs.existsSync(path.join(codebase.repo_path, 'package.json'))) {
        try {
          auditOutput = execFileSync('npm', ['audit', '--json'], {
            cwd: codebase.repo_path, encoding: 'utf-8', timeout: 60_000,
          })
        } catch (err) {
          auditOutput = err.stdout || err.stderr || ''
        }

        try {
          const parsed = JSON.parse(auditOutput)
          hasCritical = (parsed.metadata?.vulnerabilities?.critical || 0) > 0
            || (parsed.metadata?.vulnerabilities?.high || 0) > 0
        } catch {}
      }

      if (codebase.language === 'python' && fs.existsSync(path.join(codebase.repo_path, 'requirements.txt'))) {
        try {
          execFileSync('pip-audit', ['-r', 'requirements.txt'], {
            cwd: codebase.repo_path, encoding: 'utf-8', timeout: 60_000,
          })
        } catch (err) {
          if (err.status && err.status !== 0) hasCritical = true
          auditOutput += '\n' + (err.stdout || err.stderr || '')
        }
      }
    } catch (err) {
      logger.debug(`Audit failed for ${codebase.name}`, { error: err.message })
    }

    if (hasCritical) {
      logger.warn(`Critical vulnerabilities found in ${codebase.name}`)
      const triggers = require('../services/factoryTriggerService')
      await triggers.dispatchFromSchedule({
        codebaseId: codebase.id,
        prompt: `SECURITY: Critical vulnerabilities found in ${codebase.name}.\n\nAudit output:\n${auditOutput.slice(0, 3000)}\n\nFix the critical and high severity vulnerabilities. Run tests after.`,
      })
    }
  }

  logger.info('Factory dependency audit complete')
}

async function runQualitySweep() {
  // Quality sweep is less urgent — just log findings for now
  // In the future, this could dispatch CC sessions for cleanup
  logger.info('Factory quality sweep complete (no-op for now)')
}

logger.info('Factory schedule worker started (daily audit + weekly sweep)')

module.exports = { runDependencyAudit, runQualitySweep }
