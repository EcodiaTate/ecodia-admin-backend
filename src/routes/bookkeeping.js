const { Router } = require('express')
const auth = require('../middleware/auth')
const bk = require('../services/bookkeeperService')
const logger = require('../config/logger')

const router = Router()
router.use(auth)

// ── Staged Transactions ──

router.get('/staged', async (req, res, next) => {
  try {
    const status = req.query.status || null
    const limit = Math.min(parseInt(req.query.limit) || 100, 500)
    const offset = parseInt(req.query.offset) || 0
    res.json(await bk.listStaged(status, limit, offset))
  } catch (err) { next(err) }
})

router.get('/staged/counts', async (_req, res, next) => {
  try { res.json(await bk.getStagedCounts()) } catch (err) { next(err) }
})

router.get('/staged/:id', async (req, res, next) => {
  try {
    const row = await bk.getStaged(req.params.id)
    if (!row) return res.status(404).json({ error: 'Not found' })
    res.json(row)
  } catch (err) { next(err) }
})

router.patch('/staged/:id', async (req, res, next) => {
  try {
    await bk.updateStaged(req.params.id, req.body)
    res.json({ status: 'updated' })
  } catch (err) { next(err) }
})

router.post('/staged/:id/post', async (req, res, next) => {
  try {
    const ledgerTxId = await bk.postStagedTransaction(req.params.id)
    res.json({ status: 'posted', ledger_tx_id: ledgerTxId })
  } catch (err) { next(err) }
})

router.post('/staged/batch-post', async (_req, res, next) => {
  try {
    const rows = await bk.listStaged('categorized', 500)
    let posted = 0, skipped = 0, errors = []
    for (const row of rows) {
      if (!row.category || row.category === 'DISCARD') { skipped++; continue }
      try { await bk.postStagedTransaction(row.id); posted++ }
      catch (e) { errors.push({ id: row.id, error: e.message }) }
    }
    res.json({ posted, skipped, errors })
  } catch (err) { next(err) }
})

router.post('/staged/:id/ignore', async (req, res, next) => {
  try { await bk.markIgnored(req.params.id); res.json({ status: 'ignored' }) }
  catch (err) { next(err) }
})

router.post('/staged/:id/discard', async (req, res, next) => {
  try {
    await bk.updateStaged(req.params.id, { category: 'DISCARD', is_personal: true, status: 'ignored' })
    // Optionally auto-learn a DISCARD rule
    if (req.query.learn === 'true') {
      const tx = await bk.getStaged(req.params.id)
      if (tx) await bk.autoLearnRule(tx.description, 'DISCARD', true, 'manual_discard').catch(() => {})
    }
    res.json({ status: 'discarded' })
  } catch (err) { next(err) }
})

// ── Ingest ──

router.post('/ingest/csv', express.text({ type: '*/*', limit: '10mb' }), async (req, res, next) => {
  try {
    if (!req.body) return res.status(400).json({ error: 'No CSV data' })
    const csvText = typeof req.body === 'string' ? req.body : req.body.toString('utf-8')
    // source_account can be passed as query param: ?source_account=2100 for personal bank
    // If not specified, auto-detect from CSV content (Up Bank BSB 633-123 = personal)
    const parsed = await bk.parseAnyBankCSV(csvText)
    const transactions = parsed.transactions || parsed  // backwards compat if plain array
    const detectedBank = parsed.detectedBank || null

    let sourceAccount = req.query.source_account
    if (!sourceAccount && detectedBank?.isPersonal) {
      sourceAccount = '2100'  // Personal bank → Director Loan
      logger.info(`Auto-detected personal bank: ${detectedBank.bankName} (${detectedBank.bsb || 'no BSB'}) → source_account 2100`)
    }
    sourceAccount = sourceAccount || '1000'

    // Tag each transaction with the source account
    for (const tx of transactions) tx.source_account = sourceAccount
    let created = 0, dupes = 0
    for (const tx of transactions) {
      if (await bk.upsertStaged(tx)) created++; else dupes++
    }
    if (created > 0) await bk.autoCategorize()
    res.json({ created, duplicates: dupes, total_parsed: transactions.length })
  } catch (err) { next(err) }
})

router.post('/ingest/xero', async (_req, res, next) => {
  try {
    const result = await bk.importXeroTransactions()
    if (result.imported > 0) await bk.autoCategorize()
    res.json(result)
  } catch (err) { next(err) }
})

router.post('/categorize', async (_req, res, next) => {
  try { res.json(await bk.autoCategorize()) } catch (err) { next(err) }
})

// ── Ledger ──

router.get('/ledger/transactions', async (req, res, next) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 50, 200)
    const offset = parseInt(req.query.offset) || 0
    res.json(await bk.getLedgerTransactions(limit, offset))
  } catch (err) { next(err) }
})

router.get('/ledger/trial-balance', async (req, res, next) => {
  try { res.json(await bk.getTrialBalance(req.query.as_of || null)) }
  catch (err) { next(err) }
})

// ── Reports ──

router.get('/reports/bas', async (req, res, next) => {
  try { res.json(await bk.getBASReport(req.query.period_start, req.query.period_end)) }
  catch (err) { next(err) }
})

router.get('/reports/pnl', async (req, res, next) => {
  try { res.json(await bk.getPnLReport(req.query.period_start, req.query.period_end)) }
  catch (err) { next(err) }
})

router.get('/reports/balance-sheet', async (req, res, next) => {
  try { res.json(await bk.getBalanceSheet(req.query.as_of)) }
  catch (err) { next(err) }
})

router.get('/reports/expense-breakdown', async (req, res, next) => {
  try { res.json(await bk.getExpenseBreakdown(req.query.period_start, req.query.period_end)) }
  catch (err) { next(err) }
})

router.get('/reports/gst-summary', async (req, res, next) => {
  try { res.json(await bk.getGSTSummary(req.query.period_start, req.query.period_end)) }
  catch (err) { next(err) }
})

// ── Director Loan ──

router.get('/director-loan/balance', async (_req, res, next) => {
  try { res.json(await bk.getDirectorLoanBalance()) } catch (err) { next(err) }
})

// ── Supplier Rules ──

router.get('/rules', async (_req, res, next) => {
  try { res.json(await bk.getAllRules()) } catch (err) { next(err) }
})

router.post('/rules', async (req, res, next) => {
  try {
    const id = await bk.createRule(req.body)
    res.json({ id, status: 'created' })
  } catch (err) { next(err) }
})

router.delete('/rules/:id', async (req, res, next) => {
  try { await bk.deleteRule(req.params.id); res.json({ status: 'deleted' }) }
  catch (err) { next(err) }
})

// ── GL Accounts ──

router.get('/accounts', async (_req, res, next) => {
  try {
    const db = require('../config/db')
    res.json(await db`SELECT * FROM gl_accounts ORDER BY code`)
  } catch (err) { next(err) }
})

module.exports = router
