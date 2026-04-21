'use strict'
/**
 * App Store Connect API client.
 *
 * Covers: JWT auth, version creation, build attachment, review submission,
 * and the shipLatest() convenience wrapper for the iOS shipping pipeline.
 *
 * Credentials live in kv_store under key 'creds.apple.asc_api' as a JSON
 * object: { issuer_id, key_id, private_key }. Module warns on startup if
 * creds are absent but does NOT crash - calls will throw at invocation time.
 */

const jwt = require('jsonwebtoken')
// axios is required lazily inside each HTTP call so tests can replace the
// require cache entry without a top-level binding capturing the original.
const db = require('../config/db')
const logger = require('../config/logger')

const ASC_BASE = 'https://api.appstoreconnect.apple.com/v1'
const TOKEN_TTL_SECS = 20 * 60 // 20 minutes per Apple spec
const TOKEN_REFRESH_THRESHOLD_SECS = 2 * 60 // regenerate if less than 2 min left

// In-module token cache
let _cachedToken = null
let _tokenExpiresAt = 0 // unix seconds

// ─── Credentials ────────────────────────────────────────────────────

async function _loadCreds() {
  const [row] = await db`SELECT value FROM kv_store WHERE key = 'creds.apple.asc_api'`
  if (!row) {
    throw new Error(
      'ASC credentials not configured: add {issuer_id, key_id, private_key} to kv_store key creds.apple.asc_api'
    )
  }
  // postgres returns JSONB columns as JS objects; handle string fallback
  const creds = typeof row.value === 'string' ? JSON.parse(row.value) : row.value
  const { issuer_id, key_id, private_key } = creds || {}
  if (!issuer_id || !key_id || !private_key) {
    throw new Error('ASC credentials incomplete: need issuer_id, key_id, and private_key')
  }
  return { issuer_id, key_id, private_key }
}

// Warn on module load if creds are missing - never crash at require-time
let _startupWarnDone = false
;(async () => {
  try {
    await _loadCreds()
  } catch (err) {
    if (!_startupWarnDone) {
      _startupWarnDone = true
      logger.warn('appStoreConnect: ASC credentials not yet configured - calls will fail until set', {
        hint: 'store {issuer_id,key_id,private_key} in kv_store at creds.apple.asc_api',
      })
    }
  }
})()

// ─── Token ──────────────────────────────────────────────────────────

/**
 * Returns a fresh ES256 JWT for the ASC API.
 * Caches the token and regenerates only when less than 2 minutes remain.
 */
async function getToken() {
  const nowSecs = Math.floor(Date.now() / 1000)
  if (_cachedToken && (_tokenExpiresAt - nowSecs) > TOKEN_REFRESH_THRESHOLD_SECS) {
    return _cachedToken
  }

  const { issuer_id, key_id, private_key } = await _loadCreds()

  const token = jwt.sign(
    {
      iss: issuer_id,
      iat: nowSecs,
      exp: nowSecs + TOKEN_TTL_SECS,
      aud: 'appstoreconnect-v1',
    },
    private_key,
    { algorithm: 'ES256', header: { alg: 'ES256', kid: key_id, typ: 'JWT' } }
  )

  _cachedToken = token
  _tokenExpiresAt = nowSecs + TOKEN_TTL_SECS
  logger.debug('appStoreConnect: generated new JWT', {
    key_id,
    expires_at: new Date(_tokenExpiresAt * 1000).toISOString(),
  })
  return token
}

// ─── HTTP layer ──────────────────────────────────────────────────────

/**
 * Thin axios wrapper. Attaches Bearer token, returns parsed body.
 * Throws with .status and .responseData attached on non-2xx.
 */
async function request(method, path, opts = {}) {
  const token = await getToken()
  const url = `${ASC_BASE}${path}`
  const _axios = require('axios')
  try {
    const res = await _axios({
      method,
      url,
      ...opts,
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        ...(opts.headers || {}),
      },
    })
    return res.data
  } catch (err) {
    if (err.response) {
      const msg = `ASC API ${method.toUpperCase()} ${path} => ${err.response.status}: ${JSON.stringify(err.response.data).slice(0, 400)}`
      const wrapped = new Error(msg)
      wrapped.status = err.response.status
      wrapped.responseData = err.response.data
      throw wrapped
    }
    throw err
  }
}

// ─── Apps ────────────────────────────────────────────────────────────

/**
 * Returns the first matching app data object, or null if not found.
 */
async function findApp(bundleId) {
  const data = await request('GET', `/apps?filter[bundleId]=${encodeURIComponent(bundleId)}`)
  return (data.data && data.data.length > 0) ? data.data[0] : null
}

// ─── Builds ──────────────────────────────────────────────────────────

/**
 * Returns an array of builds for the given appId, sorted by uploadedDate desc.
 */
async function listBuilds(appId, { limit = 20 } = {}) {
  const data = await request('GET', `/builds?filter[app]=${appId}&sort=-uploadedDate&limit=${limit}`)
  return data.data || []
}

/**
 * Returns the full build data object for a given buildId.
 */
async function getBuild(buildId) {
  const data = await request('GET', `/builds/${buildId}`)
  return data.data
}

/**
 * Polls until processingState becomes VALID. Throws on FAILED/INVALID or timeout.
 */
async function waitForBuildProcessing(buildId, { timeoutMs = 30 * 60 * 1000, pollMs = 30 * 1000 } = {}) {
  const deadline = Date.now() + timeoutMs
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const build = await getBuild(buildId)
    const state = build?.attributes?.processingState
    logger.debug(`appStoreConnect: build ${buildId} processingState=${state}`)
    if (state === 'VALID') return build
    if (state === 'FAILED' || state === 'INVALID') {
      throw new Error(`Build ${buildId} processing ended with state: ${state}`)
    }
    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for build ${buildId} to complete processing (timeout: ${timeoutMs}ms)`)
    }
    await new Promise(r => setTimeout(r, pollMs))
  }
}

// ─── Versions ────────────────────────────────────────────────────────

/**
 * Creates an App Store Version. On 409 (already exists), fetches and returns
 * the existing version rather than throwing.
 */
async function createAppStoreVersion(appId, { versionString, platform = 'IOS', copyright, releaseType = 'MANUAL' }) {
  const body = {
    data: {
      type: 'appStoreVersions',
      attributes: {
        platform,
        versionString,
        releaseType,
        ...(copyright ? { copyright } : {}),
      },
      relationships: {
        app: { data: { type: 'apps', id: appId } },
      },
    },
  }
  try {
    const data = await request('POST', '/appStoreVersions', { data: body })
    return data.data
  } catch (err) {
    if (err.status === 409) {
      logger.info(`appStoreConnect: version ${versionString} already exists for app ${appId}, fetching existing`)
      const existing = await request(
        'GET',
        `/appStoreVersions?filter[app]=${appId}&filter[versionString]=${encodeURIComponent(versionString)}&filter[platform]=${platform}`
      )
      if (existing.data && existing.data.length > 0) return existing.data[0]
      throw new Error(`Version ${versionString} conflict but could not fetch existing version for app ${appId}`)
    }
    throw err
  }
}

/**
 * Attaches a build to an App Store Version via the relationships endpoint.
 * Returns 204 on success; throws on any non-2xx.
 */
async function attachBuildToVersion(versionId, buildId) {
  const token = await getToken()
  const url = `${ASC_BASE}/appStoreVersions/${versionId}/relationships/build`
  const _axios = require('axios')
  try {
    await _axios({
      method: 'PATCH',
      url,
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      data: { data: { type: 'builds', id: buildId } },
    })
    logger.info(`appStoreConnect: attached build ${buildId} to version ${versionId}`)
  } catch (err) {
    if (err.response) {
      const msg = `ASC API PATCH /appStoreVersions/${versionId}/relationships/build => ${err.response.status}: ${JSON.stringify(err.response.data).slice(0, 400)}`
      const wrapped = new Error(msg)
      wrapped.status = err.response.status
      wrapped.responseData = err.response.data
      throw wrapped
    }
    throw err
  }
}

// ─── Review submission ───────────────────────────────────────────────

/**
 * Submits an App Store Version for review using the 2026 ASC API flow:
 * create reviewSubmission -> add version item -> submit.
 * Returns { submissionId }.
 */
async function submitForReview(versionId) {
  // Resolve appId from the version record
  const versionData = await request('GET', `/appStoreVersions/${versionId}`)
  const appId = versionData.data?.relationships?.app?.data?.id
  if (!appId) throw new Error(`Could not resolve appId from versionId ${versionId}`)

  // Step 1: create the review submission envelope
  const submission = await request('POST', '/reviewSubmissions', {
    data: {
      data: {
        type: 'reviewSubmissions',
        attributes: { platform: 'IOS' },
        relationships: { app: { data: { type: 'apps', id: appId } } },
      },
    },
  })
  const submissionId = submission.data?.id
  if (!submissionId) throw new Error('Failed to create reviewSubmission: no id returned')
  logger.info(`appStoreConnect: created review submission ${submissionId}`)

  // Step 2: add the version as a reviewSubmissionItem
  await request('POST', '/reviewSubmissionItems', {
    data: {
      data: {
        type: 'reviewSubmissionItems',
        attributes: {},
        relationships: {
          reviewSubmission: { data: { type: 'reviewSubmissions', id: submissionId } },
          appStoreVersion: { data: { type: 'appStoreVersions', id: versionId } },
        },
      },
    },
  })
  logger.info(`appStoreConnect: added version ${versionId} to submission ${submissionId}`)

  // Step 3: submit
  await request('PATCH', `/reviewSubmissions/${submissionId}`, {
    data: {
      data: {
        type: 'reviewSubmissions',
        id: submissionId,
        attributes: { submitted: true },
      },
    },
  })
  logger.info(`appStoreConnect: submitted review submission ${submissionId}`)

  return { submissionId }
}

// ─── Convenience ─────────────────────────────────────────────────────

/**
 * End-to-end ship: find latest PROCESSING/VALID build, wait for processing,
 * create/find the App Store Version, attach the build, and submit for review.
 * Returns { buildId, versionId, submissionId, state }.
 */
async function shipLatest(appId, { versionString }) {
  const builds = await listBuilds(appId, { limit: 10 })
  const candidate = builds.find(b =>
    ['PROCESSING', 'VALID'].includes(b.attributes?.processingState)
  )
  if (!candidate) {
    throw new Error(`No PROCESSING or VALID builds found for app ${appId}`)
  }
  const buildId = candidate.id
  logger.info(`appStoreConnect: shipLatest using build ${buildId} (state=${candidate.attributes?.processingState})`)

  const finalBuild = await waitForBuildProcessing(buildId)
  logger.debug(`appStoreConnect: build ${finalBuild.id} is now VALID, proceeding to version`)

  const version = await createAppStoreVersion(appId, { versionString })
  const versionId = version.id

  await attachBuildToVersion(versionId, buildId)

  const { submissionId } = await submitForReview(versionId)

  return { buildId, versionId, submissionId, state: 'submitted' }
}

module.exports = {
  getToken,
  request,
  findApp,
  listBuilds,
  getBuild,
  waitForBuildProcessing,
  createAppStoreVersion,
  attachBuildToVersion,
  submitForReview,
  shipLatest,
}
