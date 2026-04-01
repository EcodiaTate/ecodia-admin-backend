const { Router } = require('express')
const auth = require('../middleware/auth')
const db = require('../config/db')

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
