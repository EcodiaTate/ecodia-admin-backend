/**
 * Bookkeeping service — double-entry ledger, categorization, BAS/GST reports.
 * Human-usable layer: CSV upload, rule-based + AI categorization, journal posting.
 */

const crypto = require('crypto')
const db = require('../config/db')
const logger = require('../config/logger')
const deepseek = require('./deepseekService')

// ═══════════════════════════════════════════════════════════════════════
// CSV PARSING
// ═══════════════════════════════════════════════════════════════════════

function parseBankAustraliaCSV(csvText) {
  const lines = csvText.replace(/\r\n/g, '\n').split('\n')
  if (lines.length < 2) return []

  const header = lines[0].split(',').map(h => h.trim().replace(/^"/, '').replace(/"$/, ''))
  const transactions = []

  for (let i = 1; i < lines.length; i++) {
    const row = _parseCSVRow(lines[i])
    if (row.length < header.length) continue

    const obj = {}
    header.forEach((h, j) => { obj[h] = row[j] })

    const debit = parseFloat(obj['Debit amount'] || '0')
    const credit = parseFloat(obj['Credit amount'] || '0')
    const amountCents = debit ? -Math.abs(Math.round(debit * 100)) : Math.abs(Math.round(credit * 100))
    if (amountCents === 0) continue

    let occurredAt = null
    const dateStr = (obj['Effective date'] || '').trim()
    if (dateStr.includes('/')) {
      const [d, m, y] = dateStr.split('/')
      occurredAt = `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`
    } else {
      occurredAt = dateStr
    }
    if (!occurredAt) continue

    const raw = `${dateStr}${obj['Debit amount'] || ''}${obj['Credit amount'] || ''}${obj['Description'] || ''}${obj['Reference no'] || ''}`
    const sourceRef = `csv:${crypto.createHash('sha256').update(raw).digest('hex').slice(0, 16)}`

    transactions.push({
      source: 'csv',
      source_ref: sourceRef,
      occurred_at: occurredAt,
      amount_cents: amountCents,
      description: (obj['Description'] || '').trim(),
      long_description: (obj['Long description'] || '').trim() || null,
      transaction_type: (obj['Transaction type'] || '').trim() || null,
    })
  }

  return transactions
}

function _parseCSVRow(line) {
  const result = []
  let current = ''
  let inQuotes = false
  for (const ch of line) {
    if (ch === '"') { inQuotes = !inQuotes; continue }
    if (ch === ',' && !inQuotes) { result.push(current.trim()); current = ''; continue }
    current += ch
  }
  result.push(current.trim())
  return result
}

// ═══════════════════════════════════════════════════════════════════════
// STAGED TRANSACTIONS CRUD
// ═══════════════════════════════════════════════════════════════════════

async function upsertStaged(tx) {
  const existing = await db`SELECT id FROM staged_transactions WHERE source_ref = ${tx.source_ref}`
  if (existing.length > 0) return false

  await db`
    INSERT INTO staged_transactions (source, source_ref, occurred_at, amount_cents, description,
      long_description, transaction_type, status)
    VALUES (${tx.source}, ${tx.source_ref}, ${tx.occurred_at}, ${tx.amount_cents},
      ${tx.description}, ${tx.long_description}, ${tx.transaction_type}, 'pending')
  `
  return true
}

async function listStaged(status, limit = 100, offset = 0) {
  if (status) {
    return db`SELECT * FROM staged_transactions WHERE status = ${status} ORDER BY occurred_at DESC LIMIT ${limit} OFFSET ${offset}`
  }
  return db`SELECT * FROM staged_transactions ORDER BY occurred_at DESC LIMIT ${limit} OFFSET ${offset}`
}

async function getStaged(id) {
  const [row] = await db`SELECT * FROM staged_transactions WHERE id = ${id}`
  return row || null
}

async function updateStaged(id, fields) {
  const sets = { ...fields, reviewed_at: new Date(), reviewed_by: 'tate' }
  await db`UPDATE staged_transactions SET ${db(sets, ...Object.keys(sets))} WHERE id = ${id}`
}

async function markPosted(id, ledgerTxId) {
  await db`UPDATE staged_transactions SET status = 'posted', ledger_tx_id = ${ledgerTxId} WHERE id = ${id}`
}

async function markIgnored(id) {
  await db`UPDATE staged_transactions SET status = 'ignored' WHERE id = ${id}`
}

async function getStagedCounts() {
  const rows = await db`SELECT status, count(*)::int AS count FROM staged_transactions GROUP BY status`
  return Object.fromEntries(rows.map(r => [r.status, r.count]))
}

// ═══════════════════════════════════════════════════════════════════════
// SUPPLIER RULES
// ═══════════════════════════════════════════════════════════════════════

async function getAllRules() {
  return db`SELECT * FROM supplier_rules ORDER BY supplier_name`
}

async function createRule(data) {
  const [row] = await db`
    INSERT INTO supplier_rules (pattern, supplier_name, account_code, is_personal, is_business,
      needs_review, gst_treatment, tags)
    VALUES (${data.pattern}, ${data.supplier_name}, ${data.account_code},
      ${data.is_personal || false}, ${data.is_business !== false}, ${data.needs_review || false},
      ${data.gst_treatment || 'gst_inclusive'}, ${JSON.stringify(data.tags || [])})
    RETURNING id
  `
  return row.id
}

async function deleteRule(id) {
  await db`DELETE FROM supplier_rules WHERE id = ${id}`
}

// ═══════════════════════════════════════════════════════════════════════
// CATEGORIZATION (rule match first, then DeepSeek)
// ═══════════════════════════════════════════════════════════════════════

const CATEGORIZE_PROMPT = `You are a bookkeeper for Ecodia Pty Ltd, an Australian GST-registered company.
Director Tate Donohoe uses personal and business accounts interchangeably.
Known personal contacts: Casey Donohoe, T J Donohoe, Angelica Choppin.

Chart of accounts:
1000 Bank (Operating) — asset | 1100 Stripe Clearing — asset | 1200 Accounts Receivable — asset
2100 Director Loan — liability | 2110 GST Paid — asset | 2120 GST Collected — liability
4000 ECO Local Contributions — income | 4100 Ecodia Software Development — income
5005 Advertising & Marketing — expense | 5010 Software & SaaS — expense
5015 Stripe Fees — expense | 5020 Contractor Services — expense
5025 Legal & Compliance — expense | 5030 Office Supplies — expense
5035 Motor Vehicle — expense | 5040 IP Licence Expense — expense

Supplier rules: {rules}

Respond with JSON array. Each: { "source_ref", "account_code", "supplier_name", "is_personal", "gst_amount_cents", "tags":[], "confidence", "reasoning" }
GST = total/11 for standard business expenses. Personal deposits → 2100, is_personal=true. Ambiguous → confidence<0.7.`

async function categorizeTransactions(transactions) {
  if (!transactions.length) return []

  const rules = await getAllRules()
  const results = []
  const needsAI = []

  for (const tx of transactions) {
    const matched = _tryRuleMatch(tx, rules)
    if (matched) results.push(matched)
    else needsAI.push(tx)
  }

  if (needsAI.length) {
    const aiResults = await _callDeepSeekCategorize(needsAI, rules)
    results.push(...aiResults)
  }

  return results
}

function _tryRuleMatch(tx, rules) {
  const desc = `${tx.description} ${tx.long_description || ''}`.toLowerCase()
  for (const rule of rules) {
    try {
      if (new RegExp(rule.pattern, 'i').test(desc)) {
        const amountAbs = Math.abs(tx.amount_cents)
        const gst = rule.gst_treatment === 'gst_inclusive' ? Math.floor(amountAbs / 11) : 0
        const tags = typeof rule.tags === 'string' ? JSON.parse(rule.tags) : (rule.tags || [])
        return {
          source_ref: tx.source_ref,
          account_code: rule.account_code,
          supplier_name: rule.supplier_name,
          is_personal: rule.is_personal || false,
          gst_amount_cents: gst,
          tags,
          confidence: 0.95,
          reasoning: `Matched rule: ${rule.pattern}`,
        }
      }
    } catch { /* invalid regex, skip */ }
  }
  return null
}

async function _callDeepSeekCategorize(transactions, rules) {
  const rulesText = rules.map(r => `  ${r.pattern} → ${r.supplier_name} (${r.account_code})`).join('\n')
  const txText = transactions.map(tx => {
    const dir = tx.amount_cents > 0 ? 'in' : 'out'
    return `- ref:${tx.source_ref} | ${tx.occurred_at} | $${(Math.abs(tx.amount_cents) / 100).toFixed(2)} ${dir} | ${tx.description}`
  }).join('\n')

  try {
    const result = await deepseek.callDeepSeek([
      { role: 'system', content: CATEGORIZE_PROMPT.replace('{rules}', rulesText) },
      { role: 'user', content: `Categorize:\n${txText}` },
    ], { module: 'bookkeeping', skipRetrieval: true, skipLogging: true })

    let text = result.content || ''
    if (text.includes('```')) { text = text.split('```')[1]; if (text.startsWith('json')) text = text.slice(4); text = text.trim() }
    return JSON.parse(text)
  } catch (err) {
    logger.warn('Bookkeeper AI categorization failed', { error: err.message })
    return []
  }
}

async function autoCategorize() {
  const pending = await listStaged('pending', 20)
  if (!pending.length) return { categorized: 0 }

  const results = await categorizeTransactions(pending)
  let categorized = 0

  for (const result of results) {
    const tx = pending.find(t => t.source_ref === result.source_ref)
    if (!tx) continue

    const confidence = result.confidence || 0
    const status = confidence >= 0.7 ? 'categorized' : 'flagged'
    const tags = result.tags || []

    await updateStaged(tx.id, {
      category: result.account_code,
      subcategory: tags[0] || null,
      is_personal: result.is_personal,
      gst_amount_cents: result.gst_amount_cents,
      confidence,
      categorizer_reasoning: result.reasoning,
      status,
    })
    categorized++

    // Auto-post high confidence
    if (confidence >= 0.9) {
      try { await postStagedTransaction(tx.id) } catch { /* will be posted manually */ }
    }
  }

  return { categorized }
}

// ═══════════════════════════════════════════════════════════════════════
// LEDGER: DOUBLE-ENTRY POSTING
// ═══════════════════════════════════════════════════════════════════════

async function postStagedTransaction(stagedId) {
  const tx = await getStaged(stagedId)
  if (!tx) throw new Error('Transaction not found')
  if (!tx.category) throw new Error('Transaction not categorized')
  if (tx.status === 'posted') throw new Error('Already posted')

  const amountAbs = Math.abs(tx.amount_cents)
  const gst = tx.gst_amount_cents || 0
  const exGst = amountAbs - gst
  const isIncome = tx.amount_cents > 0
  const lines = []

  if (tx.is_personal && isIncome) {
    lines.push({ account_code: '1000', debit_cents: amountAbs, credit_cents: 0 })
    lines.push({ account_code: '2100', debit_cents: 0, credit_cents: amountAbs })
  } else if (tx.is_personal && !isIncome) {
    lines.push({ account_code: '2100', debit_cents: amountAbs, credit_cents: 0 })
    lines.push({ account_code: '1000', debit_cents: 0, credit_cents: amountAbs })
  } else if (isIncome) {
    lines.push({ account_code: '1000', debit_cents: amountAbs, credit_cents: 0 })
    if (gst > 0) {
      lines.push({ account_code: tx.category, debit_cents: 0, credit_cents: exGst, tax_code: 'GST' })
      lines.push({ account_code: '2120', debit_cents: 0, credit_cents: gst, tax_code: 'GST', tax_amount_cents: gst })
    } else {
      lines.push({ account_code: tx.category, debit_cents: 0, credit_cents: amountAbs })
    }
  } else {
    if (gst > 0) {
      lines.push({ account_code: tx.category, debit_cents: exGst, credit_cents: 0, tax_code: 'Input' })
      lines.push({ account_code: '2110', debit_cents: gst, credit_cents: 0, tax_code: 'Input', tax_amount_cents: gst })
    } else {
      lines.push({ account_code: tx.category, debit_cents: amountAbs, credit_cents: 0 })
    }
    lines.push({ account_code: '1000', debit_cents: 0, credit_cents: amountAbs })
  }

  // Persist
  const tags = tx.subcategory ? [tx.subcategory] : []
  const supplier = tx.subcategory?.startsWith('supplier:') ? tx.subcategory.replace('supplier:', '') : null

  const [ledgerTx] = await db`
    INSERT INTO ledger_transactions (occurred_at, description, source_system, source_ref, tags, supplier)
    VALUES (${tx.occurred_at}, ${tx.description}, ${tx.source === 'csv' ? 'csv_import' : tx.source},
      ${tx.source_ref}, ${JSON.stringify(tags)}, ${supplier})
    RETURNING id
  `

  for (const line of lines) {
    await db`
      INSERT INTO ledger_lines (tx_id, account_code, debit_cents, credit_cents, tax_code, tax_amount_cents)
      VALUES (${ledgerTx.id}, ${line.account_code}, ${line.debit_cents}, ${line.credit_cents},
        ${line.tax_code || null}, ${line.tax_amount_cents || null})
    `
  }

  await markPosted(stagedId, ledgerTx.id)
  return ledgerTx.id
}

// ═══════════════════════════════════════════════════════════════════════
// REPORTS: BAS, P&L, Balance Sheet, Director Loan
// ═══════════════════════════════════════════════════════════════════════

async function getLedgerTransactions(limit = 50, offset = 0) {
  const txs = await db`SELECT * FROM ledger_transactions ORDER BY occurred_at DESC LIMIT ${limit} OFFSET ${offset}`
  const result = []
  for (const t of txs) {
    const lines = await db`
      SELECT l.*, a.name AS account_name, a.type AS account_type
      FROM ledger_lines l JOIN gl_accounts a ON a.code = l.account_code
      WHERE l.tx_id = ${t.id}
    `
    result.push({ ...t, lines })
  }
  return result
}

async function getTrialBalance(asOf) {
  if (asOf) {
    return db`
      SELECT a.code, a.name, a.type,
        COALESCE(SUM(l.debit_cents), 0)::int AS total_debit,
        COALESCE(SUM(l.credit_cents), 0)::int AS total_credit
      FROM gl_accounts a
      LEFT JOIN ledger_lines l ON l.account_code = a.code
      LEFT JOIN ledger_transactions t ON t.id = l.tx_id AND t.occurred_at <= ${asOf}
      GROUP BY a.code, a.name, a.type
      HAVING COALESCE(SUM(l.debit_cents), 0) > 0 OR COALESCE(SUM(l.credit_cents), 0) > 0
      ORDER BY a.code
    `
  }
  return db`
    SELECT a.code, a.name, a.type,
      COALESCE(SUM(l.debit_cents), 0)::int AS total_debit,
      COALESCE(SUM(l.credit_cents), 0)::int AS total_credit
    FROM gl_accounts a
    LEFT JOIN ledger_lines l ON l.account_code = a.code
    GROUP BY a.code, a.name, a.type
    HAVING COALESCE(SUM(l.debit_cents), 0) > 0 OR COALESCE(SUM(l.credit_cents), 0) > 0
    ORDER BY a.code
  `
}

async function getBASReport(periodStart, periodEnd) {
  const gstRows = await db`
    SELECT a.code,
      COALESCE(SUM(l.debit_cents), 0)::int AS total_debit,
      COALESCE(SUM(l.credit_cents), 0)::int AS total_credit
    FROM ledger_lines l JOIN ledger_transactions t ON t.id = l.tx_id
    JOIN gl_accounts a ON a.code = l.account_code
    WHERE t.occurred_at >= ${periodStart} AND t.occurred_at <= ${periodEnd}
      AND a.code IN ('2110', '2120')
    GROUP BY a.code
  `
  let gstPaid = 0, gstCollected = 0
  for (const r of gstRows) {
    if (r.code === '2110') gstPaid = r.total_debit - r.total_credit
    if (r.code === '2120') gstCollected = r.total_credit - r.total_debit
  }

  const totals = await db`
    SELECT a.type,
      COALESCE(SUM(l.debit_cents), 0)::int AS total_debit,
      COALESCE(SUM(l.credit_cents), 0)::int AS total_credit
    FROM ledger_lines l JOIN ledger_transactions t ON t.id = l.tx_id
    JOIN gl_accounts a ON a.code = l.account_code
    WHERE t.occurred_at >= ${periodStart} AND t.occurred_at <= ${periodEnd}
    GROUP BY a.type
  `
  let totalSales = 0, totalPurchases = 0
  for (const r of totals) {
    if (r.type === 'income') totalSales = r.total_credit - r.total_debit
    if (r.type === 'expense') totalPurchases = r.total_debit - r.total_credit
  }

  return {
    period_start: periodStart, period_end: periodEnd,
    gst_collected_cents: gstCollected, gst_paid_cents: gstPaid,
    net_gst_cents: gstCollected - gstPaid,
    total_sales_cents: totalSales, total_purchases_cents: totalPurchases,
  }
}

async function getPnLReport(periodStart, periodEnd) {
  const rows = await db`
    SELECT a.code, a.name, a.type,
      COALESCE(SUM(l.debit_cents), 0)::int AS total_debit,
      COALESCE(SUM(l.credit_cents), 0)::int AS total_credit
    FROM ledger_lines l JOIN ledger_transactions t ON t.id = l.tx_id
    JOIN gl_accounts a ON a.code = l.account_code
    WHERE t.occurred_at >= ${periodStart} AND t.occurred_at <= ${periodEnd}
      AND a.type IN ('income', 'expense')
    GROUP BY a.code, a.name, a.type ORDER BY a.code
  `
  const income = [], expenses = []
  let totalIncome = 0, totalExpenses = 0
  for (const r of rows) {
    if (r.type === 'income') {
      const amt = r.total_credit - r.total_debit
      income.push({ account_code: r.code, account_name: r.name, amount_cents: amt })
      totalIncome += amt
    } else {
      const amt = r.total_debit - r.total_credit
      expenses.push({ account_code: r.code, account_name: r.name, amount_cents: amt })
      totalExpenses += amt
    }
  }
  return {
    period_start: periodStart, period_end: periodEnd,
    income_items: income, expense_items: expenses,
    total_income_cents: totalIncome, total_expenses_cents: totalExpenses,
    net_profit_cents: totalIncome - totalExpenses,
  }
}

async function getBalanceSheet(asOf) {
  const rows = await db`
    SELECT a.code, a.name, a.type,
      COALESCE(SUM(l.debit_cents), 0)::int AS total_debit,
      COALESCE(SUM(l.credit_cents), 0)::int AS total_credit
    FROM ledger_lines l JOIN ledger_transactions t ON t.id = l.tx_id
    JOIN gl_accounts a ON a.code = l.account_code
    WHERE t.occurred_at <= ${asOf} AND a.type IN ('asset', 'liability')
    GROUP BY a.code, a.name, a.type ORDER BY a.code
  `
  const assets = [], liabilities = []
  let totalAssets = 0, totalLiabilities = 0
  for (const r of rows) {
    if (r.type === 'asset') {
      const bal = r.total_debit - r.total_credit
      assets.push({ account_code: r.code, account_name: r.name, balance_cents: bal })
      totalAssets += bal
    } else {
      const bal = r.total_credit - r.total_debit
      liabilities.push({ account_code: r.code, account_name: r.name, balance_cents: bal })
      totalLiabilities += bal
    }
  }
  return {
    as_of: asOf, assets, liabilities,
    total_assets_cents: totalAssets, total_liabilities_cents: totalLiabilities,
    net_position_cents: totalAssets - totalLiabilities,
  }
}

async function getExpenseBreakdown(periodStart, periodEnd) {
  const rows = await db`
    SELECT a.code, a.name, COALESCE(SUM(l.debit_cents) - SUM(l.credit_cents), 0)::int AS amount
    FROM ledger_lines l JOIN ledger_transactions t ON t.id = l.tx_id
    JOIN gl_accounts a ON a.code = l.account_code
    WHERE t.occurred_at >= ${periodStart} AND t.occurred_at <= ${periodEnd} AND a.type = 'expense'
    GROUP BY a.code, a.name ORDER BY amount DESC
  `
  const categories = Object.fromEntries(rows.map(r => [r.code, r.amount]))
  return { period_start: periodStart, period_end: periodEnd, categories, total_cents: rows.reduce((s, r) => s + r.amount, 0) }
}

async function getDirectorLoanBalance() {
  const [row] = await db`
    SELECT COALESCE(SUM(l.credit_cents) - SUM(l.debit_cents), 0)::int AS balance_cents
    FROM ledger_lines l WHERE l.account_code = '2100'
  `
  const balance = row?.balance_cents || 0
  const recent = await db`
    SELECT t.id AS tx_id, t.occurred_at AS date, t.description,
      l.debit_cents AS debit, l.credit_cents AS credit
    FROM ledger_lines l JOIN ledger_transactions t ON t.id = l.tx_id
    WHERE l.account_code = '2100' ORDER BY t.occurred_at DESC LIMIT 20
  `
  return {
    balance_cents: balance,
    direction: balance > 0 ? 'company_owes_tate' : 'tate_owes_company',
    recent_transactions: recent,
  }
}

async function getGSTSummary(periodStart, periodEnd) {
  const report = await getBASReport(periodStart, periodEnd)
  return {
    gst_collected: report.gst_collected_cents,
    gst_paid: report.gst_paid_cents,
    net: report.net_gst_cents,
    direction: report.net_gst_cents > 0 ? 'owe_ato' : 'refund',
  }
}

// ═══════════════════════════════════════════════════════════════════════
// XERO → STAGED BRIDGE
// Bridge existing Xero transactions into the bookkeeping staged pipeline
// ═══════════════════════════════════════════════════════════════════════

async function importXeroTransactions() {
  const rows = await db`
    SELECT * FROM transactions
    WHERE status = 'uncategorized'
    ORDER BY date DESC LIMIT 50
  `
  let imported = 0
  for (const row of rows) {
    const amountCents = Math.round(parseFloat(row.amount_aud) * 100)
    const created = await upsertStaged({
      source: 'xero',
      source_ref: `xero:${row.xero_id}`,
      occurred_at: row.date,
      amount_cents: row.type === 'debit' ? -Math.abs(amountCents) : Math.abs(amountCents),
      description: row.description,
      long_description: null,
      transaction_type: row.type,
    })
    if (created) imported++
  }
  return { imported }
}

module.exports = {
  parseBankAustraliaCSV, upsertStaged, listStaged, getStaged, updateStaged,
  markPosted, markIgnored, getStagedCounts,
  getAllRules, createRule, deleteRule,
  categorizeTransactions, autoCategorize,
  postStagedTransaction,
  getLedgerTransactions, getTrialBalance,
  getBASReport, getPnLReport, getBalanceSheet, getExpenseBreakdown,
  getDirectorLoanBalance, getGSTSummary,
  importXeroTransactions,
}
