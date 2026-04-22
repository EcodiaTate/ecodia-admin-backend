const { Router } = require('express')
const crypto = require('crypto')
const auth = require('../middleware/auth')
const db = require('../config/db')
const env = require('../config/env')

const router = Router()
router.use(auth)

const publicRouter = Router()

const CANVA_AUTHORIZE_URL = 'https://www.canva.com/api/oauth/authorize'
const CANVA_SCOPE = 'asset:read asset:write brandtemplate:content:read brandtemplate:meta:read design:content:read design:content:write design:meta:read folder:read folder:write profile:read'
const STATE_TTL_MS = 10 * 60 * 1000 // 10 minutes

// ── Status ──

router.get('/status', async (_req, res, next) => {
  try {
    const canvaService = require('../services/canvaService')
    res.json(await canvaService.getStatus())
  } catch (err) { next(err) }
})

// ── OAuth connect URL (PKCE) ──

router.get('/connect', async (_req, res, next) => {
  try {
    if (!env.CANVA_CLIENT_ID) {
      return res.status(503).json({ error: 'Canva credentials not configured' })
    }

    // Generate PKCE pair
    const code_verifier = crypto.randomBytes(64).toString('base64url')
    const code_challenge = crypto.createHash('sha256').update(code_verifier).digest('base64url')
    const state = crypto.randomBytes(16).toString('hex')

    await db`
      INSERT INTO kv_store (key, value)
      VALUES (
        ${`canva.oauth_state.${state}`},
        ${JSON.stringify({ issued_at: new Date().toISOString(), code_verifier })}
      )
      ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()
    `

    const url = new URL(CANVA_AUTHORIZE_URL)
    url.searchParams.set('response_type', 'code')
    url.searchParams.set('client_id', env.CANVA_CLIENT_ID)
    url.searchParams.set('redirect_uri', env.CANVA_REDIRECT_URI)
    url.searchParams.set('scope', CANVA_SCOPE)
    url.searchParams.set('state', state)
    url.searchParams.set('code_challenge', code_challenge)
    url.searchParams.set('code_challenge_method', 's256')

    res.json({ authorize_url: url.toString() })
  } catch (err) { next(err) }
})

// ── OAuth callback (public - no auth) ──

publicRouter.get('/oauth/callback', async (req, res, next) => {
  try {
    const { code, state, error, error_description } = req.query

    if (error) {
      return res.status(400).send(`Canva returned error: ${error}${error_description ? ` - ${error_description}` : ''}`)
    }
    if (!code || !state) return res.status(400).send('Missing code or state')

    const [row] = await db`SELECT value FROM kv_store WHERE key = ${`canva.oauth_state.${state}`}`
    if (!row) return res.status(400).send('Invalid or expired state - please retry connecting from the app.')

    let payload
    try { payload = JSON.parse(row.value) } catch { payload = null }

    if (!payload?.issued_at || !payload?.code_verifier) {
      await db`DELETE FROM kv_store WHERE key = ${`canva.oauth_state.${state}`}`
      return res.status(400).send('Malformed state - please retry connecting from the app.')
    }

    if (Date.now() - new Date(payload.issued_at).getTime() > STATE_TTL_MS) {
      await db`DELETE FROM kv_store WHERE key = ${`canva.oauth_state.${state}`}`
      return res.status(400).send('State expired - please retry connecting from the app.')
    }

    const canvaService = require('../services/canvaService')
    await canvaService.exchangeCode(code, payload.code_verifier)

    await db`DELETE FROM kv_store WHERE key = ${`canva.oauth_state.${state}`}`

    res.send('Canva connected successfully. You can close this window.')
  } catch (err) { next(err) }
})

// ── Designs ──

router.get('/designs', async (req, res, next) => {
  try {
    const canvaService = require('../services/canvaService')
    const { query, continuation, ownership, sort_by } = req.query
    res.json(await canvaService.listDesigns({ query, continuation, ownership, sort_by }))
  } catch (err) { next(err) }
})

router.post('/designs/from-template', async (req, res, next) => {
  try {
    const canvaService = require('../services/canvaService')
    const { templateId, title } = req.body
    res.json(await canvaService.createDesignFromTemplate({ templateId, title }))
  } catch (err) { next(err) }
})

router.post('/designs/:id/export', async (req, res, next) => {
  try {
    const canvaService = require('../services/canvaService')
    const { format } = req.body
    if (!format) return res.status(400).json({ error: 'format is required' })
    const job = await canvaService.exportDesign({ designId: req.params.id, format })
    const result = await canvaService.pollExport(job?.job?.id || job?.id)
    res.json(result)
  } catch (err) { next(err) }
})

// ── Assets ──

router.post('/assets/upload-from-url', async (req, res, next) => {
  try {
    const canvaService = require('../services/canvaService')
    const { name, url } = req.body
    if (!name || !url) return res.status(400).json({ error: 'name and url are required' })
    const job = await canvaService.uploadAssetFromUrl({ name, url })
    const result = await canvaService.pollAssetUpload(job?.job?.id || job?.id)
    res.json(result)
  } catch (err) { next(err) }
})

// ── Brand Templates ──

router.get('/brand-templates', async (req, res, next) => {
  try {
    const canvaService = require('../services/canvaService')
    res.json(await canvaService.listBrandTemplates({ continuation: req.query.continuation }))
  } catch (err) { next(err) }
})

router.post('/brand-templates/:id/autofill', async (req, res, next) => {
  try {
    const canvaService = require('../services/canvaService')
    const { title, data } = req.body
    const job = await canvaService.autofillBrandTemplate({ templateId: req.params.id, title, data })
    const result = await canvaService.pollAutofill(job?.job?.id || job?.id)
    res.json(result)
  } catch (err) { next(err) }
})

// ── User ──

router.get('/users/me', async (_req, res, next) => {
  try {
    const canvaService = require('../services/canvaService')
    res.json(await canvaService.getCurrentUser())
  } catch (err) { next(err) }
})

// ── Disconnect ──

router.post('/disconnect', async (_req, res, next) => {
  try {
    await db`DELETE FROM canva_tokens`
    res.json({ disconnected: true })
  } catch (err) { next(err) }
})

module.exports = router
module.exports.publicRouter = publicRouter
