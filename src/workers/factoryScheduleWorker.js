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
// Daily 3 AM:  Dependency security audit on all codebases
// Daily 4 AM:  Proactive discovery scan (TODOs, dead code, opportunities)
// Weekly Sun:  Deep code quality sweep via CC
// ═══════════════════════════════════════════════════════════════════════

// Daily 3 AM AEST = 5 PM UTC
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

// Daily 4 AM AEST = 6 PM UTC
cron.schedule('0 18 * * *', async () => {
  if (metabolismBridge.isUnderPressure()) {
    logger.info('Factory schedule: skipping proactive scan (metabolic pressure)')
    return
  }
  try {
    await runProactiveScan()
  } catch (err) {
    logger.error('Factory proactive scan failed', { error: err.message })
  }
})

// Weekly Sunday 5 AM AEST = 7 PM UTC Sunday
cron.schedule('0 19 * * 0', async () => {
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

// ─── Dependency Audit ───────────────────────────────────────────────

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

// ─── Proactive Discovery Scan ───────────────────────────────────────

async function runProactiveScan() {
  const codebases = await db`SELECT id, name, repo_path, language FROM codebases`

  for (const codebase of codebases) {
    if (!fs.existsSync(codebase.repo_path)) continue

    const findings = []

    try {
      // Scan for TODO/FIXME/HACK/XXX comments
      const todoOutput = execFileSync('grep', [
        '-rn', '--include=*.js', '--include=*.ts', '--include=*.tsx', '--include=*.py',
        '-E', '(TODO|FIXME|HACK|XXX|BUG):', codebase.repo_path,
      ], { encoding: 'utf-8', timeout: 30_000, maxBuffer: 1024 * 1024 }).trim()

      const todoCount = todoOutput ? todoOutput.split('\n').length : 0
      if (todoCount > 20) {
        findings.push(`${todoCount} TODO/FIXME comments found — may indicate unfinished work`)
      }
    } catch {}

    try {
      // Check for console.log statements in production code
      const consoleOutput = execFileSync('grep', [
        '-rn', '--include=*.js', '--include=*.ts', '--include=*.tsx',
        '-c', 'console\\.log', codebase.repo_path,
      ], { encoding: 'utf-8', timeout: 30_000, maxBuffer: 1024 * 1024 }).trim()

      const totalLogs = consoleOutput.split('\n')
        .reduce((sum, line) => sum + parseInt(line.split(':').pop() || '0', 10), 0)
      if (totalLogs > 50) {
        findings.push(`${totalLogs} console.log statements — consider replacing with proper logging`)
      }
    } catch {}

    try {
      // Check for outdated package.json dependencies
      if (fs.existsSync(path.join(codebase.repo_path, 'package.json'))) {
        const outdatedOutput = execFileSync('npm', ['outdated', '--json'], {
          cwd: codebase.repo_path, encoding: 'utf-8', timeout: 60_000,
        })
        const outdated = JSON.parse(outdatedOutput || '{}')
        const majorOutdated = Object.entries(outdated).filter(([, info]) => {
          const current = (info.current || '').split('.')[0]
          const latest = (info.latest || '').split('.')[0]
          return current !== latest
        })
        if (majorOutdated.length > 5) {
          findings.push(`${majorOutdated.length} packages with major version updates available`)
        }
      }
    } catch {}

    // If significant findings, create a task (not a CC session — these are informational)
    if (findings.length > 0) {
      const findingsSummary = findings.join('\n- ')
      await db`
        INSERT INTO tasks (title, description, source, source_ref_id, priority)
        VALUES (
          ${'Code health: ' + codebase.name},
          ${'Proactive scan findings:\n- ' + findingsSummary},
          'cc',
          ${codebase.id},
          'low'
        )
        ON CONFLICT DO NOTHING
      `.catch(() => {})

      logger.info(`Proactive scan: ${findings.length} findings in ${codebase.name}`)
    }
  }

  logger.info('Factory proactive scan complete')
}

// ─── Deep Quality Sweep ─────────────────────────────────────────────

async function runQualitySweep() {
  const codebases = await db`SELECT id, name, repo_path, language FROM codebases`
  const triggers = require('../services/factoryTriggerService')

  // Pick one codebase per week (rotate based on week number)
  const weekOfYear = Math.ceil((Date.now() - new Date(new Date().getFullYear(), 0, 1).getTime()) / (7 * 24 * 60 * 60 * 1000))
  const targetIdx = weekOfYear % codebases.length
  const target = codebases[targetIdx]

  if (!target || !fs.existsSync(target.repo_path)) {
    logger.info('Factory quality sweep: no target codebase')
    return
  }

  // Get recent Factory session history for this codebase
  const recentSessions = await db`
    SELECT initial_prompt, status, confidence_score, created_at
    FROM cc_sessions
    WHERE codebase_id = ${target.id} AND started_at > now() - interval '30 days'
    ORDER BY started_at DESC LIMIT 10
  `
  const sessionHistory = recentSessions.map(s =>
    `[${s.status}] ${s.initial_prompt?.slice(0, 80)} (confidence: ${s.confidence_score || 'N/A'})`
  ).join('\n')

  await triggers.dispatchFromSchedule({
    codebaseId: target.id,
    prompt: `WEEKLY QUALITY SWEEP for ${target.name}

You are doing a deep code quality review of this codebase. Analyze the codebase structure, identify the most impactful improvements, and implement the top 1-3 changes. Focus on:

1. Dead code removal (unused exports, unreachable branches, commented-out code)
2. Performance issues (unnecessary re-renders, missing memoization, N+1 queries)
3. Accessibility gaps (missing aria labels, contrast issues, keyboard navigation)
4. Missing error boundaries or error handling
5. Code duplication that could be extracted into shared utilities
6. Outdated patterns that should be modernized

${sessionHistory ? `Recent Factory activity on this codebase:\n${sessionHistory}\n\nAvoid duplicating recent work.` : ''}

Make real improvements — this is not a report, it's an action session. Implement the changes, run tests if available, and leave the codebase measurably better.`,
  })

  logger.info(`Factory quality sweep dispatched for ${target.name}`)
}

// ─── Self-Improvement (Factory improves its own code) ───────────────

// Monthly on the 1st at 2 AM AEST = 4 PM UTC
cron.schedule('0 16 1 * *', async () => {
  if (metabolismBridge.isUnderPressure()) return

  try {
    const triggers = require('../services/factoryTriggerService')

    // Get the ecodia-admin-backend codebase (the Factory itself)
    const [factoryCb] = await db`SELECT id FROM codebases WHERE name = 'ecodia-admin-backend' LIMIT 1`
    if (!factoryCb) return

    // Get recent error logs and patterns
    const recentErrors = await db`
      SELECT error_message, count(*)::int AS count
      FROM cc_sessions
      WHERE status = 'error' AND started_at > now() - interval '30 days' AND error_message IS NOT NULL
      GROUP BY error_message
      ORDER BY count DESC LIMIT 5
    `
    const errorSummary = recentErrors.map(e => `${e.count}x: ${e.error_message?.slice(0, 100)}`).join('\n')

    const recentValidation = await db`
      SELECT
        avg(confidence_score)::numeric(3,2) AS avg_confidence,
        count(*) FILTER (WHERE confidence_score < 0.5)::int AS low_confidence_count,
        count(*)::int AS total
      FROM cc_sessions
      WHERE started_at > now() - interval '30 days' AND confidence_score IS NOT NULL
    `

    await triggers.dispatchFromSchedule({
      codebaseId: factoryCb.id,
      prompt: `FACTORY SELF-IMPROVEMENT: Monthly review of the Factory system itself.

You are reviewing the Ecodia Factory — the autonomous code execution engine. This IS the codebase you're running in. Improve it.

Recent error patterns (last 30 days):
${errorSummary || 'No errors'}

Validation stats: ${recentValidation[0]?.total || 0} sessions, avg confidence ${recentValidation[0]?.avg_confidence || 'N/A'}, ${recentValidation[0]?.low_confidence_count || 0} low-confidence

Focus on:
1. Fix recurring error patterns
2. Improve the oversight pipeline accuracy
3. Optimize the codebase intelligence chunking/embedding
4. Strengthen the validation harness
5. Add any missing error handling or edge cases

This is a real self-improvement session — make the Factory better at being the Factory.`,
    })

    logger.info('Factory self-improvement session dispatched')
  } catch (err) {
    logger.error('Factory self-improvement dispatch failed', { error: err.message })
  }
})

logger.info('Factory schedule worker started (daily audit + proactive scan + weekly sweep + monthly self-improvement)')

module.exports = { runDependencyAudit, runProactiveScan, runQualitySweep }
