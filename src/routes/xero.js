const { Router } = require('express')
const crypto = require('crypto')
const auth = require('../middleware/auth')
const db = require('../config/db')
const env = require('../config/env')

const router = Router()
router.use(auth)

// Public router - no auth required (for OAuth callback)
const publicRouter = Router()

const XERO_AUTHORIZE_URL = 'https://login.xero.com/identity/connect/authorize'
const XERO_SCOPE = 'openid profile email accounting.transactions accounting.contacts accounting.settings offline_access'
const STATE_TTL_MS = 10 * 60 * 1000 // 10 minutes

// ── Status ──

router.get('/status', async (_req, res, next) => {
  try {
    const [token] = await db`SELECT expires_at, tenant_id FROM xero_tokens LIMIT 1`
    if (!token) return res.json({ connected: false, expires_at: null, tenant_id: null })
    res.json({ connected: true, expires_at: token.expires_at, tenant_id: token.tenant_id })
  } catch (err) { next(err) }
})

// ── OAuth connect URL ──

router.get('/connect', async (_req, res, next) => {
  try {
    const state = crypto.randomBytes(16).toString('hex')
    const url = new URL(XERO_AUTHORIZE_URL)
    url.searchParams.set('response_type', 'code')
    url.searchParams.set('client_id', env.XERO_CLIENT_ID)
    url.searchParams.set('redirect_uri', env.XERO_REDIRECT_URI)
    url.searchParams.set('scope', XERO_SCOPE)
    url.searchParams.set('state', state)

    await db`
      INSERT INTO kv_store (key, value)
      VALUES (${`xero.oauth_state.${state}`}, ${JSON.stringify({ issued_at: new Date().toISOString() })})
      ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()
    `

    res.json({ authorize_url: url.toString() })
  } catch (err) { next(err) }
})

// ── OAuth callback (public - no auth) ──

publicRouter.get('/callback', async (req, res, next) => {
  try {
    const { code, state, error } = req.query
    if (error) return res.status(400).send(`Xero returned error: ${error}`)
    if (!code || !state) return res.status(400).send('Missing code or state')

    const [row] = await db`SELECT value FROM kv_store WHERE key = ${`xero.oauth_state.${state}`}`
    if (!row) return res.status(400).send('Invalid or expired state - please retry connecting from the app.')

    let payload
    try { payload = JSON.parse(row.value) } catch { payload = null }

    if (!payload?.issued_at || Date.now() - new Date(payload.issued_at).getTime() > STATE_TTL_MS) {
      await db`DELETE FROM kv_store WHERE key = ${`xero.oauth_state.${state}`}`
      return res.status(400).send('State expired - please retry connecting from the app.')
    }

    const xeroService = require('../services/xeroService')
    await xeroService.exchangeCode(code)

    // Consume the nonce so it cannot be replayed
    await db`DELETE FROM kv_store WHERE key = ${`xero.oauth_state.${state}`}`

    res.send('Xero connected successfully. You can close this window.')
  } catch (err) { next(err) }
})

// ── Transactions (from our DB, not live Xero) ──

router.get('/transactions', async (req, res, next) => {
  try {
    const days = Math.min(parseInt(req.query.days) || 30, 365)
    const limit = Math.min(parseInt(req.query.limit) || 50, 200)
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString().split('T')[0]

    const transactions = await db`
      SELECT * FROM transactions
      WHERE date >= ${since}
      ORDER BY date DESC
      LIMIT ${limit}
    `
    const [{ count }] = await db`
      SELECT count(*)::int FROM transactions WHERE date >= ${since}
    `
    res.json({ transactions, total: count })
  } catch (err) { next(err) }
})

// ── Categorize a transaction ──

router.post('/transactions/:id/categorize', async (req, res, next) => {
  try {
    const { account_code, category } = req.body
    if (!account_code) return res.status(400).json({ error: 'account_code is required' })

    const xeroService = require('../services/xeroService')
    const transaction = await xeroService.categorizeTransaction(req.params.id, { account_code, category })
    if (!transaction) return res.status(404).json({ error: 'Transaction not found' })
    res.json({ success: true, transaction })
  } catch (err) { next(err) }
})

// ── Invoices (live Xero API) ──

router.get('/invoices', async (req, res, next) => {
  try {
    const xeroService = require('../services/xeroService')
    const limit = Math.min(parseInt(req.query.limit) || 50, 200)
    const status = req.query.status || undefined

    let invoices
    try {
      invoices = await xeroService.getInvoices({ status, limit })
    } catch (err) {
      if (err.message.includes('No Xero tokens found')) {
        return res.status(503).json({ error: 'Xero not connected', authorize_url: '/api/xero/connect' })
      }
      throw err
    }

    res.json({ invoices })
  } catch (err) { next(err) }
})

// ── Contacts (live Xero API) ──

router.get('/contacts', async (req, res, next) => {
  try {
    const xeroService = require('../services/xeroService')
    const limit = Math.min(parseInt(req.query.limit) || 50, 200)

    let contacts
    try {
      contacts = await xeroService.getContacts({ limit })
    } catch (err) {
      if (err.message.includes('No Xero tokens found')) {
        return res.status(503).json({ error: 'Xero not connected', authorize_url: '/api/xero/connect' })
      }
      throw err
    }

    res.json({ contacts })
  } catch (err) { next(err) }
})

module.exports = router
module.exports.publicRouter = publicRouter
