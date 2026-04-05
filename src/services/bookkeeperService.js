/**
 * Bookkeeping service — double-entry ledger, categorization, BAS/GST reports.
 * Human-usable layer: CSV upload, rule-based + AI categorization, journal posting.
 */

const crypto = require('crypto')
const db = require('../config/db')
const logger = require('../config/logger')
const deepseek = require('./deepseekService')

// ═══════════════════════════════════════════════════════════════════════
// CSV PARSING — AI-powered, handles any bank format
// ═══════════════════════════════════════════════════════════════════════

/**
 * AI-parse any bank CSV. Sends the first ~15 rows to DeepSeek to figure out
 * which columns map to date, description, and amount, then applies that
 * mapping to every row. No hardcoded column names.
 */
async function parseAnyBankCSV(csvText) {
  if (!csvText || typeof csvText !== 'string') {
    logger.warn('Bookkeeper CSV: received empty or non-string input', { type: typeof csvText, length: csvText?.length })
    return []
  }

  const lines = csvText.replace(/\r\n/g, '\n').split('\n').filter(l => l.trim())
  if (lines.length < 2) {
    logger.warn('Bookkeeper CSV: less than 2 lines', { lineCount: lines.length, firstLine: lines[0]?.slice(0, 200) })
    return []
  }

  // Parse all rows structurally
  const header = _parseCSVRow(lines[0]).map(h => h.trim())
  const allRows = []
  for (let i = 1; i < lines.length; i++) {
    const row = _parseCSVRow(lines[i])
    if (row.length >= header.length) {
      const obj = {}
      header.forEach((h, j) => { obj[h] = row[j] })
      allRows.push(obj)
    }
  }

  if (allRows.length === 0) {
    logger.warn('Bookkeeper CSV: no data rows parsed', { headers: header })
    return []
  }

  // Send sample to AI to figure out column mapping
  const sample = allRows.slice(0, Math.min(8, allRows.length))
  const mappingPrompt = `You are a bank CSV parser. Given these headers and sample rows, return a JSON mapping object.

Headers: ${JSON.stringify(header)}
Sample rows:
${sample.map((r, i) => `Row ${i + 1}: ${JSON.stringify(r)}`).join('\n')}

Return ONLY a JSON object with these fields:
{
  "date_col": "the column name containing the transaction date",
  "description_col": "the column name containing the transaction description",
  "amount_col": "the column name containing the amount (if single column with +/-)",
  "debit_col": "column for debits (if separate debit/credit columns, else null)",
  "credit_col": "column for credits (if separate debit/credit columns, else null)",
  "date_format": "DMY" or "MDY" or "YMD",
  "amount_is_signed": true if negative means debit and positive means credit,
  "amount_strip": "characters to strip from amount values like $ signs"
}

Rules:
- If amount is a single column (positive/negative or with $), use amount_col and set debit_col/credit_col to null
- If there are separate debit/credit columns, set amount_col to null
- Look at the actual data values, not just headers
- Return ONLY the JSON, no markdown, no explanation`

  let mapping
  try {
    const aiResult = await deepseek.callDeepSeek([{ role: 'user', content: mappingPrompt }], {
      module: 'bookkeeping',
      skipRetrieval: true,
      skipLogging: true,
      temperature: 0,
    })
    const raw = aiResult.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim()
    mapping = JSON.parse(raw)
    logger.info('Bookkeeper CSV: AI column mapping', { mapping, headers: header })
  } catch (err) {
    logger.error('Bookkeeper CSV: AI mapping failed, attempting heuristic fallback', { error: err.message })
    mapping = _heuristicMapping(header)
  }

  // Apply mapping to all rows
  const transactions = []
  for (const obj of allRows) {
    // Parse amount
    let amountCents = 0
    if (mapping.amount_col) {
      const raw = (obj[mapping.amount_col] || '').replace(/[$,\s]/g, '')
      const val = parseFloat(raw)
      if (!isNaN(val)) amountCents = Math.round(val * 100)
    } else if (mapping.debit_col || mapping.credit_col) {
      const debit = parseFloat((obj[mapping.debit_col] || '0').replace(/[$,\s]/g, ''))
      const credit = parseFloat((obj[mapping.credit_col] || '0').replace(/[$,\s]/g, ''))
      amountCents = !isNaN(debit) && debit ? -Math.abs(Math.round(debit * 100))
        : !isNaN(credit) && credit ? Math.abs(Math.round(credit * 100)) : 0
    }
    if (amountCents === 0) continue

    // Parse date
    const dateStr = (obj[mapping.date_col] || '').trim()
    const occurredAt = _normalizeDate(dateStr, mapping.date_format || 'DMY')
    if (!occurredAt) continue

    // Description
    const description = (obj[mapping.description_col] || '').trim()
    if (!description) continue

    // Dedup hash from date + amount + description
    const raw = `${dateStr}${amountCents}${description}`
    const sourceRef = `csv:${crypto.createHash('sha256').update(raw).digest('hex').slice(0, 16)}`

    transactions.push({
      source: 'csv',
      source_ref: sourceRef,
      occurred_at: occurredAt,
      amount_cents: amountCents,
      description,
      long_description: null,
      transaction_type: null,
    })
  }

  logger.info('Bookkeeper CSV: parsed transactions', { count: transactions.length, totalRows: allRows.length })
  return transactions
}

/** Heuristic fallback if AI mapping fails */
function _heuristicMapping(headers) {
  const lower = headers.map(h => h.toLowerCase())
  return {
    date_col: headers[lower.findIndex(h => h.includes('date'))] || headers[0],
    description_col: headers[lower.findIndex(h => h.includes('desc') || h.includes('narr') || h.includes('transaction'))] || headers[1],
    amount_col: headers[lower.findIndex(h => h === 'amount' || h.includes('amount'))] || null,
    debit_col: headers[lower.findIndex(h => h.includes('debit'))] || null,
    credit_col: headers[lower.findIndex(h => h.includes('credit'))] || null,
    date_format: 'DMY',
    amount_is_signed: true,
    amount_strip: '$,',
  }
}

/** Normalize any date string to YYYY-MM-DD */
function _normalizeDate(dateStr, format) {
  if (!dateStr) return null
  // Try slash-separated
  const parts = dateStr.split(/[\/\-.]/)
  if (parts.length === 3) {
    let d, m, y
    if (format === 'DMY') { [d, m, y] = parts }
    else if (format === 'MDY') { [m, d, y] = parts }
    else { [y, m, d] = parts }
    // Handle 2-digit year
    if (y.length === 2) y = (parseInt(y) > 50 ? '19' : '20') + y
    return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`
  }
  return null
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
      long_description, transaction_type, status, source_account)
    VALUES (${tx.source}, ${tx.source_ref}, ${tx.occurred_at}, ${tx.amount_cents},
      ${tx.description}, ${tx.long_description}, ${tx.transaction_type}, 'pending',
      ${tx.source_account || '1000'})
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

const CATEGORIZE_PROMPT = `You are a bookkeeper for Ecodia Pty Ltd, an Australian GST-registered software company.
These transactions come from the director's PERSONAL bank account. Most are personal spending that has nothing to do with the business.

CRITICAL DISTINCTION:
- BUSINESS expenses (software, hosting, domains, advertising, office supplies for Ecodia) → categorize to the right GL account. These create a Director Loan entry (company owes Tate).
- PURELY PERSONAL expenses (fuel, food, drinks, tobacco, groceries, personal transfers, pharmacy, entertainment, bars, restaurants) → set account_code to "DISCARD" and is_personal=true. These should NOT enter the books at all.
- Transfers between Tate's own accounts (SAV, savings) → "DISCARD"
- Bank fees (monthly fee, int tran fee) → 5045 Bank Fees (business expense, the account costs money to run)
- $0.00 transactions (invalid PIN, etc.) → "DISCARD"

Chart of accounts:
1000 Bank (Operating) | 1100 Stripe Clearing | 1200 Accounts Receivable
2100 Director Loan | 2110 GST Paid | 2120 GST Collected
4000 ECO Local Contributions — income | 4100 Ecodia Software Dev — income
5005 Advertising & Marketing | 5010 Software & SaaS | 5015 Stripe Fees
5020 Contractor Services | 5025 Legal & Compliance | 5030 Office Supplies
5035 Motor Vehicle | 5040 IP Licence | 5045 Bank Fees | 5050 Food & Entertainment

Supplier rules: {rules}

Respond with JSON array. Each: { "source_ref", "account_code", "supplier_name", "is_personal", "gst_amount_cents", "tags":[], "confidence", "reasoning" }
- account_code = "DISCARD" for purely personal transactions that don't belong in the books
- GST: domestic business expenses = total/11. International SaaS = 0 (GST-free). Personal = 0.
- is_personal = true for DISCARD items AND for director loan items paid from personal bank
- Ambiguous → confidence < 0.7`

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

    let text = typeof result === 'string' ? result : (result.content || '')
    if (text.includes('```')) { text = text.split('```')[1]; if (text.startsWith('json')) text = text.slice(4); text = text.trim() }
    return JSON.parse(text)
  } catch (err) {
    logger.warn('Bookkeeper AI categorization failed', { error: err.message })
    return []
  }
}

async function autoCategorize() {
  const pending = await listStaged('pending', 500)
  if (!pending.length) return { categorized: 0 }

  const results = await categorizeTransactions(pending)
  let categorized = 0

  for (const result of results) {
    const tx = pending.find(t => t.source_ref === result.source_ref)
    if (!tx) continue

    const confidence = result.confidence || 0
    const tags = result.tags || []

    // DISCARD = purely personal, doesn't belong in the books at all
    if (result.account_code === 'DISCARD') {
      await updateStaged(tx.id, {
        category: 'DISCARD',
        is_personal: true,
        confidence,
        categorizer_reasoning: result.reasoning,
        status: 'ignored',
      })
      categorized++
      continue
    }

    const status = confidence >= 0.7 ? 'categorized' : 'flagged'

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

    // Auto-learn supplier rule from AI categorization (confidence > 0.8)
    if (confidence >= 0.8 && result.supplier_name && !result.reasoning?.startsWith('Matched rule:')) {
      try { await autoLearnRule(tx.description, result.account_code, result.is_personal, 'ai_learned') }
      catch { /* non-critical */ }
    }

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

  // Check period is open
  await checkPeriodOpen(tx.occurred_at)

  const amountAbs = Math.abs(tx.amount_cents)
  const gst = tx.gst_amount_cents || 0
  const exGst = amountAbs - gst
  const isIncome = tx.amount_cents > 0
  // source_account: '1000' = company bank, '2100' = personal bank (director loan)
  const bankAccount = tx.source_account || '1000'
  const lines = []

  // Guard: if category equals the bank account, the journal would DR/CR the same account — skip
  if (tx.category === bankAccount) {
    throw new Error(`Cannot post: category (${tx.category}) is the same as source account (${bankAccount}). This transaction should probably be DISCARD or recategorized.`)
  }

  if (tx.is_personal && !isIncome) {
    // Personal expense on company card: you owe the company
    lines.push({ account_code: '2100', debit_cents: amountAbs, credit_cents: 0 })
    lines.push({ account_code: bankAccount, debit_cents: 0, credit_cents: amountAbs })
  } else if (tx.is_personal && isIncome) {
    // Personal deposit on personal bank: if from company, DR 1000 (company bank) / CR 2100
    // If just personal transfer, should be DISCARD
    lines.push({ account_code: '1000', debit_cents: amountAbs, credit_cents: 0 })
    lines.push({ account_code: '2100', debit_cents: 0, credit_cents: amountAbs })
  } else if (isIncome) {
    lines.push({ account_code: bankAccount, debit_cents: amountAbs, credit_cents: 0 })
    if (gst > 0) {
      lines.push({ account_code: tx.category, debit_cents: 0, credit_cents: exGst, tax_code: 'GST' })
      lines.push({ account_code: '2120', debit_cents: 0, credit_cents: gst, tax_code: 'GST', tax_amount_cents: gst })
    } else {
      lines.push({ account_code: tx.category, debit_cents: 0, credit_cents: amountAbs })
    }
  } else {
    // Business expense — DR expense, CR bank account
    if (gst > 0) {
      lines.push({ account_code: tx.category, debit_cents: exGst, credit_cents: 0, tax_code: 'Input' })
      lines.push({ account_code: '2110', debit_cents: gst, credit_cents: 0, tax_code: 'Input', tax_amount_cents: gst })
    } else {
      lines.push({ account_code: tx.category, debit_cents: amountAbs, credit_cents: 0 })
    }
    lines.push({ account_code: bankAccount, debit_cents: 0, credit_cents: amountAbs })
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

// ═══════════════════════════════════════════════════════════════════════
// SEARCH: Keyword and date-range queries
// ═══════════════════════════════════════════════════════════════════════

async function searchStaged({ keyword, dateFrom, dateTo, status, limit = 50 } = {}) {
  const conditions = []
  const params = []
  if (keyword) conditions.push(`description ILIKE '%' || $${params.push(keyword)} || '%'`)
  if (dateFrom) conditions.push(`occurred_at >= $${params.push(dateFrom)}`)
  if (dateTo) conditions.push(`occurred_at <= $${params.push(dateTo)}`)
  if (status) conditions.push(`status = $${params.push(status)}`)
  const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : ''
  return db.unsafe(
    `SELECT * FROM staged_transactions ${where} ORDER BY occurred_at DESC LIMIT $${params.push(limit)}`,
    params,
  )
}

async function searchLedger({ keyword, dateFrom, dateTo, accountCode, limit = 50 } = {}) {
  const conditions = []
  const params = []
  if (keyword) conditions.push(`t.description ILIKE '%' || $${params.push(keyword)} || '%'`)
  if (dateFrom) conditions.push(`t.occurred_at >= $${params.push(dateFrom)}`)
  if (dateTo) conditions.push(`t.occurred_at <= $${params.push(dateTo)}`)
  if (accountCode) conditions.push(`EXISTS (SELECT 1 FROM ledger_lines l WHERE l.tx_id = t.id AND l.account_code = $${params.push(accountCode)})`)
  const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : ''
  const txs = await db.unsafe(
    `SELECT * FROM ledger_transactions t ${where} ORDER BY t.occurred_at DESC LIMIT $${params.push(limit)}`,
    params,
  )
  const result = []
  for (const t of txs) {
    const lines = await db`
      SELECT l.*, a.name AS account_name FROM ledger_lines l
      JOIN gl_accounts a ON a.code = l.account_code WHERE l.tx_id = ${t.id}`
    result.push({ ...t, lines })
  }
  return result
}

// ═══════════════════════════════════════════════════════════════════════
// REVERSING ENTRIES — proper accounting correction
// ═══════════════════════════════════════════════════════════════════════

async function reverseJournalEntry(txId, reason) {
  const [original] = await db`SELECT * FROM ledger_transactions WHERE id = ${txId}`
  if (!original) throw new Error(`Ledger entry ${txId} not found`)

  const originalLines = await db`SELECT * FROM ledger_lines WHERE tx_id = ${txId}`
  if (!originalLines.length) throw new Error('No lines to reverse')

  const [reversal] = await db`
    INSERT INTO ledger_transactions (occurred_at, description, source_system, source_ref, tags, supplier)
    VALUES (${new Date().toISOString().slice(0, 10)}, ${'REVERSAL: ' + original.description + (reason ? ' — ' + reason : '')},
      'manual', ${'reversal:' + txId}, ${'["reversal"]'}, ${original.supplier})
    RETURNING id`

  for (const line of originalLines) {
    await db`
      INSERT INTO ledger_lines (tx_id, account_code, debit_cents, credit_cents, tax_code, tax_amount_cents, memo)
      VALUES (${reversal.id}, ${line.account_code}, ${line.credit_cents}, ${line.debit_cents},
        ${line.tax_code}, ${line.tax_amount_cents}, ${'Reversal of ' + txId})`
  }

  await logAudit('ledger_transaction', txId, 'reversed', 'system', { original_id: txId }, { reversal_id: reversal.id, reason })
  return reversal.id
}

// ═══════════════════════════════════════════════════════════════════════
// AUDIT LOG
// ════════════════════════════════════════════════════���══════════════════

async function logAudit(entityType, entityId, action, changedBy = 'system', oldValues = null, newValues = null) {
  try {
    await db`INSERT INTO audit_log (entity_type, entity_id, action, changed_by, old_values, new_values)
      VALUES (${entityType}, ${String(entityId)}, ${action}, ${changedBy},
        ${oldValues ? JSON.stringify(oldValues) : null}::jsonb,
        ${newValues ? JSON.stringify(newValues) : null}::jsonb)`
  } catch (err) {
    logger.warn('Audit log write failed', { error: err.message })
  }
}

// ═══════════════════════════════════════════════════════════════════════
// PERIOD LOCKING
// ═══════════════════════════════════════════════════════════════════════

async function checkPeriodOpen(date) {
  const locked = await db`
    SELECT status FROM accounting_periods
    WHERE ${date} BETWEEN period_start AND period_end AND status != 'open'`
  if (locked.length > 0) {
    throw new Error(`Cannot post to locked period containing ${date}. Period is ${locked[0].status}.`)
  }
}

async function lockPeriod(start, end, lockedBy = 'tate') {
  await db`
    INSERT INTO accounting_periods (period_start, period_end, status, locked_at, locked_by)
    VALUES (${start}, ${end}, 'locked', now(), ${lockedBy})
    ON CONFLICT (period_start, period_end) DO UPDATE SET status = 'locked', locked_at = now(), locked_by = ${lockedBy}`
  await logAudit('accounting_period', `${start}:${end}`, 'locked', lockedBy)
}

async function unlockPeriod(start, end) {
  await db`
    UPDATE accounting_periods SET status = 'open', locked_at = null
    WHERE period_start = ${start} AND period_end = ${end}`
}

async function listPeriods() {
  return db`SELECT * FROM accounting_periods ORDER BY period_start DESC`
}

// ═══════════════════════════════════════════════════════════════════════
// EOFY CLOSING
// ═══════════════════════════════════════════════════════════════════════

async function performEOFYClose(fyEnd) {
  // Check if already closed
  const existing = await db`SELECT id FROM ledger_transactions WHERE source_ref = ${'eofy_close:' + fyEnd}`
  if (existing.length) throw new Error(`FY ending ${fyEnd} already closed`)

  const fyStart = `${parseInt(fyEnd.slice(0, 4)) - 1}-07-01`

  // Get all income and expense totals for the FY
  const accounts = await db`
    SELECT a.code, a.type,
      COALESCE(SUM(l.debit_cents), 0)::int AS total_debit,
      COALESCE(SUM(l.credit_cents), 0)::int AS total_credit
    FROM gl_accounts a
    JOIN ledger_lines l ON l.account_code = a.code
    JOIN ledger_transactions t ON t.id = l.tx_id
    WHERE a.type IN ('income', 'expense')
      AND t.occurred_at >= ${fyStart} AND t.occurred_at <= ${fyEnd}
    GROUP BY a.code, a.type
    HAVING COALESCE(SUM(l.debit_cents), 0) != 0 OR COALESCE(SUM(l.credit_cents), 0) != 0`

  if (!accounts.length) throw new Error('No income/expense activity found for this FY')

  const lines = []
  let netToRetained = 0

  for (const a of accounts) {
    const balance = a.total_debit - a.total_credit
    if (balance === 0) continue
    // Zero out the account: if balance is positive (debit heavy), credit it; vice versa
    if (balance > 0) {
      lines.push({ account_code: a.code, debit_cents: 0, credit_cents: balance })
      netToRetained += balance
    } else {
      lines.push({ account_code: a.code, debit_cents: Math.abs(balance), credit_cents: 0 })
      netToRetained -= Math.abs(balance)
    }
  }

  // Net goes to Retained Earnings
  if (netToRetained > 0) {
    lines.push({ account_code: '3100', debit_cents: netToRetained, credit_cents: 0 })
  } else {
    lines.push({ account_code: '3100', debit_cents: 0, credit_cents: Math.abs(netToRetained) })
  }

  const [tx] = await db`
    INSERT INTO ledger_transactions (occurred_at, description, source_system, source_ref, tags)
    VALUES (${fyEnd}, ${'EOFY Close — FY ' + fyStart.slice(0, 4) + '/' + fyEnd.slice(0, 4)}, 'manual', ${'eofy_close:' + fyEnd}, ${'["eofy"]'})
    RETURNING id`

  for (const line of lines) {
    await db`INSERT INTO ledger_lines (tx_id, account_code, debit_cents, credit_cents)
      VALUES (${tx.id}, ${line.account_code}, ${line.debit_cents}, ${line.credit_cents})`
  }

  await logAudit('eofy_close', tx.id, 'created', 'system', null, { fyEnd, lineCount: lines.length })
  return { ledger_tx_id: tx.id, accounts_closed: accounts.length, net_to_retained: netToRetained }
}

// ═══════════════════════════════════════════════════════════════════════
// AUTO-LEARN SUPPLIER RULES
// ═══════════════════════════════════════════════════════════════════════

async function autoLearnRule(description, category, isPersonal, source = 'ai_learned') {
  // Extract a likely supplier pattern from the description
  const words = description.replace(/[#()\[\]{}]/g, '').split(/\s+/).slice(0, 3)
  const pattern = words.join('.*').toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, (m) =>
    ['.*'].includes(m) ? m : '\\' + m
  )
  if (pattern.length < 3) return null

  // Check if rule already exists for this pattern
  const existing = await db`SELECT id FROM supplier_rules WHERE pattern = ${pattern}`
  if (existing.length) return null

  const supplierName = words.map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(' ')
  const [rule] = await db`
    INSERT INTO supplier_rules (pattern, supplier_name, account_code, is_personal, gst_treatment, learning_source, tags)
    VALUES (${pattern}, ${supplierName}, ${category}, ${isPersonal || false}, 'gst_free', ${source}, ${'["auto_learned"]'})
    RETURNING id`

  logger.info('Auto-learned supplier rule', { pattern, supplierName, category, source })
  return rule?.id
}

// ═══════════════════════════════════════════════════════════════════════
// BANK RECONCILIATION
// ═══════════════════════════════════════════════════════════════════════

async function reconcileBank(bankBalanceCents, asOfDate, accountCode = '1000') {
  const [ledger] = await db`
    SELECT COALESCE(SUM(l.debit_cents) - SUM(l.credit_cents), 0)::int AS balance
    FROM ledger_lines l
    JOIN ledger_transactions t ON t.id = l.tx_id
    WHERE l.account_code = ${accountCode} AND t.occurred_at <= ${asOfDate}`

  const ledgerBalance = ledger?.balance || 0
  const difference = bankBalanceCents - ledgerBalance

  await db`
    INSERT INTO bank_reconciliation (account_code, as_of_date, bank_balance, ledger_balance, difference, status)
    VALUES (${accountCode}, ${asOfDate}, ${bankBalanceCents}, ${ledgerBalance}, ${difference},
      ${difference === 0 ? 'reconciled' : 'unreconciled'})`

  // Find unmatched items
  const unposted = await db`
    SELECT count(*)::int AS count FROM staged_transactions
    WHERE source_account = ${accountCode} AND status IN ('pending', 'categorized', 'flagged')
      AND occurred_at <= ${asOfDate}`

  return {
    bank_balance_cents: bankBalanceCents,
    ledger_balance_cents: ledgerBalance,
    difference_cents: difference,
    reconciled: difference === 0,
    unposted_transactions: unposted[0]?.count || 0,
  }
}

// ═══════════════════════════════════════════════════════════════════════
// CASH FLOW STATEMENT
// ═══════════════════════════════════════════════════════════════════════

async function getCashFlowStatement(periodStart, periodEnd) {
  // Direct method: look at actual cash movements through bank accounts
  const flows = await db`
    SELECT a.code, a.name, a.type,
      COALESCE(SUM(CASE WHEN l2.account_code IN ('1000','1100') THEN l.debit_cents ELSE 0 END), 0)::int AS cash_in,
      COALESCE(SUM(CASE WHEN l2.account_code IN ('1000','1100') THEN l.credit_cents ELSE 0 END), 0)::int AS cash_out
    FROM ledger_lines l
    JOIN ledger_transactions t ON t.id = l.tx_id
    JOIN gl_accounts a ON a.code = l.account_code
    JOIN ledger_lines l2 ON l2.tx_id = t.id AND l2.id != l.id
    WHERE t.occurred_at >= ${periodStart} AND t.occurred_at <= ${periodEnd}
      AND l.account_code NOT IN ('1000', '1100')
    GROUP BY a.code, a.name, a.type`

  const operating = flows.filter(f => ['income', 'expense'].includes(f.type))
  const financing = flows.filter(f => f.code === '2100') // Director loan
  const other = flows.filter(f => !['income', 'expense'].includes(f.type) && f.code !== '2100')

  const sum = (items) => items.reduce((s, i) => s + (i.cash_in - i.cash_out), 0)

  return {
    period: { start: periodStart, end: periodEnd },
    operating: { items: operating, net: sum(operating) },
    financing: { items: financing, net: sum(financing) },
    other: { items: other, net: sum(other) },
    net_cash_flow: sum(flows),
  }
}

// ═══════════════════════════════════════════════════════════════════════
// RECEIPT MANAGEMENT
// ═══════════════════════════════════════════════════════════════════════

async function saveReceipt(receipt) {
  const [row] = await db`
    INSERT INTO bk_receipts (source_email, email_message_id, email_subject, email_from, email_date,
      gmail_thread_id, supplier_name, receipt_date, amount_cents, total_amount_cents,
      gst_amount_cents, receipt_number, file_path, file_type, status)
    VALUES (${receipt.source_email || null}, ${receipt.email_message_id || null}, ${receipt.email_subject || null},
      ${receipt.email_from || null}, ${receipt.email_date || null}, ${receipt.gmail_thread_id || null},
      ${receipt.supplier_name || null}, ${receipt.receipt_date || null}, ${receipt.amount_cents || null},
      ${receipt.total_amount_cents || null}, ${receipt.gst_amount_cents || null},
      ${receipt.receipt_number || null}, ${receipt.file_path || null}, ${receipt.file_type || null},
      'extracted')
    RETURNING *`
  return row
}

async function matchReceiptToTransaction(receiptId) {
  const receipt = await db`SELECT * FROM bk_receipts WHERE id = ${receiptId}`.then(r => r[0])
  if (!receipt || !receipt.amount_cents) return null

  // Try to find a matching staged or ledger transaction by amount + date proximity
  const candidates = await db`
    SELECT id, description, amount_cents, occurred_at, 'staged' AS source FROM staged_transactions
    WHERE ABS(amount_cents) = ${Math.abs(receipt.amount_cents)}
      AND occurred_at BETWEEN ${receipt.receipt_date}::date - 3 AND ${receipt.receipt_date}::date + 3
      AND receipt_id IS NULL
    UNION ALL
    SELECT t.id, t.description, (SELECT SUM(debit_cents) FROM ledger_lines WHERE tx_id = t.id)::int AS amount_cents,
      t.occurred_at, 'ledger' AS source FROM ledger_transactions t
    WHERE t.occurred_at BETWEEN ${receipt.receipt_date}::date - 3 AND ${receipt.receipt_date}::date + 3
    ORDER BY occurred_at`

  if (candidates.length === 0) return null

  const best = candidates[0]
  if (best.source === 'staged') {
    await db`UPDATE staged_transactions SET receipt_id = ${receiptId} WHERE id = ${best.id}`
    await db`UPDATE bk_receipts SET matched_staged_id = ${best.id}, status = 'matched', match_confidence = 0.9 WHERE id = ${receiptId}`
  } else {
    await db`UPDATE bk_receipts SET matched_ledger_id = ${best.id}, status = 'matched', match_confidence = 0.9 WHERE id = ${receiptId}`
  }

  return { matched_to: best.id, source: best.source, description: best.description }
}

async function listReceipts(status, limit = 50) {
  if (status) return db`SELECT * FROM bk_receipts WHERE status = ${status} ORDER BY created_at DESC LIMIT ${limit}`
  return db`SELECT * FROM bk_receipts ORDER BY created_at DESC LIMIT ${limit}`
}

// ═══════════════════════════════════════════════════════════════════════
// CRM LINKING
// ═══════════════════════════════════════════════════════════════════════

async function linkTransactionToClient(txId, clientId, projectId, table = 'staged') {
  if (table === 'staged') {
    await db`UPDATE staged_transactions SET client_id = ${clientId || null}, project_id = ${projectId || null} WHERE id = ${txId}`
  } else {
    await db`UPDATE ledger_transactions SET client_id = ${clientId || null}, project_id = ${projectId || null} WHERE id = ${txId}`
  }
  return { linked: true }
}

async function getClientTransactions(clientId, limit = 50) {
  const staged = await db`SELECT *, 'staged' AS source FROM staged_transactions WHERE client_id = ${clientId} ORDER BY occurred_at DESC LIMIT ${limit}`
  const ledger = await db`SELECT *, 'ledger' AS source FROM ledger_transactions WHERE client_id = ${clientId} ORDER BY occurred_at DESC LIMIT ${limit}`
  return { staged, ledger }
}

async function getProjectTransactions(projectId, limit = 50) {
  const staged = await db`SELECT *, 'staged' AS source FROM staged_transactions WHERE project_id = ${projectId} ORDER BY occurred_at DESC LIMIT ${limit}`
  const ledger = await db`SELECT *, 'ledger' AS source FROM ledger_transactions WHERE project_id = ${projectId} ORDER BY occurred_at DESC LIMIT ${limit}`
  return { staged, ledger }
}

// ═══════════════════════════════════════════════════════════════════════
// INCOME TAX ESTIMATE
// ═══════════════════════════════════════════════════════════════════════

async function getIncomeTaxEstimate(fyStart, fyEnd) {
  const pnl = await getPnLReport(fyStart, fyEnd)
  const taxableIncome = pnl.net_profit_cents
  // Australian small business company tax rate: 25%
  const taxCents = Math.max(0, Math.round(taxableIncome * 0.25))
  return {
    taxable_income_cents: taxableIncome,
    tax_rate: 0.25,
    estimated_tax_cents: taxCents,
    period: { start: fyStart, end: fyEnd },
  }
}

module.exports = {
  parseAnyBankCSV, upsertStaged, listStaged, getStaged, updateStaged,
  markPosted, markIgnored, getStagedCounts,
  getAllRules, createRule, deleteRule,
  categorizeTransactions, autoCategorize,
  postStagedTransaction,
  getLedgerTransactions, getTrialBalance,
  getBASReport, getPnLReport, getBalanceSheet, getExpenseBreakdown,
  getDirectorLoanBalance, getGSTSummary,
  importXeroTransactions,
  searchStaged, searchLedger,
  // New
  reverseJournalEntry, logAudit,
  checkPeriodOpen, lockPeriod, unlockPeriod, listPeriods,
  performEOFYClose,
  autoLearnRule,
  reconcileBank,
  getCashFlowStatement,
  saveReceipt, matchReceiptToTransaction, listReceipts,
  linkTransactionToClient, getClientTransactions, getProjectTransactions,
  getIncomeTaxEstimate,
}
