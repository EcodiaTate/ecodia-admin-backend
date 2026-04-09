/**
 * Xero MCP tools — transactions, invoices, contacts.
 * Calls the EcodiaOS backend API (which handles Xero OAuth token refresh).
 */
import { z } from 'zod'

const BACKEND_URL = process.env.ECODIA_BACKEND_URL || 'http://localhost:3001'
const BACKEND_TOKEN = process.env.ECODIA_INTERNAL_TOKEN || ''

async function backendFetch(path, opts = {}) {
  const res = await fetch(`${BACKEND_URL}${path}`, {
    ...opts,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${BACKEND_TOKEN}`,
      ...opts.headers,
    },
  })
  if (!res.ok) throw new Error(`Backend ${res.status}: ${await res.text()}`)
  return res.json()
}

export function registerXeroTools(server) {

  server.tool('xero_get_transactions',
    'Get recent bank transactions from Xero.',
    z.object({
      days: z.number().optional().describe('Number of days to look back (default 30)'),
      limit: z.number().optional().describe('Max transactions (default 50)'),
    }),
    async ({ days = 30, limit = 50 } = {}) => {
      const data = await backendFetch(`/api/xero/transactions?days=${days}&limit=${limit}`)
      return { content: [{ type: 'text', text: JSON.stringify(data.transactions || data, null, 2) }] }
    })

  server.tool('xero_categorize',
    'Categorize a Xero transaction (set account code).',
    z.object({
      transactionId: z.string().describe('Transaction ID'),
      accountCode: z.string().describe('GL account code to assign'),
    }),
    async ({ transactionId, accountCode }) => {
      const data = await backendFetch(`/api/xero/transactions/${transactionId}/categorize`, {
        method: 'POST',
        body: JSON.stringify({ accountCode }),
      })
      return { content: [{ type: 'text', text: data.success ? 'Categorized.' : `Failed: ${data.error}` }] }
    })

  server.tool('xero_get_invoices',
    'Get recent invoices from Xero.',
    z.object({
      status: z.string().optional().describe('Filter by status: DRAFT, SUBMITTED, AUTHORISED, PAID'),
      limit: z.number().optional().describe('Max invoices (default 20)'),
    }),
    async ({ status, limit = 20 } = {}) => {
      const params = new URLSearchParams({ limit: String(limit) })
      if (status) params.set('status', status)
      const data = await backendFetch(`/api/xero/invoices?${params}`)
      return { content: [{ type: 'text', text: JSON.stringify(data.invoices || data, null, 2) }] }
    })

  server.tool('xero_get_contacts',
    'Get contacts from Xero.',
    z.object({
      search: z.string().optional().describe('Search by name (optional)'),
      limit: z.number().optional().describe('Max contacts (default 20)'),
    }),
    async ({ search, limit = 20 } = {}) => {
      const params = new URLSearchParams({ limit: String(limit) })
      if (search) params.set('search', search)
      const data = await backendFetch(`/api/xero/contacts?${params}`)
      return { content: [{ type: 'text', text: JSON.stringify(data.contacts || data, null, 2) }] }
    })
}
