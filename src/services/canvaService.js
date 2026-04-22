const axios = require('axios')
const db = require('../config/db')
const env = require('../config/env')
const logger = require('../config/logger')
const { encrypt, decrypt } = require('../utils/encryption')

const CANVA_TOKEN_URL = 'https://api.canva.com/rest/v1/oauth/token'
const CANVA_API_BASE = 'https://api.canva.com/rest/v1'
const POLL_INTERVAL_MS = 2000
const POLL_TIMEOUT_MS = 60000

function basicAuth() {
  return Buffer.from(`${env.CANVA_CLIENT_ID}:${env.CANVA_CLIENT_SECRET}`).toString('base64')
}

async function tokenRequest(params) {
  const response = await axios.post(
    CANVA_TOKEN_URL,
    new URLSearchParams(params),
    {
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Authorization': `Basic ${basicAuth()}`,
      },
    }
  )
  return response.data
}

// Refresh token in a transaction to handle Canva's single-use refresh tokens.
// A concurrent caller would block on the FOR UPDATE lock and receive stale data
// after the first caller commits the new token pair.
async function refreshAccessToken(currentRefreshToken) {
  return db.begin(async sql => {
    // Lock the row so concurrent refreshes don't race and burn the single-use token
    const [locked] = await sql`SELECT id FROM canva_tokens LIMIT 1 FOR UPDATE`
    if (!locked) throw new Error('No Canva tokens row to refresh')

    const data = await tokenRequest({
      grant_type: 'refresh_token',
      refresh_token: currentRefreshToken,
    })

    await sql`
      UPDATE canva_tokens SET
        access_token  = ${encrypt(data.access_token)},
        refresh_token = ${encrypt(data.refresh_token)},
        expires_at    = ${new Date(Date.now() + data.expires_in * 1000)},
        updated_at    = NOW()
      WHERE id = ${locked.id}
    `

    return data.access_token
  })
}

async function getValidAccessToken() {
  const [token] = await db`SELECT * FROM canva_tokens LIMIT 1`
  if (!token) throw new Error('No Canva tokens found - run OAuth flow first')

  if (new Date(token.expires_at) < new Date(Date.now() + 60_000)) {
    return refreshAccessToken(decrypt(token.refresh_token))
  }

  return decrypt(token.access_token)
}

async function exchangeCode(code, codeVerifier) {
  const data = await tokenRequest({
    grant_type: 'authorization_code',
    code,
    redirect_uri: env.CANVA_REDIRECT_URI,
    code_verifier: codeVerifier,
  })

  await db`DELETE FROM canva_tokens`
  await db`
    INSERT INTO canva_tokens (access_token, refresh_token, expires_at, scope)
    VALUES (
      ${encrypt(data.access_token)},
      ${encrypt(data.refresh_token)},
      ${new Date(Date.now() + data.expires_in * 1000)},
      ${data.scope || null}
    )
  `

  // Fire-and-forget: populate user info
  getCurrentUser()
    .then(async user => {
      if (user?.id || user?.email) {
        await db`
          UPDATE canva_tokens SET
            canva_user_id    = ${user.id || null},
            canva_user_email = ${user.email || null}
          WHERE id = (SELECT id FROM canva_tokens LIMIT 1)
        `
      }
    })
    .catch(() => {})

  logger.info('Canva OAuth tokens stored successfully')
}

async function getStatus() {
  if (!env.CANVA_CLIENT_ID) return { connected: false, reason: 'credentials not configured' }

  const [token] = await db`
    SELECT expires_at, canva_user_id, canva_user_email, scope FROM canva_tokens LIMIT 1
  `
  if (!token) return { connected: false }

  return {
    connected: true,
    expires_at: token.expires_at,
    canva_user_id: token.canva_user_id,
    canva_user_email: token.canva_user_email,
    scope: token.scope,
  }
}

// ── API wrappers ──

async function apiGet(path, params = {}) {
  const token = await getValidAccessToken()
  const url = new URL(`${CANVA_API_BASE}${path}`)
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null) url.searchParams.set(k, v)
  }
  const response = await axios.get(url.toString(), {
    headers: { Authorization: `Bearer ${token}` },
  })
  return response.data
}

async function apiPost(path, body = {}) {
  const token = await getValidAccessToken()
  const response = await axios.post(`${CANVA_API_BASE}${path}`, body, {
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
  })
  return response.data
}

async function apiDelete(path) {
  const token = await getValidAccessToken()
  const response = await axios.delete(`${CANVA_API_BASE}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  })
  return response.data
}

async function apiPostForm(path, form = {}) {
  const token = await getValidAccessToken()
  const response = await axios.post(
    `${CANVA_API_BASE}${path}`,
    new URLSearchParams(form),
    {
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
    }
  )
  return response.data
}

// ── Polling helpers ──

async function pollJob(getJob, { interval = POLL_INTERVAL_MS, timeout = POLL_TIMEOUT_MS } = {}) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    const result = await getJob()
    const status = result?.job?.status || result?.status
    if (status === 'success') return result
    if (status === 'failed') throw new Error(`Job failed: ${JSON.stringify(result)}`)
    await new Promise(r => setTimeout(r, interval))
  }
  throw new Error('Job timed out after 60s')
}

// ── Higher-level helpers ──

async function listDesigns({ query, continuation, ownership, sort_by } = {}) {
  return apiGet('/designs', { query, continuation, ownership, sort_by })
}

async function getDesign(designId) {
  return apiGet(`/designs/${designId}`)
}

async function createDesignFromTemplate({ templateId, title } = {}) {
  const body = { design_type: { type: 'preset', name: 'presentation' } }
  if (title) body.title = title
  // Use template_id as query param if provided - Canva supports both approaches
  const path = templateId ? `/designs?template_id=${encodeURIComponent(templateId)}` : '/designs'
  return apiPost(path, body)
}

async function exportDesign({ designId, format }) {
  return apiPost('/exports', {
    design_id: designId,
    format: { type: format },
  })
}

async function pollExport(jobId) {
  return pollJob(() => apiGet(`/exports/${jobId}`))
}

async function uploadAssetFromUrl({ name, url }) {
  const name_base64 = Buffer.from(name).toString('base64')
  return apiPost('/asset-uploads', { url, name_base64 })
}

async function pollAssetUpload(jobId) {
  return pollJob(() => apiGet(`/asset-uploads/${jobId}`))
}

async function listBrandTemplates({ continuation } = {}) {
  return apiGet('/brand-templates', { continuation })
}

async function getBrandTemplateDataset(templateId) {
  return apiGet(`/brand-templates/${templateId}/dataset`)
}

async function autofillBrandTemplate({ templateId, title, data }) {
  return apiPost('/autofills', {
    brand_template_id: templateId,
    title,
    data,
  })
}

async function pollAutofill(jobId) {
  return pollJob(() => apiGet(`/autofills/${jobId}`))
}

async function getCurrentUser() {
  return apiGet('/users/me')
}

async function listFolders({ continuation } = {}) {
  return apiGet('/folders', { continuation })
}

module.exports = {
  getValidAccessToken,
  exchangeCode,
  refreshAccessToken,
  getStatus,
  apiGet,
  apiPost,
  apiDelete,
  apiPostForm,
  listDesigns,
  getDesign,
  createDesignFromTemplate,
  exportDesign,
  pollExport,
  uploadAssetFromUrl,
  pollAssetUpload,
  listBrandTemplates,
  getBrandTemplateDataset,
  autofillBrandTemplate,
  pollAutofill,
  getCurrentUser,
  listFolders,
}
