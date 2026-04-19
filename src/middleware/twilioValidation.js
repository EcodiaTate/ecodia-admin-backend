/**
 * Twilio Request Signature Validation Middleware
 *
 * Validates that incoming webhook requests genuinely originate from Twilio
 * by checking the X-Twilio-Signature header against the request body.
 *
 * Requires TWILIO_AUTH_TOKEN env var. If not set, logs a warning and
 * allows requests through (dev/local mode).
 */
const twilio = require('twilio')

const authToken = process.env.TWILIO_AUTH_TOKEN
const baseUrl = (process.env.API_BASE_URL || 'https://api.admin.ecodia.au').replace(/\/$/, '')
// Opt-in escape hatch for local dev: set ALLOW_UNSIGNED_TWILIO_WEBHOOKS=true
// to accept unsigned POSTs. In prod this must be unset, and absence of
// TWILIO_AUTH_TOKEN blocks the webhook entirely.
const allowUnsigned = process.env.ALLOW_UNSIGNED_TWILIO_WEBHOOKS === 'true'

if (!authToken) {
  if (allowUnsigned) {
    console.warn('[Twilio] TWILIO_AUTH_TOKEN not set — signature validation DISABLED (ALLOW_UNSIGNED_TWILIO_WEBHOOKS=true)')
  } else {
    console.error('[Twilio] TWILIO_AUTH_TOKEN not set and ALLOW_UNSIGNED_TWILIO_WEBHOOKS is not "true" — inbound webhooks will be REJECTED with 403')
  }
}

function validateTwilioSignature(req, res, next) {
  if (!authToken) {
    if (allowUnsigned) return next()
    // Hard fail: no token, no explicit opt-in. Don't secretly let unsigned
    // requests wake the OS — that's a free-turn attack vector.
    console.error('[Twilio] Rejecting webhook: TWILIO_AUTH_TOKEN not configured', { url: req.originalUrl, ip: req.ip })
    return res.status(403).type('text/xml').send('<?xml version="1.0" encoding="UTF-8"?><Response></Response>')
  }

  const signature = req.headers['x-twilio-signature']
  if (!signature) {
    console.warn('[Twilio] Missing X-Twilio-Signature header', { url: req.originalUrl, ip: req.ip })
    return res.status(403).type('text/xml').send('<?xml version="1.0" encoding="UTF-8"?><Response></Response>')
  }

  const url = baseUrl + req.originalUrl
  const params = req.body || {}

  const isValid = twilio.validateRequest(authToken, signature, url, params)
  if (!isValid) {
    console.warn('[Twilio] Invalid signature', { url: req.originalUrl, ip: req.ip })
    return res.status(403).type('text/xml').send('<?xml version="1.0" encoding="UTF-8"?><Response></Response>')
  }

  next()
}

module.exports = validateTwilioSignature
