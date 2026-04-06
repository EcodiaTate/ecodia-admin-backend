const registry = require('../services/capabilityRegistry')

registry.registerMany([
  // ═══════════════════════════════════════════════════════════════════════
  // INGEST: Get transactions into the system
  // ═══════════════════════════════════════════════════════════════════════
  {
    name: 'bookkeeping_ingest_csv',
    description: 'Parse and ingest a bank CSV into the bookkeeping staged pipeline. Pass the raw CSV text content. Deduplicates automatically. Auto-categorizes after import. Bank type is auto-detected (Up Bank personal = director loan). Override with source_account if needed.',
    tier: 'write',
    domain: 'bookkeeping',
    params: {
      csvText: { type: 'string', required: true, description: 'Raw CSV file content from any bank — AI auto-detects column format' },
      source_account: { type: 'string', required: false, description: 'Override: 1000 = company bank, 2100 = personal bank. Omit to auto-detect.' },
    },
    handler: async (params) => {
      const bk = require('../services/bookkeeperService')
      const parsed = await bk.parseAnyBankCSV(params.csvText)
      const transactions = parsed.transactions || parsed
      const detectedBank = parsed.detectedBank || null
      let sourceAccount = params.source_account
      if (!sourceAccount && detectedBank?.isPersonal) sourceAccount = '2100'
      sourceAccount = sourceAccount || '1000'
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
      if (totalDebit === 0) throw new Error('Journal has zero total — nothing to record')

      // Validate date format
      if (!/^\d{4}-\d{2}-\d{2}$/.test(params.occurred_at)) throw new Error(`Invalid date format: ${params.occurred_at}. Use YYYY-MM-DD`)

      // Validate account codes exist
      const codes = [...new Set(params.lines.map(l => l.account_code))]
      const validAccounts = await db`SELECT code FROM gl_accounts WHERE code = ANY(${codes})`
      const validCodes = new Set(validAccounts.map(a => a.code))
      const invalid = codes.filter(c => !validCodes.has(c))
      if (invalid.length) throw new Error(`Unknown account codes: ${invalid.join(', ')}. Create them first with bookkeeping_create_account.`)

      // Check period is open
      const bk = require('../services/bookkeeperService')
      await bk.checkPeriodOpen(params.occurred_at)

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
    description: 'List staged transactions by status. Status: pending, categorized, posted, flagged, ignored. Returns compact rows (no bloated metadata). Use offset to paginate.',
    tier: 'read',
    domain: 'bookkeeping',
    params: {
      status: { type: 'string', required: false, description: 'Filter by status (pending, categorized, posted, flagged, ignored). All if omitted.' },
      limit: { type: 'number', required: false, description: 'Max results (default 50, max 100)' },
      offset: { type: 'number', required: false, description: 'Skip first N results for pagination' },
    },
    handler: async (params) => {
      const bk = require('../services/bookkeeperService')
      const limit = Math.min(params.limit || 50, 100)
      const rows = await bk.listStaged(params.status || null, limit, params.offset || 0)
      // Strip long_description to keep response compact — AI has description for context
      const compact = rows.map(r => ({
        id: r.id,
        occurred_at: r.occurred_at,
        amount_cents: r.amount_cents,
        description: r.description,
        category: r.category,
        subcategory: r.subcategory,
        is_personal: r.is_personal,
        confidence: r.confidence,
        status: r.status,
        source_account: r.source_account,
        categorizer_reasoning: r.categorizer_reasoning ? r.categorizer_reasoning.slice(0, 150) : null,
      }))
      return { transactions: compact, count: compact.length }
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

  // ═══════════════════════════════════════════════════════════════════════
  // DELETE / BULK: Remove or batch-operate on transactions
  // ═══════════════════════════════════════════════════════════════════════
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

  // ═══════════════════════════════════════════════════════════════════════
  // RULE MANAGEMENT: Update existing rules
  // ═══════════════════════════════════════════════════════════════════════
  {
    name: 'bookkeeping_update_rule',
    description: 'Update an existing supplier categorization rule — change pattern, account, GST treatment, personal flag, etc.',
    tier: 'write',
    domain: 'bookkeeping',
    params: {
      id: { type: 'string', required: true, description: 'Rule UUID to update' },
      pattern: { type: 'string', required: false, description: 'New regex pattern' },
      supplier_name: { type: 'string', required: false, description: 'New supplier display name' },
      account_code: { type: 'string', required: false, description: 'New GL account code' },
      is_personal: { type: 'boolean', required: false, description: 'Personal flag' },
      gst_treatment: { type: 'string', required: false, description: 'gst_inclusive, gst_free, or no_gst' },
    },
    handler: async (params) => {
      const db = require('../config/db')
      const { id, ...fields } = params
      if (Object.keys(fields).length === 0) throw new Error('No fields to update')
      await db`UPDATE supplier_rules SET ${db(fields, ...Object.keys(fields))} WHERE id = ${id}`
      return { message: `Rule ${id} updated`, fields }
    },
  },

  // ═══════════════════════════════════════════════════════════════════════
  // RECATEGORIZE + REPOST: Fix a posted transaction end-to-end
  // ═══════════════════════════════════════════════════════════════════════
  {
    name: 'bookkeeping_recategorize_posted',
    description: 'Fix a posted transaction: reverses the old journal entry, updates the staged record with the new category, and re-posts. All-in-one correction flow.',
    tier: 'write',
    domain: 'bookkeeping',
    params: {
      staged_id: { type: 'string', required: true, description: 'Staged transaction UUID (must be status=posted)' },
      new_category: { type: 'string', required: true, description: 'New GL account code' },
      is_personal: { type: 'boolean', required: false, description: 'Update personal flag' },
      gst_amount_cents: { type: 'number', required: false, description: 'New GST amount (0 for GST-free)' },
      reason: { type: 'string', required: false, description: 'Reason for recategorization' },
    },
    handler: async (params) => {
      const bk = require('../services/bookkeeperService')
      const tx = await bk.getStaged(params.staged_id)
      if (!tx) throw new Error('Staged transaction not found')
      if (tx.status !== 'posted') throw new Error(`Transaction status is ${tx.status}, expected posted`)
      if (!tx.ledger_tx_id) throw new Error('No ledger entry linked — cannot reverse')

      // 1. Reverse the old journal
      const reversalId = await bk.reverseJournalEntry(tx.ledger_tx_id, params.reason || 'Recategorization')

      // 2. Update staged record
      const updates = { category: params.new_category, status: 'categorized', ledger_tx_id: null }
      if (params.is_personal !== undefined) updates.is_personal = params.is_personal
      if (params.gst_amount_cents !== undefined) updates.gst_amount_cents = params.gst_amount_cents
      await bk.updateStaged(params.staged_id, updates)

      // 3. Re-post
      const newLedgerId = await bk.postStagedTransaction(params.staged_id)

      return {
        message: `Recategorized: reversed ${tx.ledger_tx_id}, re-posted as ${newLedgerId}`,
        reversal_id: reversalId, new_ledger_id: newLedgerId,
      }
    },
  },

  // ═══════════════════════════════════════════════════════════════════════
  // BULK MANUAL CATEGORIZE: Set category on multiple transactions at once
  // ═══════════════════════════════════════════════════════════════════════
  {
    name: 'bookkeeping_bulk_categorize',
    description: 'Manually categorize multiple staged transactions at once. Pass an array of {id, category, is_personal?, gst_amount_cents?}. Optionally auto-post after categorizing.',
    tier: 'write',
    domain: 'bookkeeping',
    params: {
      items: { type: 'array', required: true, description: 'Array of {id, category, is_personal?, gst_amount_cents?}' },
      auto_post: { type: 'boolean', required: false, description: 'If true, post each transaction after categorizing' },
    },
    handler: async (params) => {
      const bk = require('../services/bookkeeperService')
      if (typeof params.items === 'string') params.items = JSON.parse(params.items)
      let categorized = 0, posted = 0, errors = []
      for (const item of params.items) {
        try {
          const updates = { category: item.category, status: item.category === 'DISCARD' ? 'ignored' : 'categorized' }
          if (item.is_personal !== undefined) updates.is_personal = item.is_personal
          if (item.gst_amount_cents !== undefined) updates.gst_amount_cents = item.gst_amount_cents
          await bk.updateStaged(item.id, updates)
          categorized++
          if (params.auto_post && item.category !== 'DISCARD') {
            try { await bk.postStagedTransaction(item.id); posted++ }
            catch (e) { errors.push({ id: item.id, phase: 'post', error: e.message }) }
          }
        } catch (e) { errors.push({ id: item.id, phase: 'categorize', error: e.message }) }
      }
      return { categorized, posted, errors: errors.length ? errors : undefined }
    },
  },

  // ═══════════════════════════════════════════════════════════════════════
  // AGED RECEIVABLES: Who owes money and how old
  // ═══════════════════════════════════════════════════════════════════════
  {
    name: 'bookkeeping_aged_receivables',
    description: 'Show aged receivables — outstanding amounts in 1200 (Accounts Receivable) broken down by age bucket (current, 30, 60, 90+ days)',
    tier: 'read',
    domain: 'bookkeeping',
    params: {
      as_of: { type: 'string', required: false, description: 'Date YYYY-MM-DD (default: today)' },
    },
    handler: async (params) => {
      const db = require('../config/db')
      const asOf = params.as_of || new Date().toISOString().slice(0, 10)
      const rows = await db`
        SELECT t.id, t.description, t.occurred_at, t.supplier,
          COALESCE(SUM(l.debit_cents) - SUM(l.credit_cents), 0)::int AS balance,
          ${asOf}::date - t.occurred_at::date AS days_old
        FROM ledger_lines l JOIN ledger_transactions t ON t.id = l.tx_id
        WHERE l.account_code = '1200' AND t.occurred_at <= ${asOf}
        GROUP BY t.id, t.description, t.occurred_at, t.supplier
        HAVING COALESCE(SUM(l.debit_cents) - SUM(l.credit_cents), 0) > 0
        ORDER BY t.occurred_at ASC`

      const buckets = { current: 0, '30_days': 0, '60_days': 0, '90_plus': 0 }
      for (const r of rows) {
        if (r.days_old <= 30) buckets.current += r.balance
        else if (r.days_old <= 60) buckets['30_days'] += r.balance
        else if (r.days_old <= 90) buckets['60_days'] += r.balance
        else buckets['90_plus'] += r.balance
      }

      return { as_of: asOf, items: rows, buckets, total_outstanding: rows.reduce((s, r) => s + r.balance, 0) }
    },
  },

  // ═══════════════════════════════════════════════════════════════════════
  // SUPPLIER SPEND REPORT: Spend by supplier over a period
  // ═══════════════════════════════════════════════════════════════════════
  {
    name: 'bookkeeping_supplier_spend',
    description: 'Breakdown spending by supplier for a period — who you are paying and how much',
    tier: 'read',
    domain: 'bookkeeping',
    params: {
      period_start: { type: 'string', required: true, description: 'Start date YYYY-MM-DD' },
      period_end: { type: 'string', required: true, description: 'End date YYYY-MM-DD' },
      limit: { type: 'number', required: false, description: 'Max results (default 50)' },
    },
    handler: async (params) => {
      const db = require('../config/db')
      const rows = await db`
        SELECT t.supplier, COUNT(*)::int AS tx_count,
          COALESCE(SUM(l.debit_cents), 0)::int AS total_spend_cents
        FROM ledger_transactions t
        JOIN ledger_lines l ON l.tx_id = t.id
        JOIN gl_accounts a ON a.code = l.account_code
        WHERE t.occurred_at >= ${params.period_start} AND t.occurred_at <= ${params.period_end}
          AND a.type = 'expense' AND t.supplier IS NOT NULL
        GROUP BY t.supplier ORDER BY total_spend_cents DESC
        LIMIT ${params.limit || 50}`
      return { suppliers: rows, count: rows.length }
    },
  },

  // ═══════════════════════════════════════════════════════════════════════
  // MARK AS DISCARD: Quick way to mark transactions as personal/DISCARD
  // ═══════════════════════════════════════════════════════════════════════
  {
    name: 'bookkeeping_discard_transaction',
    description: 'Mark a staged transaction as DISCARD (purely personal, does not enter the books). Optionally create a rule to auto-discard similar transactions in future.',
    tier: 'write',
    domain: 'bookkeeping',
    params: {
      id: { type: 'string', required: true, description: 'Staged transaction UUID' },
      create_rule: { type: 'boolean', required: false, description: 'If true, auto-learn a DISCARD rule from this transaction' },
    },
    handler: async (params) => {
      const bk = require('../services/bookkeeperService')
      const tx = await bk.getStaged(params.id)
      if (!tx) throw new Error('Transaction not found')
      await bk.updateStaged(params.id, { category: 'DISCARD', is_personal: true, status: 'ignored' })
      let ruleId = null
      if (params.create_rule) {
        ruleId = await bk.autoLearnRule(tx.description, 'DISCARD', true, 'manual_discard')
      }
      return { message: `Transaction discarded${ruleId ? ' + rule created' : ''}`, rule_id: ruleId }
    },
  },

  // ═══════════════════════════════════════════════════════════════════════
  // DUPLICATE DETECTION: Find potential duplicate transactions
  // ═══════════════════════════════════════════════════════════════════════
  {
    name: 'bookkeeping_find_duplicates',
    description: 'Find potential duplicate staged transactions — same amount, same date, similar description. Useful after importing from multiple sources.',
    tier: 'read',
    domain: 'bookkeeping',
    params: {},
    handler: async () => {
      const db = require('../config/db')
      const rows = await db`
        SELECT a.id AS id_a, b.id AS id_b,
          a.description AS desc_a, b.description AS desc_b,
          a.amount_cents, a.occurred_at, a.source AS source_a, b.source AS source_b
        FROM staged_transactions a
        JOIN staged_transactions b ON a.id < b.id
          AND a.amount_cents = b.amount_cents
          AND a.occurred_at = b.occurred_at
          AND a.status NOT IN ('ignored', 'posted') AND b.status NOT IN ('ignored', 'posted')
        ORDER BY a.occurred_at DESC LIMIT 50`
      return { potential_duplicates: rows, count: rows.length }
    },
  },

  // ═══════════════════════════════════════════════════════════════════════
  // UNPOST: Reverse a posted staged transaction back to categorized
  // ═══════════════════════════════════════════════════════════════════════
  {
    name: 'bookkeeping_unpost_transaction',
    description: 'Reverse a posted transaction and set it back to categorized status for re-processing. Creates a reversal journal entry.',
    tier: 'write',
    domain: 'bookkeeping',
    params: {
      id: { type: 'string', required: true, description: 'Staged transaction UUID (must be status=posted)' },
      reason: { type: 'string', required: false, description: 'Reason for unposting' },
    },
    handler: async (params) => {
      const bk = require('../services/bookkeeperService')
      const tx = await bk.getStaged(params.id)
      if (!tx) throw new Error('Transaction not found')
      if (tx.status !== 'posted') throw new Error(`Cannot unpost: status is ${tx.status}`)
      if (!tx.ledger_tx_id) throw new Error('No ledger entry linked')

      const reversalId = await bk.reverseJournalEntry(tx.ledger_tx_id, params.reason || 'Unposted for re-processing')
      await bk.updateStaged(params.id, { status: 'categorized', ledger_tx_id: null })

      return { message: `Unposted. Reversal: ${reversalId}`, reversal_id: reversalId }
    },
  },

  // ═══════════════════════════════════════════════════════════════════════
  // QUESTION SURFACING & REVIEW
  // ═══════════════════════════════════════════════════════════════════════
  {
    name: 'bookkeeping_get_questions',
    description: 'Get flagged transactions that need human input. Returns them as plain English questions.',
    tier: 'read',
    domain: 'bookkeeping',
    params: {},
    handler: async () => {
      const db = require('../config/db')
      const flagged = await db`
        SELECT id, description, occurred_at, amount_cents, category, categorizer_reasoning, confidence, source_account
        FROM staged_transactions WHERE status = 'flagged'
        ORDER BY occurred_at DESC LIMIT 20
      `
      if (flagged.length === 0) return { questions: [], message: 'Nothing needs review.' }
      return {
        questions: flagged.map(tx => ({
          id: tx.id,
          question: `$${Math.abs(tx.amount_cents / 100).toFixed(2)} ${tx.amount_cents > 0 ? 'received' : 'spent'} on ${tx.occurred_at ? new Date(tx.occurred_at).toLocaleDateString('en-AU') : '?'} — "${tx.description}" — ${tx.categorizer_reasoning || 'Unsure'}. Business or personal?`,
          currentCategory: tx.category,
          confidence: tx.confidence,
        })),
        count: flagged.length,
      }
    },
  },
  {
    name: 'bookkeeping_resolve_question',
    description: 'Resolve a flagged transaction. Set as business (with account code) or personal (DISCARD).',
    tier: 'write',
    domain: 'bookkeeping',
    params: {
      transactionId: { type: 'string', required: true },
      isPersonal: { type: 'boolean', required: true, description: 'true=DISCARD, false=business' },
      accountCode: { type: 'string', required: false, description: 'GL code if business (e.g. "5010")' },
    },
    handler: async (params) => {
      const bk = require('../services/bookkeeperService')
      if (params.isPersonal) {
        await bk.updateStaged(params.transactionId, { category: 'DISCARD', is_personal: true, confidence: 1.0, categorizer_reasoning: 'Human: personal', status: 'ignored' })
        return { message: 'Discarded.' }
      }
      if (!params.accountCode) return { error: 'Need account code for business expenses' }
      await bk.updateStaged(params.transactionId, { category: params.accountCode, is_personal: true, confidence: 1.0, categorizer_reasoning: 'Human: business', status: 'categorized' })
      return { message: `Categorized as ${params.accountCode}.` }
    },
  },
  {
    name: 'bookkeeping_review_ignored',
    description: 'Scan ignored transactions for potential business expenses that were wrongly discarded. Returns only the suspicious ones (known business merchants that got ignored).',
    tier: 'read',
    domain: 'bookkeeping',
    params: {
      limit: { type: 'number', required: false, description: 'Max results (default 50)' },
    },
    handler: async (params) => {
      const db = require('../config/db')
      // Find ignored transactions whose descriptions match known business patterns
      const businessPatterns = [
        'vercel', 'godaddy', 'google.*workspace', 'google.*cloud', 'gsuite',
        'linkedin.*prem', 'facebk', 'facebook', 'openai', 'chatgpt', 'anthropic',
        'canva', 'wordpress', 'hostinger', 'render\\.com', 'macincloud',
        'asic', 'bizcover', 'ecodia setup', 'avery', 'userswp', 'ayecode',
      ]
      const patternRegex = businessPatterns.join('|')
      const suspicious = await db`
        SELECT id, description, occurred_at, amount_cents, category, categorizer_reasoning, source_account
        FROM staged_transactions
        WHERE status = 'ignored'
          AND description ~* ${patternRegex}
        ORDER BY occurred_at DESC
        LIMIT ${params.limit || 50}
      `
      return {
        suspicious: suspicious.map(tx => ({
          id: tx.id,
          description: tx.description,
          amount: `$${Math.abs(tx.amount_cents / 100).toFixed(2)}`,
          date: tx.occurred_at ? new Date(tx.occurred_at).toLocaleDateString('en-AU') : '?',
          wrongReason: tx.categorizer_reasoning?.slice(0, 100),
        })),
        count: suspicious.length,
        message: suspicious.length > 0
          ? `Found ${suspicious.length} ignored transactions that look like business expenses. Review and re-categorize with bookkeeping_resolve_question.`
          : 'No wrongly-ignored business transactions found.',
      }
    },
  },
  {
    name: 'bookkeeping_bulk_recategorize',
    description: 'Re-run AI categorization on transactions that were wrongly categorized. Pass an array of transaction IDs to reset to pending and re-categorize.',
    tier: 'write',
    domain: 'bookkeeping',
    params: {
      transactionIds: { type: 'string', required: true, description: 'Comma-separated list of staged transaction UUIDs to re-categorize' },
    },
    handler: async (params) => {
      const bk = require('../services/bookkeeperService')
      const db = require('../config/db')
      const ids = params.transactionIds.split(',').map(id => id.trim()).filter(Boolean)
      if (ids.length === 0) return { error: 'No IDs provided' }
      if (ids.length > 100) return { error: 'Max 100 at a time' }

      // Reset to pending
      await db`
        UPDATE staged_transactions
        SET status = 'pending', category = NULL, is_personal = NULL,
            confidence = NULL, categorizer_reasoning = NULL
        WHERE id = ANY(${ids})
      `

      // Re-run categorization
      await bk.autoCategorize()

      return { message: `Reset ${ids.length} transactions to pending and re-categorized.` }
    },
  },
])
