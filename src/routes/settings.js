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

// POST /api/settings/workers/:name/trigger — manually trigger a worker/job
// Supported names: audit, scan, sweep, self_improvement, kg_embed, kg_consolidation
router.post('/workers/:name/trigger', async (req, res, next) => {
  try {
    const { name } = req.params
    let message = ''

    switch (name) {
      case 'audit': {
        const worker = require('../workers/factoryScheduleWorker')
        worker.runDependencyAudit().catch(() => {})
        message = 'Dependency audit triggered'
        break
      }
      case 'scan': {
        const worker = require('../workers/factoryScheduleWorker')
        worker.runProactiveScan().catch(() => {})
        message = 'Proactive scan triggered'
        break
      }
      case 'sweep': {
        const worker = require('../workers/factoryScheduleWorker')
        worker.runQualitySweep().catch(() => {})
        message = 'Quality sweep triggered'
        break
      }
      case 'self_improvement': {
        const worker = require('../workers/factoryScheduleWorker')
        worker.runSelfImprovement().catch(() => {})
        message = 'Self-improvement triggered'
        break
      }
      case 'kg_embed': {
        const kgWorker = require('../workers/kgEmbeddingWorker')
        if (kgWorker && typeof kgWorker.runOnce === 'function') {
          kgWorker.runOnce().catch(() => {})
        } else {
          const kgService = require('../services/knowledgeGraphService')
          kgService.embedStaleNodes().catch(() => {})
        }
        message = 'KG embedding triggered'
        break
      }
      case 'kg_consolidation': {
        const kgConsolidation = require('../services/kgConsolidationService')
        kgConsolidation.runConsolidationPipeline({ dryRun: false }).catch(() => {})
        message = 'KG consolidation triggered'
        break
      }
      default:
        return res.status(400).json({ error: `Unknown worker: ${name}` })
    }

    logger.info(`Manual worker trigger: ${name}`)
    res.json({ ok: true, message })
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

module.exports = router
