/**
 * Xero MCP tools — transactions, invoices, contacts.
 * Calls the EcodiaOS backend API (which handles Xero OAuth token refresh).
 */
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

  server.tool('xero_get_transactions', {
    description: 'Get recent bank transactions from Xero.',
    inputSchema: {
      type: 'object',
      properties: {
        days: { type: 'number', description: 'Number of days to look back (default 30)' },
        limit: { type: 'number', description: 'Max transactions (default 50)' },
      },
    },
  }, async ({ days = 30, limit = 50 }) => {
    const data = await backendFetch(`/api/xero/transactions?days=${days}&limit=${limit}`)
    return { content: [{ type: 'text', text: JSON.stringify(data.transactions || data, null, 2) }] }
  })

  server.tool('xero_categorize', {
    description: 'Categorize a Xero transaction (set account code).',
    inputSchema: {
      type: 'object',
      properties: {
        transactionId: { type: 'string', description: 'Transaction ID' },
        accountCode: { type: 'string', description: 'GL account code to assign' },
      },
      required: ['transactionId', 'accountCode'],
    },
  }, async ({ transactionId, accountCode }) => {
    const data = await backendFetch(`/api/xero/transactions/${transactionId}/categorize`, {
      method: 'POST',
      body: JSON.stringify({ accountCode }),
    })
    return { content: [{ type: 'text', text: data.success ? 'Categorized.' : `Failed: ${data.error}` }] }
  })

  server.tool('xero_get_invoices', {
    description: 'Get recent invoices from Xero.',
    inputSchema: {
      type: 'object',
      properties: {
        status: { type: 'string', description: 'Filter by status: DRAFT, SUBMITTED, AUTHORISED, PAID' },
        limit: { type: 'number', description: 'Max invoices (default 20)' },
      },
    },
  }, async ({ status, limit = 20 }) => {
    const params = new URLSearchParams({ limit: String(limit) })
    if (status) params.set('status', status)
    const data = await backendFetch(`/api/xero/invoices?${params}`)
    return { content: [{ type: 'text', text: JSON.stringify(data.invoices || data, null, 2) }] }
  })

  server.tool('xero_get_contacts', {
    description: 'Get contacts from Xero.',
    inputSchema: {
      type: 'object',
      properties: {
        search: { type: 'string', description: 'Search by name (optional)' },
        limit: { type: 'number', description: 'Max contacts (default 20)' },
      },
    },
  }, async ({ search, limit = 20 }) => {
    const params = new URLSearchParams({ limit: String(limit) })
    if (search) params.set('search', search)
    const data = await backendFetch(`/api/xero/contacts?${params}`)
    return { content: [{ type: 'text', text: JSON.stringify(data.contacts || data, null, 2) }] }
  })
}
