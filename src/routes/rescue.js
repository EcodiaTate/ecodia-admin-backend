/**
 * Rescue routes — /api/rescue/*
 *
 * Served by ecodia-api. All actions proxy to the ecodia-rescue process
 * via Redis.
 */
const express = require('express')
const router = express.Router()
const rescue = require('../services/rescueService')
const logger = require('../config/logger')

// Send a plain message to rescue. Response returns immediately; output
// streams over WS as rescue:output events.
router.post('/message', async (req, res, next) => {
  try {
    const { message } = req.body || {}
    if (!message || typeof message !== 'string') {
      return res.status(400).json({ error: 'message is required' })
    }
    const result = await rescue.sendMessage(message)
    res.json({ accepted: true, ...result })
  } catch (err) {
    logger.error('Rescue /message: error', { error: err.message })
    next(err)
  }
})

// Invoke with auto-generated crisis brief prepended. Use when the OS is
// actually wedged and you want rescue to start with full context.
router.post('/invoke', async (req, res, next) => {
  try {
    const { reason = 'manual_invocation', extraContext = null, instruction = null } = req.body || {}

    // Compose the brief server-side (from api process, which knows the DB).
    const { composeBrief } = require('../rescue/crisisBrief')
    const db = require('../config/db')
    let brief
    try {
      brief = await composeBrief({ db, reason, extraContext })
    } catch (err) {
      logger.warn('Rescue /invoke: brief compose failed, sending lean brief', { error: err.message })
      brief = `# CRISIS BRIEF (compose failed: ${err.message})\nTriggered: ${reason}\nExtraContext: ${extraContext || '(none)'}\n`
    }

    const extraInstruction = instruction
      ? `\n\nTate's instruction for this invocation: ${instruction}`
      : `\n\nTate's instruction: diagnose and fix main (ecodia-api) if it's broken, or report what you find if it's actually fine.`

    await rescue.sendMessage(brief + extraInstruction)
    res.json({ accepted: true, briefBytes: brief.length })
  } catch (err) {
    logger.error('Rescue /invoke: error', { error: err.message })
    next(err)
  }
})

router.get('/status', async (_req, res, next) => {
  try {
    // Use the probing version so the first load after an api restart
    // doesn't return ready:false for the whole lifetime of the process.
    const status = await rescue.getStatusWithProbe()
    res.json(status)
  } catch (err) { next(err) }
})

router.get('/health', async (_req, res, next) => {
  try {
    const result = await rescue.healthCheck()
    res.json(result)
  } catch (err) { next(err) }
})

router.get('/transcript', async (req, res, next) => {
  try {
    const limit = parseInt(req.query.limit || '100', 10)
    res.json({ transcript: rescue.getTranscript(limit) })
  } catch (err) { next(err) }
})

router.post('/abort', async (req, res, next) => {
  try {
    const reason = (req.body && req.body.reason) || 'user_abort'
    const result = await rescue.abort(reason)
    res.json(result)
  } catch (err) { next(err) }
})

// Reset — drop the current cc session so next message starts fresh.
// Also clears the api-side transcript.
router.post('/reset', async (_req, res, next) => {
  try {
    const result = await rescue.resetSession()
    res.json(result)
  } catch (err) { next(err) }
})

router.get('/brief', async (req, res, next) => {
  try {
    const { composeBrief } = require('../rescue/crisisBrief')
    const db = require('../config/db')
    const brief = await composeBrief({
      db,
      reason: req.query.reason || 'preview',
      extraContext: req.query.extraContext || null,
    })
    res.type('text/plain').send(brief)
  } catch (err) {
    logger.error('Rescue /brief: error', { error: err.message })
    next(err)
  }
})

module.exports = router
