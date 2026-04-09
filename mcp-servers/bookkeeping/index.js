#!/usr/bin/env node
/**
 * Bookkeeping MCP Server — exposes the full bookkeeping system to the OS Session.
 *
 * Thin HTTP wrapper over the EcodiaOS bookkeeping API routes.
 * All heavy logic lives in bookkeeperService.js.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'

const API_BASE = process.env.BK_API_BASE || 'http://localhost:3001'
const API_TOKEN = process.env.BK_API_TOKEN || ''

async function api(method, path, body, query) {
  const url = new URL(`${API_BASE}${path}`)
  if (query) Object.entries(query).forEach(([k, v]) => v != null && url.searchParams.set(k, v))
  const res = await fetch(url.toString(), {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(API_TOKEN ? { Authorization: `Bearer ${API_TOKEN}` } : {}),
    },
    ...(body != null ? { body: JSON.stringify(body) } : {}),
  })
  const text = await res.text()
  try { return { ok: res.ok, status: res.status, data: JSON.parse(text) }
  } catch { return { ok: res.ok, status: res.status, data: text } }
}

function ok(data) {
  return { content: [{ type: 'text', text: typeof data === 'string' ? data : JSON.stringify(data, null, 2) }] }
}
function err(msg, detail) {
  const text = detail ? `Error: ${msg}\n${typeof detail === 'string' ? detail : JSON.stringify(detail)}` : `Error: ${msg}`
  return { content: [{ type: 'text', text }] }
}

const server = new McpServer({ name: 'bookkeeping', version: '1.0.0' })

// ── Staged transactions ───────────────────────────────────────────────

server.tool('bk_list_staged',
  'List staged (unposted) transactions. Filter by status: pending, categorized, ignored. Use to see what needs categorising.',
  {
    status: z.enum(['pending', 'categorized', 'ignored', 'all']).optional().describe('Filter by status (default: pending)'),
    limit:  z.number().optional().describe('Max results (default 100)'),
    offset: z.number().optional().describe('Pagination offset'),
  },
  async ({ status, limit, offset }) => {
    const { ok: success, data } = await api('GET', '/api/bookkeeping/staged', null, {
      status: status === 'all' ? null : (status || 'pending'),
      limit: limit || 100,
      offset: offset || 0,
    })
    if (!success) return err('Failed to list staged', data)
    return ok(data)
  }
)

server.tool('bk_staged_counts',
  'Get counts of staged transactions by status — quick health check before diving in.',
  {},
  async () => {
    const { ok: success, data } = await api('GET', '/api/bookkeeping/staged/counts')
    if (!success) return err('Failed to get counts', data)
    return ok(data)
  }
)

server.tool('bk_categorize',
  'Categorise a staged transaction — set its account code, description, and whether it\'s personal.',
  {
    id:          z.string().describe('Staged transaction UUID'),
    category:    z.string().describe('Account code e.g. "5000", "4100", or "DISCARD" to discard personal items'),
    description: z.string().optional().describe('Clean description to store'),
    isPersonal:  z.boolean().optional().describe('Mark as personal (non-business) transaction'),
  },
  async ({ id, category, description, isPersonal }) => {
    const body = { category, ...(description ? { description } : {}), ...(isPersonal != null ? { is_personal: isPersonal } : {}), status: 'categorized' }
    const { ok: success, data } = await api('PATCH', `/api/bookkeeping/staged/${id}`, body)
    if (!success) return err('Failed to categorize', data)
    return ok({ categorized: id, category })
  }
)

server.tool('bk_auto_categorize',
  'Run AI auto-categorisation on all pending staged transactions. Processes up to 60 at a time.',
  {},
  async () => {
    const { ok: success, data } = await api('POST', '/api/bookkeeping/categorize')
    if (!success) return err('Auto-categorise failed', data)
    return ok(data)
  }
)

server.tool('bk_post_transaction',
  'Post a categorised staged transaction to the ledger.',
  { id: z.string().describe('Staged transaction UUID') },
  async ({ id }) => {
    const { ok: success, data } = await api('POST', `/api/bookkeeping/staged/${id}/post`)
    if (!success) return err('Post failed', data)
    return ok(data)
  }
)

server.tool('bk_batch_post',
  'Post ALL categorised staged transactions to the ledger in one go. Skips DISCARDs.',
  {},
  async () => {
    const { ok: success, data } = await api('POST', '/api/bookkeeping/staged/batch-post')
    if (!success) return err('Batch post failed', data)
    return ok(data)
  }
)

server.tool('bk_discard',
  'Discard a transaction (mark as personal/non-business). Optionally auto-learn a rule so similar ones auto-discard.',
  {
    id:    z.string().describe('Staged transaction UUID'),
    learn: z.boolean().optional().describe('Auto-learn a discard rule for this description (default false)'),
  },
  async ({ id, learn }) => {
    const { ok: success, data } = await api('POST', `/api/bookkeeping/staged/${id}/discard`, null, { learn: learn ? 'true' : 'false' })
    if (!success) return err('Discard failed', data)
    return ok({ discarded: id })
  }
)

// ── Reports ───────────────────────────────────────────────────────────

server.tool('bk_pnl',
  'Profit & Loss report for a date range.',
  {
    from: z.string().optional().describe('Start date YYYY-MM-DD (default: start of current financial year)'),
    to:   z.string().optional().describe('End date YYYY-MM-DD (default: today)'),
  },
  async ({ from, to }) => {
    const { ok: success, data } = await api('GET', '/api/bookkeeping/reports/pnl', null, { from, to })
    if (!success) return err('P&L failed', data)
    return ok(data)
  }
)

server.tool('bk_balance_sheet',
  'Balance sheet as at a given date.',
  { asAt: z.string().optional().describe('Date YYYY-MM-DD (default: today)') },
  async ({ asAt }) => {
    const { ok: success, data } = await api('GET', '/api/bookkeeping/reports/balance-sheet', null, { as_at: asAt })
    if (!success) return err('Balance sheet failed', data)
    return ok(data)
  }
)

server.tool('bk_bas',
  'BAS (Business Activity Statement) / GST report for a quarter.',
  {
    from: z.string().optional().describe('Quarter start YYYY-MM-DD'),
    to:   z.string().optional().describe('Quarter end YYYY-MM-DD'),
  },
  async ({ from, to }) => {
    const { ok: success, data } = await api('GET', '/api/bookkeeping/reports/bas', null, { from, to })
    if (!success) return err('BAS failed', data)
    return ok(data)
  }
)

server.tool('bk_cash_flow',
  'Cash flow summary — money in vs money out over a period.',
  {
    from: z.string().optional().describe('Start date YYYY-MM-DD'),
    to:   z.string().optional().describe('End date YYYY-MM-DD'),
  },
  async ({ from, to }) => {
    const { ok: success, data } = await api('GET', '/api/bookkeeping/reports/expense-breakdown', null, { from, to })
    if (!success) return err('Cash flow failed', data)
    return ok(data)
  }
)

server.tool('bk_trial_balance',
  'Trial balance — all accounts with debit/credit totals.',
  { asAt: z.string().optional().describe('Date YYYY-MM-DD (default: today)') },
  async ({ asAt }) => {
    const { ok: success, data } = await api('GET', '/api/bookkeeping/ledger/trial-balance', null, { as_at: asAt })
    if (!success) return err('Trial balance failed', data)
    return ok(data)
  }
)

server.tool('bk_gst_position',
  'Current GST position — how much GST is owed or refundable.',
  {},
  async () => {
    const { ok: success, data } = await api('GET', '/api/bookkeeping/reports/gst-summary')
    if (!success) return err('GST summary failed', data)
    return ok(data)
  }
)

// ── Ledger ────────────────────────────────────────────────────────────

server.tool('bk_ledger',
  'Search posted ledger transactions.',
  {
    search:    z.string().optional().describe('Text search on description'),
    account:   z.string().optional().describe('Filter by account code'),
    from:      z.string().optional().describe('From date YYYY-MM-DD'),
    to:        z.string().optional().describe('To date YYYY-MM-DD'),
    limit:     z.number().optional().describe('Max results (default 50)'),
    offset:    z.number().optional().describe('Pagination offset'),
  },
  async (params) => {
    const { ok: success, data } = await api('GET', '/api/bookkeeping/ledger/transactions', null, {
      search: params.search, account: params.account,
      from: params.from, to: params.to,
      limit: params.limit || 50, offset: params.offset || 0,
    })
    if (!success) return err('Ledger query failed', data)
    return ok(data)
  }
)

// ── Rules ─────────────────────────────────────────────────────────────

server.tool('bk_list_rules',
  'List auto-categorisation rules.',
  {},
  async () => {
    const { ok: success, data } = await api('GET', '/api/bookkeeping/rules')
    if (!success) return err('Failed to list rules', data)
    return ok(data)
  }
)

server.tool('bk_create_rule',
  'Create a categorisation rule — pattern match → auto-assign account code.',
  {
    pattern:     z.string().describe('Text pattern to match in transaction description'),
    category:    z.string().describe('Account code to assign e.g. "5000", or "DISCARD"'),
    isPersonal:  z.boolean().optional().describe('Mark matched transactions as personal'),
    description: z.string().optional().describe('Clean description override for matched transactions'),
  },
  async ({ pattern, category, isPersonal, description }) => {
    const { ok: success, data } = await api('POST', '/api/bookkeeping/rules', { pattern, category, is_personal: isPersonal || false, description })
    if (!success) return err('Failed to create rule', data)
    return ok(data)
  }
)

server.tool('bk_delete_rule',
  'Delete a categorisation rule.',
  { id: z.string().describe('Rule UUID') },
  async ({ id }) => {
    const { ok: success, data } = await api('DELETE', `/api/bookkeeping/rules/${id}`)
    if (!success) return err('Failed to delete rule', data)
    return ok({ deleted: id })
  }
)

// ── Accounts ──────────────────────────────────────────────────────────

server.tool('bk_list_accounts',
  'List all chart of accounts — account codes, names, types.',
  {},
  async () => {
    const { ok: success, data } = await api('GET', '/api/bookkeeping/accounts')
    if (!success) return err('Failed to list accounts', data)
    return ok(data)
  }
)

// ── Director Loan ─────────────────────────────────────────────────────

server.tool('bk_director_loan_balance',
  'Current director loan account balance — what the company owes Tate (or vice versa).',
  {},
  async () => {
    const { ok: success, data } = await api('GET', '/api/bookkeeping/director-loan/balance')
    if (!success) return err('Failed to get director loan balance', data)
    return ok(data)
  }
)

// ── Connect ───────────────────────────────────────────────────────────

const transport = new StdioServerTransport()
await server.connect(transport)
