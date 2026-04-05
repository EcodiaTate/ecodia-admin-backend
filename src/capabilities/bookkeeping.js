const registry = require('../services/capabilityRegistry')

registry.registerMany([
  // ═══════════════════════════════════════════════════════════════════════
  // INGEST: Get transactions into the system
  // ═══════════════════════════════════════════════════════════════════════
  {
    name: 'bookkeeping_ingest_csv',
    description: 'Parse and ingest a bank CSV into the bookkeeping staged pipeline. Pass the raw CSV text content. Deduplicates automatically. Auto-categorizes after import. Set source_account to 2100 for personal bank statements (creates director loan entries), or 1000 for company bank.',
    tier: 'write',
    domain: 'bookkeeping',
    params: {
      csvText: { type: 'string', required: true, description: 'Raw CSV file content from any bank — AI auto-detects column format' },
      source_account: { type: 'string', required: false, description: '1000 = company bank (default), 2100 = personal bank (director loan)' },
    },
    handler: async (params) => {
      const bk = require('../services/bookkeeperService')
      const sourceAccount = params.source_account || '1000'
      const transactions = await bk.parseAnyBankCSV(params.csvText)
      for (const tx of transactions) tx.source_account = sourceAccount
      let created = 0, dupes = 0
      for (const tx of transactions) {
        if (await bk.upsertStaged(tx)) created++; else dupes++
      }
      if (created > 0) await bk.autoCategorize()
      return { message: `Imported ${created} new transactions (${dupes} duplicates skipped, ${transactions.length} total parsed). Source: ${sourceAccount === '2100' ? 'personal bank' : 'company bank'}. Auto-categorization ran.`, created, duplicates: dupes }
    },
  },
  {
    name: 'bookkeeping_import_xero',
    description: 'Import uncategorized Xero transactions into the bookkeeping staged pipeline for double-entry processing',
    tier: 'write',
    domain: 'bookkeeping',
    params: {},
    handler: async () => {
      const bk = require('../services/bookkeeperService')
      const result = await bk.importXeroTransactions()
      if (result.imported > 0) await bk.autoCategorize()
      return { message: `Imported ${result.imported} Xero transactions into bookkeeping pipeline`, ...result }
    },
  },

  // ═══════════════════════════════════════════════════════════════════════
  // CATEGORIZE: AI + rule-based categorization
  // ═══════════════════════════════════════════════════════════════════════
  {
    name: 'bookkeeping_categorize_pending',
    description: 'Run AI categorization on all pending staged transactions. Uses supplier rules first, then DeepSeek for unknowns. High-confidence items auto-post to the ledger.',
    tier: 'write',
    domain: 'bookkeeping',
    params: {},
    handler: async () => {
      const bk = require('../services/bookkeeperService')
      return await bk.autoCategorize()
    },
  },
  {
    name: 'bookkeeping_update_transaction',
    description: 'Manually update a staged transaction — set category, subcategory, is_personal, gst_amount_cents, status, or any other field. Use this to correct AI categorizations or flag/ignore transactions.',
    tier: 'write',
    domain: 'bookkeeping',
    params: {
      id: { type: 'string', required: true, description: 'Staged transaction UUID' },
      category: { type: 'string', required: false, description: 'GL account code (e.g. "5010" for Software & SaaS)' },
      subcategory: { type: 'string', required: false, description: 'Tag like "supplier:vercel"' },
      is_personal: { type: 'boolean', required: false, description: 'True if personal (director loan)' },
      gst_amount_cents: { type: 'number', required: false, description: 'GST component in cents' },
      status: { type: 'string', required: false, description: 'pending, categorized, flagged, or ignored' },
    },
    handler: async (params) => {
      const bk = require('../services/bookkeeperService')
      const { id, ...fields } = params
      await bk.updateStaged(id, fields)
      return { message: `Transaction ${id} updated`, fields }
    },
  },

  // ═══════════════════════════════════════════════════════════════════════
  // LEDGER: Post to the double-entry ledger
  // ═══════════════════════════════════════════════════════════════════════
  {
    name: 'bookkeeping_post_transaction',
    description: 'Post a categorized staged transaction to the double-entry ledger. Creates balanced journal entry lines (debit + credit). Transaction must be categorized first.',
    tier: 'write',
    domain: 'bookkeeping',
    params: {
      id: { type: 'string', required: true, description: 'Staged transaction UUID to post' },
    },
    handler: async (params) => {
      const bk = require('../services/bookkeeperService')
      const ledgerTxId = await bk.postStagedTransaction(params.id)
      return { message: `Posted to ledger`, ledger_tx_id: ledgerTxId }
    },
  },
  {
    name: 'bookkeeping_batch_post',
    description: 'Batch-post ALL categorized staged transactions to the ledger in one go. Skips any that fail.',
    tier: 'write',
    domain: 'bookkeeping',
    params: {},
    handler: async () => {
      const bk = require('../services/bookkeeperService')
      const rows = await bk.listStaged('categorized', 500)
      let posted = 0, errors = []
      for (const row of rows) {
        if (!row.category) continue
        try { await bk.postStagedTransaction(row.id); posted++ }
        catch (e) { errors.push({ id: row.id, error: e.message }) }
      }
      return { message: `Posted ${posted} transactions to ledger${errors.length ? `, ${errors.length} failed` : ''}`, posted, errors: errors.length }
    },
  },
  {
    name: 'bookkeeping_ignore_transaction',
    description: 'Mark a staged transaction as ignored — removes it from the pending queue without posting to the ledger',
    tier: 'write',
    domain: 'bookkeeping',
    params: {
      id: { type: 'string', required: true, description: 'Staged transaction UUID' },
    },
    handler: async (params) => {
      const bk = require('../services/bookkeeperService')
      await bk.markIgnored(params.id)
      return { message: `Transaction ${params.id} ignored` }
    },
  },
  {
    name: 'bookkeeping_create_journal_entry',
    description: 'Create a manual journal entry directly in the ledger. Must provide balanced lines (total debits = total credits). Each line needs account_code, debit_cents, credit_cents. Use for adjustments, corrections, or entries that don\'t come from bank transactions.',
    tier: 'write',
    domain: 'bookkeeping',
    params: {
      description: { type: 'string', required: true, description: 'Journal entry description' },
      occurred_at: { type: 'string', required: true, description: 'Date in YYYY-MM-DD format' },
      source_system: { type: 'string', required: false, description: 'manual (default), stripe, xero, csv_import, auto' },
      lines: { type: 'array', required: true, description: 'Array of { account_code, debit_cents, credit_cents }. Must balance.' },
    },
    handler: async (params) => {
      const db = require('../config/db')
      // AI sometimes sends lines as a JSON string instead of array
      if (typeof params.lines === 'string') params.lines = JSON.parse(params.lines)
      const totalDebit = params.lines.reduce((s, l) => s + (l.debit_cents || 0), 0)
      const totalCredit = params.lines.reduce((s, l) => s + (l.credit_cents || 0), 0)
      if (totalDebit !== totalCredit) throw new Error(`Journal unbalanced: debits=${totalDebit} credits=${totalCredit}`)
      if (params.lines.length < 2) throw new Error('Need at least 2 lines')

      const [tx] = await db`
        INSERT INTO ledger_transactions (occurred_at, description, source_system, source_ref, tags)
        VALUES (${params.occurred_at}, ${params.description}, ${params.source_system || 'manual'}, ${null}, ${'[]'})
        RETURNING id
      `
      for (const line of params.lines) {
        await db`
          INSERT INTO ledger_lines (tx_id, account_code, debit_cents, credit_cents, tax_code, tax_amount_cents)
          VALUES (${tx.id}, ${line.account_code}, ${line.debit_cents || 0}, ${line.credit_cents || 0}, ${line.tax_code || null}, ${line.tax_amount_cents || null})
        `
      }
      return { message: `Manual journal entry created`, ledger_tx_id: tx.id, total: totalDebit }
    },
  },

  // ═══════════════════════════════════════════════════════════════════════
  // ACCOUNTS: Chart of accounts management
  // ═══════════════════════════════════════════════════════════════════════
  {
    name: 'bookkeeping_create_account',
    description: 'Create a new GL account in the chart of accounts. Code is the identifier (e.g. "5045"), type is asset/liability/income/expense/equity.',
    tier: 'write',
    domain: 'bookkeeping',
    params: {
      code: { type: 'string', required: true, description: 'Account code (e.g. "5045")' },
      name: { type: 'string', required: true, description: 'Account name (e.g. "Cloud Hosting")' },
      type: { type: 'string', required: true, description: 'asset, liability, income, expense, or equity' },
    },
    handler: async (params) => {
      const db = require('../config/db')
      await db`INSERT INTO gl_accounts (code, name, type) VALUES (${params.code}, ${params.name}, ${params.type})`
      return { message: `Account ${params.code} "${params.name}" created (${params.type})` }
    },
  },
  {
    name: 'bookkeeping_list_accounts',
    description: 'List all GL accounts in the chart of accounts with their codes, names, and types',
    tier: 'read',
    domain: 'bookkeeping',
    params: {},
    handler: async () => {
      const db = require('../config/db')
      const accounts = await db`SELECT * FROM gl_accounts ORDER BY code`
      return { accounts, count: accounts.length }
    },
  },

  // ═══════════════════════════════════════════════════════════════════════
  // RULES: Supplier categorization rules
  // ═══════════════════════════════════════════════════════════════════════
  {
    name: 'bookkeeping_create_rule',
    description: 'Create a new supplier categorization rule. When a transaction description matches the pattern (regex), it auto-categorizes to the given account. Saves AI calls for known suppliers.',
    tier: 'write',
    domain: 'bookkeeping',
    params: {
      pattern: { type: 'string', required: true, description: 'Regex pattern to match against description (e.g. "digitalocean|droplet")' },
      supplier_name: { type: 'string', required: true, description: 'Supplier display name' },
      account_code: { type: 'string', required: true, description: 'GL account code to categorize to' },
      is_personal: { type: 'boolean', required: false, description: 'True if personal (director loan)' },
      gst_treatment: { type: 'string', required: false, description: 'gst_inclusive (default), gst_free, no_gst' },
      tags: { type: 'array', required: false, description: 'Tags like ["supplier:digitalocean"]' },
    },
    handler: async (params) => {
      const bk = require('../services/bookkeeperService')
      const id = await bk.createRule(params)
      return { message: `Rule created: "${params.pattern}" → ${params.supplier_name} (${params.account_code})`, id }
    },
  },
  {
    name: 'bookkeeping_list_rules',
    description: 'List all supplier categorization rules — shows pattern, supplier, account, GST treatment',
    tier: 'read',
    domain: 'bookkeeping',
    params: {},
    handler: async () => {
      const bk = require('../services/bookkeeperService')
      const rules = await bk.getAllRules()
      return { rules, count: rules.length }
    },
  },
  {
    name: 'bookkeeping_delete_rule',
    description: 'Delete a supplier categorization rule by ID',
    tier: 'write',
    domain: 'bookkeeping',
    params: {
      id: { type: 'string', required: true, description: 'Rule UUID to delete' },
    },
    handler: async (params) => {
      const bk = require('../services/bookkeeperService')
      await bk.deleteRule(params.id)
      return { message: `Rule ${params.id} deleted` }
    },
  },

  // ═══════════════════════════════════════════════════════════════════════
  // READ: View staged, ledger, reports
  // ═══════════════════════════════════════════════════════════════════════
  {
    name: 'bookkeeping_list_staged',
    description: 'List staged transactions by status. Status: pending, categorized, posted, flagged, ignored. Shows description, amount, category, confidence, date.',
    tier: 'read',
    domain: 'bookkeeping',
    params: {
      status: { type: 'string', required: false, description: 'Filter by status (pending, categorized, posted, flagged, ignored). All if omitted.' },
      limit: { type: 'number', required: false, description: 'Max results (default 50)' },
    },
    handler: async (params) => {
      const bk = require('../services/bookkeeperService')
      const rows = await bk.listStaged(params.status || null, params.limit || 50)
      return { transactions: rows, count: rows.length }
    },
  },
  {
    name: 'bookkeeping_staged_counts',
    description: 'Get counts of staged transactions by status — how many pending, categorized, posted, flagged, ignored',
    tier: 'read',
    domain: 'bookkeeping',
    params: {},
    handler: async () => {
      const bk = require('../services/bookkeeperService')
      return await bk.getStagedCounts()
    },
  },
  {
    name: 'bookkeeping_ledger_transactions',
    description: 'View recent ledger journal entries with their double-entry lines (account, debit, credit)',
    tier: 'read',
    domain: 'bookkeeping',
    params: {
      limit: { type: 'number', required: false, description: 'Max entries (default 20)' },
    },
    handler: async (params) => {
      const bk = require('../services/bookkeeperService')
      return await bk.getLedgerTransactions(params.limit || 20)
    },
  },
  {
    name: 'bookkeeping_trial_balance',
    description: 'Generate a trial balance — total debits and credits per account. Optional as_of date.',
    tier: 'read',
    domain: 'bookkeeping',
    params: {
      as_of: { type: 'string', required: false, description: 'Date in YYYY-MM-DD (all time if omitted)' },
    },
    handler: async (params) => {
      const bk = require('../services/bookkeeperService')
      return await bk.getTrialBalance(params.as_of || null)
    },
  },

  // ═══════════════════════════════════════════════════════════════════════
  // REPORTS: BAS, P&L, Balance Sheet, Expense Breakdown, Director Loan
  // ═══════════════════════════════════════════════════════════════════════
  {
    name: 'bookkeeping_bas_report',
    description: 'Generate BAS/GST report for a period — GST collected, GST paid (input credits), net GST position, total sales, total purchases. Essential for quarterly BAS lodgement.',
    tier: 'read',
    domain: 'bookkeeping',
    params: {
      period_start: { type: 'string', required: true, description: 'Start date YYYY-MM-DD' },
      period_end: { type: 'string', required: true, description: 'End date YYYY-MM-DD' },
    },
    handler: async (params) => {
      const bk = require('../services/bookkeeperService')
      return await bk.getBASReport(params.period_start, params.period_end)
    },
  },
  {
    name: 'bookkeeping_pnl_report',
    description: 'Generate Profit & Loss report — income items, expense items, totals, net profit for a period',
    tier: 'read',
    domain: 'bookkeeping',
    params: {
      period_start: { type: 'string', required: true, description: 'Start date YYYY-MM-DD' },
      period_end: { type: 'string', required: true, description: 'End date YYYY-MM-DD' },
    },
    handler: async (params) => {
      const bk = require('../services/bookkeeperService')
      return await bk.getPnLReport(params.period_start, params.period_end)
    },
  },
  {
    name: 'bookkeeping_balance_sheet',
    description: 'Generate Balance Sheet — assets, liabilities, net position as of a date',
    tier: 'read',
    domain: 'bookkeeping',
    params: {
      as_of: { type: 'string', required: true, description: 'Date YYYY-MM-DD' },
    },
    handler: async (params) => {
      const bk = require('../services/bookkeeperService')
      return await bk.getBalanceSheet(params.as_of)
    },
  },
  {
    name: 'bookkeeping_expense_breakdown',
    description: 'Breakdown expenses by category for a period — which accounts are spending the most',
    tier: 'read',
    domain: 'bookkeeping',
    params: {
      period_start: { type: 'string', required: true, description: 'Start date YYYY-MM-DD' },
      period_end: { type: 'string', required: true, description: 'End date YYYY-MM-DD' },
    },
    handler: async (params) => {
      const bk = require('../services/bookkeeperService')
      return await bk.getExpenseBreakdown(params.period_start, params.period_end)
    },
  },
  {
    name: 'bookkeeping_director_loan',
    description: 'Get the current director loan balance (company owes Tate or Tate owes company) and recent movements. Tracks personal expenses on business account and vice versa.',
    tier: 'read',
    domain: 'bookkeeping',
    params: {},
    handler: async () => {
      const bk = require('../services/bookkeeperService')
      return await bk.getDirectorLoanBalance()
    },
  },
  // ═══════════════════════════════════════════════════════════════════════
  // SEARCH: Find transactions by keyword, date, account
  // ═══════════════════════════════════════════════════════════════════════
  {
    name: 'bookkeeping_search_staged',
    description: 'Search staged (unposted) transactions by keyword, date range, or status. Good for finding specific transactions before posting.',
    tier: 'read',
    domain: 'bookkeeping',
    params: {
      keyword: { type: 'string', required: false, description: 'Search term matched against description (case-insensitive)' },
      date_from: { type: 'string', required: false, description: 'Start date YYYY-MM-DD' },
      date_to: { type: 'string', required: false, description: 'End date YYYY-MM-DD' },
      status: { type: 'string', required: false, description: 'Filter: pending, categorized, posted, flagged, ignored' },
      limit: { type: 'number', required: false, description: 'Max results (default 50)' },
    },
    handler: async (params) => {
      const bk = require('../services/bookkeeperService')
      const rows = await bk.searchStaged({
        keyword: params.keyword, dateFrom: params.date_from, dateTo: params.date_to,
        status: params.status, limit: params.limit || 50,
      })
      return { transactions: rows, count: rows.length }
    },
  },
  {
    name: 'bookkeeping_search_ledger',
    description: 'Search posted ledger entries by keyword, date range, or account code. Returns journal entries with their double-entry lines.',
    tier: 'read',
    domain: 'bookkeeping',
    params: {
      keyword: { type: 'string', required: false, description: 'Search term matched against description (case-insensitive)' },
      date_from: { type: 'string', required: false, description: 'Start date YYYY-MM-DD' },
      date_to: { type: 'string', required: false, description: 'End date YYYY-MM-DD' },
      account_code: { type: 'string', required: false, description: 'Filter by GL account code (e.g. "5010")' },
      limit: { type: 'number', required: false, description: 'Max results (default 50)' },
    },
    handler: async (params) => {
      const bk = require('../services/bookkeeperService')
      const rows = await bk.searchLedger({
        keyword: params.keyword, dateFrom: params.date_from, dateTo: params.date_to,
        accountCode: params.account_code, limit: params.limit || 50,
      })
      return { entries: rows, count: rows.length }
    },
  },

  {
    name: 'bookkeeping_gst_position',
    description: 'Quick GST position check — how much GST collected vs paid, and whether Ecodia owes the ATO or gets a refund this quarter',
    tier: 'read',
    domain: 'bookkeeping',
    params: {
      period_start: { type: 'string', required: false, description: 'Start date (defaults to current quarter)' },
      period_end: { type: 'string', required: false, description: 'End date (defaults to current quarter)' },
    },
    handler: async (params) => {
      const bk = require('../services/bookkeeperService')
      const now = new Date()
      const qStart = new Date(now.getFullYear(), Math.floor(now.getMonth() / 3) * 3, 1)
      const qEnd = new Date(qStart.getFullYear(), qStart.getMonth() + 3, 0)
      const start = params.period_start || qStart.toISOString().slice(0, 10)
      const end = params.period_end || qEnd.toISOString().slice(0, 10)
      return await bk.getGSTSummary(start, end)
    },
  },

  // ═══════════════════════════════════════════════════════════════════════
  // DELETE / BULK: Remove or batch-operate on transactions
  // ═══════════════════════════════════════════════════════════════════════
  {
  // ═══════════════════════════════════════════════════════════════════════
  // REVERSE / CORRECT: Proper accounting corrections
  // ═══════════════════════════════════════════════════════════════════════
  {
    name: 'bookkeeping_reverse_entry',
    description: 'Create a reversing journal entry for a posted ledger transaction. This is the proper way to correct errors — never delete posted entries. Creates a new entry with debits/credits swapped.',
    tier: 'write',
    domain: 'bookkeeping',
    params: {
      id: { type: 'string', required: true, description: 'Ledger transaction UUID to reverse' },
      reason: { type: 'string', required: false, description: 'Why this entry is being reversed' },
    },
    handler: async (params) => {
      const bk = require('../services/bookkeeperService')
      const reversalId = await bk.reverseJournalEntry(params.id, params.reason)
      return { message: `Reversal created`, reversal_id: reversalId, original_id: params.id }
    },
  },

  // ═══════════════════════════════════════════════════════════════════════
  // PERIOD LOCKING: Prevent changes to closed periods
  // ═══════════════════════════════════════════════════════════════════════
  {
    name: 'bookkeeping_lock_period',
    description: 'Lock an accounting period to prevent posting. Use after BAS lodgement or EOFY.',
    tier: 'write',
    domain: 'bookkeeping',
    params: {
      period_start: { type: 'string', required: true, description: 'Period start YYYY-MM-DD' },
      period_end: { type: 'string', required: true, description: 'Period end YYYY-MM-DD' },
    },
    handler: async (params) => {
      const bk = require('../services/bookkeeperService')
      await bk.lockPeriod(params.period_start, params.period_end)
      return { message: `Period ${params.period_start} to ${params.period_end} locked` }
    },
  },
  {
    name: 'bookkeeping_unlock_period',
    description: 'Unlock a previously locked accounting period. Use with caution.',
    tier: 'write',
    domain: 'bookkeeping',
    params: {
      period_start: { type: 'string', required: true, description: 'Period start YYYY-MM-DD' },
      period_end: { type: 'string', required: true, description: 'Period end YYYY-MM-DD' },
    },
    handler: async (params) => {
      const bk = require('../services/bookkeeperService')
      await bk.unlockPeriod(params.period_start, params.period_end)
      return { message: `Period ${params.period_start} to ${params.period_end} unlocked` }
    },
  },
  {
    name: 'bookkeeping_list_periods',
    description: 'List all accounting periods and their lock status',
    tier: 'read',
    domain: 'bookkeeping',
    params: {},
    handler: async () => {
      const bk = require('../services/bookkeeperService')
      return { periods: await bk.listPeriods() }
    },
  },

  // ═══════════════════════════════════════════════════════════════════════
  // EOFY: End of Financial Year closing
  // ═══════════════════════════════════════════════════════════════════════
  {
    name: 'bookkeeping_eofy_close',
    description: 'Perform end of financial year closing. Zeros out all income and expense accounts, rolls net profit into Retained Earnings (3100). Run once per FY after all transactions are posted.',
    tier: 'write',
    domain: 'bookkeeping',
    params: {
      fy_end: { type: 'string', required: true, description: 'Last day of the financial year YYYY-MM-DD (e.g. 2025-06-30)' },
    },
    handler: async (params) => {
      const bk = require('../services/bookkeeperService')
      return await bk.performEOFYClose(params.fy_end)
    },
  },

  // ═══════════════════════════════════════════════════════════════════════
  // RECONCILIATION
  // ═══════════════════════════════════════════════════════════════════════
  {
    name: 'bookkeeping_reconcile_bank',
    description: 'Compare ledger bank balance against actual bank balance as of a date. Finds discrepancies and unmatched items.',
    tier: 'read',
    domain: 'bookkeeping',
    params: {
      bank_balance_cents: { type: 'number', required: true, description: 'Actual bank balance in cents as shown on statement' },
      as_of_date: { type: 'string', required: true, description: 'Date YYYY-MM-DD' },
      account_code: { type: 'string', required: false, description: 'GL account code (default 1000)' },
    },
    handler: async (params) => {
      const bk = require('../services/bookkeeperService')
      return await bk.reconcileBank(params.bank_balance_cents, params.as_of_date, params.account_code || '1000')
    },
  },

  // ═══════════════════════════════════════════════════════════════════════
  // CASH FLOW + TAX
  // ═══════════════════════════════════════════════════════════════════════
  {
    name: 'bookkeeping_cash_flow',
    description: 'Generate cash flow statement for a period — operating, financing, and other cash movements',
    tier: 'read',
    domain: 'bookkeeping',
    params: {
      period_start: { type: 'string', required: true, description: 'Start date YYYY-MM-DD' },
      period_end: { type: 'string', required: true, description: 'End date YYYY-MM-DD' },
    },
    handler: async (params) => {
      const bk = require('../services/bookkeeperService')
      return await bk.getCashFlowStatement(params.period_start, params.period_end)
    },
  },
  {
    name: 'bookkeeping_income_tax_estimate',
    description: 'Estimate company income tax (25% for AU small business Pty Ltd) based on net profit for a financial year',
    tier: 'read',
    domain: 'bookkeeping',
    params: {
      fy_start: { type: 'string', required: true, description: 'FY start YYYY-MM-DD (e.g. 2024-07-01)' },
      fy_end: { type: 'string', required: true, description: 'FY end YYYY-MM-DD (e.g. 2025-06-30)' },
    },
    handler: async (params) => {
      const bk = require('../services/bookkeeperService')
      return await bk.getIncomeTaxEstimate(params.fy_start, params.fy_end)
    },
  },

  // ═══════════════════════════════════════════════════════════════════════
  // RECEIPTS
  // ═══════════════════════════════════════════════════════════════════════
  {
    name: 'bookkeeping_list_receipts',
    description: 'List captured receipts from Gmail/email. Shows supplier, amount, date, match status.',
    tier: 'read',
    domain: 'bookkeeping',
    params: {
      status: { type: 'string', required: false, description: 'Filter: extracted, matched, unmatched, ignored' },
      limit: { type: 'number', required: false, description: 'Max results (default 50)' },
    },
    handler: async (params) => {
      const bk = require('../services/bookkeeperService')
      const receipts = await bk.listReceipts(params.status, params.limit || 50)
      return { receipts, count: receipts.length }
    },
  },
  {
    name: 'bookkeeping_match_receipt',
    description: 'Try to auto-match a receipt to a bank transaction by amount and date proximity',
    tier: 'write',
    domain: 'bookkeeping',
    params: {
      receipt_id: { type: 'string', required: true, description: 'Receipt UUID' },
    },
    handler: async (params) => {
      const bk = require('../services/bookkeeperService')
      const match = await bk.matchReceiptToTransaction(params.receipt_id)
      if (!match) return { message: 'No matching transaction found', matched: false }
      return { message: `Matched to ${match.source} transaction: ${match.description}`, ...match, matched: true }
    },
  },
  {
    name: 'bookkeeping_save_receipt',
    description: 'Save a receipt manually or from email. Provide supplier, amount, date. Will auto-match to transactions.',
    tier: 'write',
    domain: 'bookkeeping',
    params: {
      supplier_name: { type: 'string', required: true, description: 'Supplier name' },
      amount_cents: { type: 'number', required: true, description: 'Total amount in cents' },
      receipt_date: { type: 'string', required: true, description: 'Receipt date YYYY-MM-DD' },
      email_subject: { type: 'string', required: false, description: 'Email subject if from inbox' },
      email_from: { type: 'string', required: false, description: 'Sender email' },
      gmail_thread_id: { type: 'string', required: false, description: 'Gmail thread ID for linking' },
      receipt_number: { type: 'string', required: false, description: 'Invoice/receipt number' },
      gst_amount_cents: { type: 'number', required: false, description: 'GST component in cents' },
    },
    handler: async (params) => {
      const bk = require('../services/bookkeeperService')
      const receipt = await bk.saveReceipt(params)
      const match = await bk.matchReceiptToTransaction(receipt.id)
      return { receipt_id: receipt.id, matched: !!match, match_detail: match }
    },
  },

  // ═══════════════════════════════════════════════════════════════════════
  // CRM LINKING
  // ═══════════════════════════════════════════════════════════════════════
  {
    name: 'bookkeeping_link_to_client',
    description: 'Link a transaction (staged or ledger) to a CRM client and/or project. Connects bookkeeping to the business pipeline.',
    tier: 'write',
    domain: 'bookkeeping',
    params: {
      tx_id: { type: 'string', required: true, description: 'Transaction UUID' },
      client_id: { type: 'string', required: false, description: 'CRM client UUID' },
      project_id: { type: 'string', required: false, description: 'CRM project UUID' },
      table: { type: 'string', required: false, description: 'staged or ledger (default: staged)' },
    },
    handler: async (params) => {
      const bk = require('../services/bookkeeperService')
      return await bk.linkTransactionToClient(params.tx_id, params.client_id, params.project_id, params.table || 'staged')
    },
  },
  {
    name: 'bookkeeping_client_transactions',
    description: 'Get all transactions linked to a CRM client — shows both staged and posted entries',
    tier: 'read',
    domain: 'bookkeeping',
    params: {
      client_id: { type: 'string', required: true, description: 'CRM client UUID' },
    },
    handler: async (params) => {
      const bk = require('../services/bookkeeperService')
      return await bk.getClientTransactions(params.client_id)
    },
  },
  {
    name: 'bookkeeping_project_transactions',
    description: 'Get all transactions linked to a CRM project — shows both staged and posted entries',
    tier: 'read',
    domain: 'bookkeeping',
    params: {
      project_id: { type: 'string', required: true, description: 'CRM project UUID' },
    },
    handler: async (params) => {
      const bk = require('../services/bookkeeperService')
      return await bk.getProjectTransactions(params.project_id)
    },
  },

  {
    name: 'bookkeeping_delete_staged',
    description: 'Delete a staged transaction by ID. Permanently removes it — use ignore if you want to keep it but hide it.',
    tier: 'write',
    domain: 'bookkeeping',
    params: {
      id: { type: 'string', required: true, description: 'Staged transaction UUID' },
    },
    handler: async (params) => {
      const db = require('../config/db')
      const res = await db`DELETE FROM staged_transactions WHERE id = ${params.id} RETURNING id`
      if (!res.length) throw new Error(`Staged transaction ${params.id} not found`)
      return { message: `Deleted staged transaction ${params.id}` }
    },
  },
  {
    name: 'bookkeeping_delete_staged_bulk',
    description: 'Delete multiple staged transactions matching filters. Use with care — this permanently removes them.',
    tier: 'write',
    domain: 'bookkeeping',
    params: {
      ids: { type: 'array', required: false, description: 'Array of UUIDs to delete' },
      status: { type: 'string', required: false, description: 'Delete all with this status (e.g. "ignored")' },
      keyword: { type: 'string', required: false, description: 'Delete all matching this keyword in description' },
      date_from: { type: 'string', required: false, description: 'Delete from this date onwards' },
      date_to: { type: 'string', required: false, description: 'Delete up to this date' },
    },
    handler: async (params) => {
      const db = require('../config/db')
      if (params.ids && params.ids.length) {
        const res = await db`DELETE FROM staged_transactions WHERE id = ANY(${params.ids}) RETURNING id`
        return { message: `Deleted ${res.length} staged transactions`, deleted: res.length }
      }
      const conditions = []
      const values = []
      if (params.status) { conditions.push(`status = $${values.push(params.status)}`); }
      if (params.keyword) { conditions.push(`description ILIKE '%' || $${values.push(params.keyword)} || '%'`); }
      if (params.date_from) { conditions.push(`occurred_at >= $${values.push(params.date_from)}`); }
      if (params.date_to) { conditions.push(`occurred_at <= $${values.push(params.date_to)}`); }
      if (!conditions.length) throw new Error('Must provide ids, status, keyword, or date range')
      const res = await db.unsafe(`DELETE FROM staged_transactions WHERE ${conditions.join(' AND ')} RETURNING id`, values)
      return { message: `Deleted ${res.length} staged transactions`, deleted: res.length }
    },
  },
  {
    name: 'bookkeeping_delete_ledger_entry',
    description: 'Reverse a posted ledger entry by creating a counter-entry. Preserves audit trail. For genuine data-entry mistakes only.',
    tier: 'write',
    domain: 'bookkeeping',
    params: {
      id: { type: 'string', required: true, description: 'Ledger transaction UUID to reverse' },
      reason: { type: 'string', required: false, description: 'Reason for reversal' },
    },
    handler: async (params) => {
      const bk = require('../services/bookkeeperService')
      const reversalId = await bk.reverseJournalEntry(params.id, params.reason || 'Corrected via delete')
      return { message: `Reversed ledger entry ${params.id}`, reversal_id: reversalId }
    },
  },
  {
    name: 'bookkeeping_get_account_transactions',
    description: 'Get all ledger lines for a specific GL account, with their parent journal entry details. Good for seeing everything in an account.',
    tier: 'read',
    domain: 'bookkeeping',
    params: {
      account_code: { type: 'string', required: true, description: 'GL account code (e.g. "5010")' },
      date_from: { type: 'string', required: false, description: 'Start date YYYY-MM-DD' },
      date_to: { type: 'string', required: false, description: 'End date YYYY-MM-DD' },
      limit: { type: 'number', required: false, description: 'Max results (default 50)' },
    },
    handler: async (params) => {
      const db = require('../config/db')
      const conditions = [`l.account_code = $1`]
      const values = [params.account_code]
      if (params.date_from) conditions.push(`t.occurred_at >= $${values.push(params.date_from)}`)
      if (params.date_to) conditions.push(`t.occurred_at <= $${values.push(params.date_to)}`)
      const limit = params.limit || 50
      const rows = await db.unsafe(`
        SELECT l.id, l.debit_cents, l.credit_cents, l.memo, l.tax_code,
               t.id AS tx_id, t.occurred_at, t.description, t.source_system
        FROM ledger_lines l JOIN ledger_transactions t ON t.id = l.tx_id
        WHERE ${conditions.join(' AND ')}
        ORDER BY t.occurred_at DESC LIMIT $${values.push(limit)}`, values)
      return { lines: rows, count: rows.length, account_code: params.account_code }
    },
  },
])
