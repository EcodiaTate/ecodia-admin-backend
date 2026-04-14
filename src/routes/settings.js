const { Router } = require('express')
const auth = require('../middleware/auth')
const db = require('../config/db')
const logger = require('../config/logger')

const router = Router()
router.use(auth)

// GET /api/settings — returns system config + status
router.get('/', async (req, res, next) => {
  try {
    const [xeroToken] = await db`SELECT expires_at, updated_at FROM xero_tokens LIMIT 1`
    const [gmailSync] = await db`SELECT history_id, updated_at FROM gmail_sync_state LIMIT 1`

    res.json({
      xero: xeroToken
        ? { connected: true, expiresAt: xeroToken.expires_at, lastRefresh: xeroToken.updated_at }
        : { connected: false },
      gmail: gmailSync
        ? { connected: true, historyId: gmailSync.history_id, lastSync: gmailSync.updated_at }
        : { connected: false },
    })
  } catch (err) {
    next(err)
  }
})

// POST /api/settings/workers/:name/trigger
//
// Only KG operations are exposed here — they are targeted, stateless ops
// that can be useful to invoke directly (e.g. force-embed before a query).
//
// Factory maintenance (audit, scan, sweep, self_improvement) is NOT exposed.
// Those are decided by the AutonomousMaintenanceWorker, not by the user.
// If you need maintenance to run, tell Cortex — it will dispatch a Factory session.
//
// Supported: kg_embed, kg_consolidation, maintenance_cycle
router.post('/workers/:name/trigger', async (req, res, next) => {
  try {
    const { name } = req.params

    if (name === 'kg_embed') {
      const kgService = require('../services/knowledgeGraphService')
      kgService.embedStaleNodes().catch(() => {})
      logger.info('Manual trigger: KG embedding')
      return res.json({ ok: true, message: 'KG embedding started' })
    }

    if (name === 'kg_consolidation') {
      const kgConsolidation = require('../services/kgConsolidationService')
      kgConsolidation.runConsolidationPipeline({ dryRun: false }).catch(() => {})
      logger.info('Manual trigger: KG consolidation')
      return res.json({ ok: true, message: 'KG consolidation started' })
    }

    if (name === 'maintenance_cycle') {
      // Force one maintenance cycle immediately — useful for testing/debugging
      const maintenance = require('../workers/autonomousMaintenanceWorker')
      maintenance.runCycle().catch(() => {})
      logger.info('Manual trigger: autonomous maintenance cycle')
      return res.json({ ok: true, message: 'Maintenance cycle started — the mind will decide what to do' })
    }

    return res.status(400).json({
      error: `Unknown trigger: ${name}`,
      available: ['kg_embed', 'kg_consolidation', 'maintenance_cycle'],
      note: 'Factory maintenance (audit, scan, sweep) is handled autonomously. Tell Cortex if you need specific work done.',
    })
  } catch (err) {
    next(err)
  }
})

// GET /api/config/enums
router.get('/enums', (_req, res) => {
  res.json({
    pipelineStages: ['lead', 'proposal', 'contract', 'development', 'live', 'ongoing', 'archived'],
    taskPriorities: ['low', 'medium', 'high', 'urgent'],
    taskStatuses: ['open', 'in_progress', 'done', 'cancelled'],
    projectStatuses: ['active', 'paused', 'complete', 'archived'],
    transactionCategories: [
      'Software Subscriptions', 'Cloud Infrastructure', 'Contractor Payments',
      'Office/Admin', 'Marketing', 'Travel', 'Meals/Entertainment',
      'Legal/Accounting', 'Income - Software Dev', 'Income - Consulting',
      'Tax', 'Superannuation', 'Bank Fees', 'Other',
    ],
  })
})

// POST /api/settings/linkedin-cookies — direct cookie setter, no AI needed
router.post('/linkedin-cookies', async (req, res, next) => {
  try {
    const { li_at, JSESSIONID, li_a } = req.body
    if (!li_at) return res.status(400).json({ error: 'li_at is required' })

    const { encrypt } = require('../utils/encryption')
    const cookies = [
      { name: 'li_at', value: li_at.trim(), domain: '.linkedin.com', path: '/', httpOnly: true, secure: true, sameSite: 'None' },
    ]
    if (JSESSIONID) cookies.push({ name: 'JSESSIONID', value: JSESSIONID.trim(), domain: '.www.linkedin.com', path: '/', httpOnly: false, secure: true, sameSite: 'None' })
    if (li_a) cookies.push({ name: 'li_a', value: li_a.trim(), domain: '.linkedin.com', path: '/', httpOnly: true, secure: true, sameSite: 'None' })

    const encrypted = encrypt(JSON.stringify(cookies))
    await db`
      UPDATE linkedin_session
      SET cookies = ${encrypted}, last_active_at = now(), status = 'active', suspend_reason = NULL, updated_at = now()
      WHERE id = 'default'
    `

    logger.info('LinkedIn cookies updated via settings API', { cookieCount: cookies.length })
    res.json({ message: 'LinkedIn cookies updated', cookies: cookies.map(c => c.name) })
  } catch (err) { next(err) }
})

// GET /api/settings/claude-tokens — token health status for both accounts
router.get('/claude-tokens', async (req, res, next) => {
  try {
    const tokenRefresh = require('../services/claudeTokenRefreshService')
    const health = tokenRefresh.getTokenHealth()
    res.json(health)
  } catch (err) { next(err) }
})

// POST /api/settings/claude-tokens/refresh — force refresh all tokens now
router.post('/claude-tokens/refresh', async (req, res, next) => {
  try {
    const tokenRefresh = require('../services/claudeTokenRefreshService')
    const results = await tokenRefresh.refreshAllAccounts({ force: true })
    res.json(results)
  } catch (err) { next(err) }
})

module.exports = router
