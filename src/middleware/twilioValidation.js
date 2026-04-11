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

if (!authToken) {
  console.warn('[Twilio] TWILIO_AUTH_TOKEN not set - signature validation DISABLED (dev mode)')
}

function validateTwilioSignature(req, res, next) {
  if (!authToken) {
    return next()
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
