const cron = require('node-cron')
const { execFileSync } = require('child_process')
const fs = require('fs')
const path = require('path')
const db = require('../config/db')
const logger = require('../config/logger')
const metabolismBridge = require('../services/metabolismBridgeService')
const { recordHeartbeat } = require('./heartbeat')

// ═══════════════════════════════════════════════════════════════════════
// FACTORY SCHEDULE WORKER — Adaptive Autonomous Scheduling
//
// Graduated metabolic throttling replaces binary kill switches.
// Adaptive scheduling adjusts intervals based on codebase activity,
// recent failure rates, and metabolic pressure.
//
// Base schedules:
//   Daily 3 AM AEST: Dependency security audit
//   Daily 4 AM AEST: Proactive discovery scan
//   Weekly Sun:      Deep code quality sweep
//   Weekly Wed:      Factory self-improvement
//
// Adaptive overrides:
//   Event-driven immediate runs on deploy failures, high git activity
//   Pressure-modulated scope (audit most critical only, scan security only)
// ═══════════════════════════════════════════════════════════════════════

// Track last runs and results for adaptive scheduling
const runHistory = {
  audit:           { lastRun: null, lastResult: null, failures: 0 },
  scan:            { lastRun: null, lastResult: null, failures: 0 },
  sweep:           { lastRun: null, lastResult: null, failures: 0 },
  selfImprovement: { lastRun: null, lastResult: null, failures: 0 },
}

// ─── Cron: Daily 3 AM AEST = 5 PM UTC ──────────────────────────────

cron.schedule('0 17 * * *', async () => {
  if (metabolismBridge.shouldThrottle('audit')) {
    logger.info(`Factory schedule: skipping dependency audit (pressure: ${metabolismBridge.getPressure().toFixed(2)})`)
    return
  }
  await safeRun('audit', runDependencyAudit)
})

// ─── Cron: Daily 4 AM AEST = 6 PM UTC ──────────────────────────────

cron.schedule('0 18 * * *', async () => {
  if (metabolismBridge.shouldThrottle('scan')) {
    logger.info(`Factory schedule: skipping proactive scan (pressure: ${metabolismBridge.getPressure().toFixed(2)})`)
    return
  }
  await safeRun('scan', runProactiveScan)
})

// ─── Cron: Weekly Sunday 5 AM AEST = 7 PM UTC ──────────────────────

cron.schedule('0 19 * * 0', async () => {
  if (metabolismBridge.shouldThrottle('sweep')) {
    logger.info(`Factory schedule: skipping quality sweep (pressure: ${metabolismBridge.getPressure().toFixed(2)})`)
    return
  }
  await safeRun('sweep', runQualitySweep)
})

// ─── Cron: Weekly Wednesday 2 AM AEST = 4 PM UTC ───────────────────

cron.schedule('0 16 * * 3', async () => {
  if (metabolismBridge.shouldThrottle('all')) {
    logger.info(`Factory schedule: skipping self-improvement (pressure: ${metabolismBridge.getPressure().toFixed(2)})`)
    return
  }
  await safeRun('selfImprovement', runSelfImprovement)
})

// ─── Adaptive: Check every hour if something should run sooner ──────

cron.schedule('0 * * * *', async () => {
  if (metabolismBridge.shouldThrottle('scan')) return
  await checkAdaptiveTriggers()
})

// ─── Safe Runner with History Tracking ──────────────────────────────

async function safeRun(taskType, fn) {
  const start = Date.now()
  try {
    const result = await fn()
    runHistory[taskType] = { lastRun: new Date(), lastResult: 'success', failures: 0 }
    await recordHeartbeat('factory_schedule', 'active')

    // Emit to event bus
    try {
      const eventBus = require('../services/internalEventBusService')
      eventBus.emit('factory:schedule_complete', { taskType, result, durationMs: Date.now() - start })
    } catch {}

    return result
  } catch (err) {
    logger.error(`Factory ${taskType} failed`, { error: err.message })
    runHistory[taskType].lastRun = new Date()
    runHistory[taskType].lastResult = 'error'
    runHistory[taskType].failures++
    await recordHeartbeat('factory_schedule', 'error', err.message)
  }
}

// ─── Adaptive Trigger Checks ────────────────────────────────────────

async function checkAdaptiveTriggers() {
  try {
    const pressure = metabolismBridge.getPressure()

    // If pressure is low and it's been >48h since last quality sweep, run one
    if (pressure < 0.3 && runHistory.sweep.lastRun) {
      const hoursSinceSweep = (Date.now() - runHistory.sweep.lastRun.getTime()) / (60 * 60 * 1000)
      if (hoursSinceSweep > 48) {
        logger.info('Adaptive scheduling: triggering quality sweep (low pressure + stale)')
        await safeRun('sweep', runQualitySweep)
        return
      }
    }

    // Check if any codebase had significant git activity (>5 commits in 24h)
    const activeCodebases = await db`
      SELECT cb.id, cb.name, cb.repo_path
      FROM codebases cb
      WHERE cb.repo_path IS NOT NULL
    `
    for (const cb of activeCodebases) {
      if (!fs.existsSync(cb.repo_path)) continue
      try {
        const recentCommits = execFileSync(
          'git', ['log', '--oneline', '--since=24 hours ago'],
          { cwd: cb.repo_path, encoding: 'utf-8', timeout: 10_000 }
        ).trim()
        const commitCount = recentCommits ? recentCommits.split('\n').length : 0

        if (commitCount > 5 && !metabolismBridge.shouldThrottle('audit')) {
          // High activity — check if we've audited recently
          const hoursSinceAudit = runHistory.audit.lastRun
            ? (Date.now() - runHistory.audit.lastRun.getTime()) / (60 * 60 * 1000)
            : 999
          if (hoursSinceAudit > 12) {
            logger.info(`Adaptive scheduling: ${cb.name} has ${commitCount} commits in 24h — running audit`)
            await runDependencyAuditForCodebase(cb)
          }
        }
      } catch {}
    }

    // If recent Factory deploy failures, trigger self-improvement sooner
    const [recentFailures] = await db`
      SELECT count(*)::int AS count
      FROM cc_sessions
      WHERE status = 'error' AND started_at > now() - interval '24 hours'
    `
    if (recentFailures.count > 3 && !metabolismBridge.shouldThrottle('all')) {
      const hoursSinceSelfImprove = runHistory.selfImprovement.lastRun
        ? (Date.now() - runHistory.selfImprovement.lastRun.getTime()) / (60 * 60 * 1000)
        : 999
      if (hoursSinceSelfImprove > 24) {
        logger.info(`Adaptive scheduling: ${recentFailures.count} failures in 24h — triggering self-improvement`)
        await safeRun('selfImprovement', runSelfImprovement)
      }
    }
  } catch (err) {
    logger.debug('Adaptive trigger check failed', { error: err.message })
  }
}

// ─── Event-driven immediate runs ────────────────────────────────────

function requestImmediateRun(taskType) {
  const fns = { audit: runDependencyAudit, scan: runProactiveScan, sweep: runQualitySweep, selfImprovement: runSelfImprovement }
  const fn = fns[taskType]
  if (!fn) return
  logger.info(`Factory schedule: immediate ${taskType} requested via event bus`)
  safeRun(taskType, fn).catch(() => {})
}

// Wire into event bus for deploy failure reactions
try {
  const eventBus = require('../services/internalEventBusService')
  eventBus.on('factory:deploy_failed', (payload) => {
    if (!metabolismBridge.shouldThrottle('all')) {
      logger.info('Factory schedule: deploy failure detected — scheduling investigation')
      // Don't run full self-improvement, just log for now. The oversight service
      // already handles follow-ups via generateFollowUp().
    }
  })
} catch {}

// ─── Dependency Audit ───────────────────────────────────────────────

async function runDependencyAudit() {
  const codebases = await db`SELECT id, name, repo_path, language FROM codebases`
  const pressure = metabolismBridge.getPressure()

  // At moderate pressure, only audit the most critical codebases
  let targets = codebases
  if (pressure > 0.3 && pressure <= 0.7) {
    // Only audit codebases with recent activity
    targets = []
    for (const cb of codebases) {
      if (!fs.existsSync(cb.repo_path)) continue
      try {
        const recent = execFileSync(
          'git', ['log', '--oneline', '-1', '--since=7 days ago'],
          { cwd: cb.repo_path, encoding: 'utf-8', timeout: 10_000 }
        ).trim()
        if (recent) targets.push(cb)
      } catch { targets.push(cb) } // include on error (can't confirm inactive)
    }
    logger.info(`Dependency audit: moderate pressure — auditing ${targets.length}/${codebases.length} active codebases`)
  }

  for (const codebase of targets) {
    await runDependencyAuditForCodebase(codebase)
  }

  logger.info('Factory dependency audit complete')
}

async function runDependencyAuditForCodebase(codebase) {
  if (!fs.existsSync(codebase.repo_path)) return

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

// ─── Proactive Discovery Scan ───────────────────────────────────────

async function runProactiveScan() {
  const codebases = await db`SELECT id, name, repo_path, language FROM codebases`
  const pressure = metabolismBridge.getPressure()

  for (const codebase of codebases) {
    if (!fs.existsSync(codebase.repo_path)) continue

    const findings = []

    // At moderate pressure, only scan for security issues (skip code quality)
    const securityOnly = pressure > 0.3

    try {
      // Scan for TODO/FIXME/HACK/XXX comments
      const todoOutput = execFileSync('grep', [
        '-rn', '--include=*.js', '--include=*.ts', '--include=*.tsx', '--include=*.py',
        '-E', '(TODO|FIXME|HACK|XXX|BUG):', codebase.repo_path,
      ], { encoding: 'utf-8', timeout: 30_000, maxBuffer: 1024 * 1024 }).trim()

      const todoCount = todoOutput ? todoOutput.split('\n').length : 0
      if (todoCount > 20 && !securityOnly) {
        findings.push(`${todoCount} TODO/FIXME comments found — may indicate unfinished work`)
      }
    } catch {}

    if (!securityOnly) {
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
    }

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

async function runSelfImprovement() {
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
    prompt: `FACTORY SELF-IMPROVEMENT: Weekly review of the Factory system itself.

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

  logger.info('Factory weekly self-improvement session dispatched')
}

logger.info('Factory schedule worker started (adaptive scheduling: audit + scan + sweep + self-improvement)')

module.exports = { runDependencyAudit, runProactiveScan, runQualitySweep, runSelfImprovement, requestImmediateRun }
