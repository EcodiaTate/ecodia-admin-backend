const { Router } = require('express')
const auth = require('../middleware/auth')
const db = require('../config/db')

const router = Router()
router.use(auth)

// GET /api/finance/transactions
router.get('/transactions', async (req, res, next) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 50, 200)
    const offset = parseInt(req.query.offset) || 0
    const status = req.query.status
    const clientId = req.query.clientId

    const transactions = await db`
      SELECT * FROM transactions
      WHERE 1=1
        ${status ? db`AND status = ${status}` : db``}
        ${clientId ? db`AND client_id = ${clientId}` : db``}
      ORDER BY date DESC
      LIMIT ${limit} OFFSET ${offset}
    `

    const [{ count }] = await db`
      SELECT count(*)::int FROM transactions
      WHERE 1=1
        ${status ? db`AND status = ${status}` : db``}
        ${clientId ? db`AND client_id = ${clientId}` : db``}
    `

    res.json({ transactions, total: count })
  } catch (err) {
    next(err)
  }
})

// GET /api/finance/summary
router.get('/summary', async (req, res, next) => {
  try {
    const [summary] = await db`
      SELECT
        coalesce(sum(amount_aud) FILTER (WHERE type = 'credit'), 0) AS income,
        coalesce(sum(abs(amount_aud)) FILTER (WHERE type = 'debit'), 0) AS expenses
      FROM transactions
      WHERE date >= date_trunc('month', current_date)
    `

    const categories = await db`
      SELECT category, sum(abs(amount_aud))::numeric(10,2) AS total, count(*)::int
      FROM transactions
      WHERE type = 'debit'
        AND date >= date_trunc('month', current_date)
        AND category IS NOT NULL
      GROUP BY category
      ORDER BY total DESC
    `

    res.json({
      income: parseFloat(summary.income),
      expenses: parseFloat(summary.expenses),
      net: parseFloat(summary.income) - parseFloat(summary.expenses),
      categories,
    })
  } catch (err) {
    next(err)
  }
})

// GET /api/finance/xero/callback — OAuth2 callback
router.get('/xero/callback', async (req, res, next) => {
  try {
    const { code } = req.query
    if (!code) return res.status(400).json({ error: 'Missing authorization code' })

    const xeroService = require('../services/xeroService')
    await xeroService.exchangeCode(code)
    res.send('Xero connected successfully. You can close this window.')
  } catch (err) {
    next(err)
  }
})

module.exports = router
