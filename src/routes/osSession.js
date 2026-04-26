/**
 * OS Session Routes — /api/os-session/*
 * Interface between frontend and the persistent CC OS session.
 */
const express = require('express')
const router = express.Router()
const env = require('../config/env')
const logger = require('../config/logger')
const osSession = require('../services/osSessionService')
const { getEventsSince, getSessionEpoch } = require('../websocket/wsManager')
const usageEnergy = require('../services/usageEnergyService')
const { saveHandoffState } = require('../services/sessionHandoff')
const { stampTateActive } = require('../services/tateActiveGate')

// Send a message to the OS session.
// Response streams in real-time via WebSocket (text_delta, tool_use, os-session:complete).
// The HTTP response returns IMMEDIATELY with { accepted: true } — it does NOT block
// for the entire agentic loop. This prevents:
//   1. Frontend hanging for 5-30 minutes on a single await
//   2. User unable to send follow-up messages while previous is processing
//   3. "Connection error: Network Error" when HTTP times out on long sessions
// The frontend relies on WebSocket for the actual conversation flow.
//
// Optional field: mode
//   "direct" (default) — send immediately, draining any pending queued messages first
//   "queue"            — hold until os_signal_handoff fires or max_age_hours elapses
router.post('/message', async (req, res, next) => {
  try {
    const { message, mode, source } = req.body
    if (!message || typeof message !== 'string') {
      return res.status(400).json({ error: 'message is required' })
    }

    // queue mode: hold the message, don't wake the OS
    if (mode === 'queue') {
      const mq = require('../services/messageQueue')
      const row = await mq.enqueueMessage({
        body: message,
        source: source || 'tate',
        mode: 'queue',
      })
      return res.status(202).json({ queued_id: row.id, queued_at: row.queued_at })
    }

    if (mode && mode !== 'direct') {
      return res.status(400).json({ error: 'mode must be "direct" or "queue"' })
    }

    // Stamp Tate as active before queuing — crons stand down for 15 minutes.
    // Fire-and-forget: never block the response if this errors.
    // DO NOT stamp when the message originated from our own scheduler (prevents
    // self-perpetuating defer loop - see Q1 resolution Apr 25 2026).
    if (source !== 'scheduler') {
      stampTateActive().catch(err => {
        logger.warn('OS Session /message: stampTateActive failed', { error: err.message })
      })
    }

    // Drain any pending queued messages into this direct send (opportunistic delivery).
    // Runs before returning so DB marks are atomic with the outgoing send.
    let finalMessage = message
    try {
      const mq = require('../services/messageQueue')
      finalMessage = await mq.drainIntoDirectMessage(message)
    } catch (err) {
      logger.warn('OS Session /message: drain error', { error: err.message })
    }

    // Return immediately — the real response streams via WebSocket
    res.json({ accepted: true, status: 'streaming' })

    // Process in background — errors are broadcast via WS, not HTTP.
    // priority: false (default) means user messages QUEUE behind any active
    // tool-call loop and fire after it completes (via _sendQueue chain in
    // osSessionService.js). This preserves mid-turn flow - Tate's check-in
    // messages won't kill an in-progress audit, deploy, or Factory dispatch.
    // Explicit kill switch is the frontend Stop button -> POST /api/os-session/abort.
    // Never flip priority:true here without explicit Tate sign-off - it was
    // the cause of mid-turn session breaks where check-in messages aborted
    // long-running tool streams (logged as "Background error: write CONNECTION_ENDED").
    osSession.sendMessage(finalMessage, { priority: false }).catch(err => {
      logger.error('OS Session /message: background sendMessage failed', { error: err.message, stack: err.stack })
    })
  } catch (err) {
    logger.error('OS Session /message: request handler error', { error: err.message })
    next(err)
  }
})

// Get current session status
router.get('/status', async (_req, res, next) => {
  try {
    const status = await osSession.getStatus()
    res.json(status)
  } catch (err) { next(err) }
})

// Restart the OS session (fresh conversation)
router.post('/restart', async (_req, res, next) => {
  try {
    const result = await osSession.restart()
    res.json(result)
  } catch (err) { next(err) }
})

// Get session history (recent logs)
router.get('/history', async (req, res, next) => {
  try {
    const limit = parseInt(req.query.limit || '100', 10)
    const history = await osSession.getHistory(limit)
    res.json({ history })
  } catch (err) { next(err) }
})

// Get current token usage
router.get('/tokens', (_req, res) => {
  const usage = osSession.getTokenUsage()
  res.json(usage)
})

// Recover missed response after tab close / disconnect.
// Accepts either:
//   ?since_seq=N  — Pinnacle P1: return events from in-memory ring buffer with seq > N
//   ?since=<ts>   — legacy: return transcript from DB since timestamp
router.get('/recover', async (req, res, next) => {
  try {
    // Pinnacle P1: seq-based recovery from ring buffer (preferred).
    // Stamp the current epoch so clients can detect a process restart /
    // new session and clear their lastSeenSeq when the epoch changes.
    if (req.query.since_seq != null) {
      const sinceSeq = parseInt(req.query.since_seq, 10)
      const events = getEventsSince(Number.isFinite(sinceSeq) ? sinceSeq : null)
      return res.json({
        events,
        count: events.length,
        seq_based: true,
        epoch: getSessionEpoch(),
      })
    }
    // Legacy timestamp-based recovery
    const since = req.query.since || null
    const result = await osSession.recoverResponse(since)
    res.json(result)
  } catch (err) { next(err) }
})

// Compact — seamlessly transition to a new session with summary context
router.post('/compact', async (req, res, next) => {
  res.setTimeout(1_800_000) // 30 min
  try {
    const { summary } = req.body
    if (!summary || typeof summary !== 'string') {
      return res.status(400).json({ error: 'summary is required' })
    }
    const result = await osSession.compact(summary)
    res.json(result)
  } catch (err) {
    logger.error('OS Session /compact: error', { error: err.message })
    next(err)
  }
})

// Manual handover trigger — generate brief + warm new session now
router.post('/handover', async (_req, res, next) => {
  res.setTimeout(1_800_000) // 30 min
  try {
    const result = await osSession.autoHandover(null)
    res.json(result || { ok: true })
  } catch (err) {
    logger.error('OS Session /handover: error', { error: err.message })
    next(err)
  }
})

// Get weekly energy snapshot — real % from Anthropic response headers
router.get('/energy', async (_req, res, next) => {
  try {
    const energy = await usageEnergy.getEnergy()
    res.json(energy)
  } catch (err) { next(err) }
})

// Force a live quota-check for both accounts (fires 1-token API calls to read real headers)
router.post('/energy/refresh', async (_req, res, next) => {
  try {
    await usageEnergy.refreshAllAccounts()
    const energy = await usageEnergy.getEnergy()
    res.json(energy)
  } catch (err) { next(err) }
})

// Get historical weekly usage (self-tracked turns for activity log)
router.get('/energy/history', async (req, res, next) => {
  try {
    const weeks = parseInt(req.query.weeks || '4', 10)
    const history = await usageEnergy.getWeeklyHistory(weeks)
    res.json({ history })
  } catch (err) { next(err) }
})

// Upload an attachment to Supabase Storage and return a public URL.
// Accepts either base64-encoded file data OR raw text content — no multipart needed.
router.post('/upload', async (req, res, next) => {
  try {
    const { name, type, base64, text } = req.body
    if (!name || (!base64 && typeof text !== 'string')) {
      return res.status(400).json({ error: 'name and (base64 or text) are required' })
    }

    if (!env.SUPABASE_URL || !(env.SUPABASE_SERVICE_KEY || env.SUPABASE_ANON_KEY)) {
      return res.status(503).json({ error: 'Supabase not configured' })
    }

    const { createClient } = require('@supabase/supabase-js')
    const sb = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_KEY || env.SUPABASE_ANON_KEY)

    // Decode payload — text files come through as raw UTF-8, binaries as base64
    let buffer
    if (typeof text === 'string') {
      buffer = Buffer.from(text, 'utf-8')
    } else {
      const raw = base64.includes(',') ? base64.split(',')[1] : base64
      buffer = Buffer.from(raw, 'base64')
    }

    const ext = name.split('.').pop() || 'bin'
    const slug = `attachments/${Date.now()}-${name.replace(/[^a-zA-Z0-9._-]/g, '_')}`
    const contentType = type || (typeof text === 'string' ? 'text/plain' : 'application/octet-stream')

    await sb.storage.createBucket('os-attachments', { public: true }).catch(() => {})
    const { error } = await sb.storage.from('os-attachments').upload(slug, buffer, { contentType, upsert: true })
    if (error) {
      logger.error('OS Upload: Supabase storage error', { error: error.message, name })
      return res.status(500).json({ error: error.message })
    }

    const { data } = sb.storage.from('os-attachments').getPublicUrl(slug)
    res.json({ url: data.publicUrl, name, type: contentType, size: buffer.length })
  } catch (err) { next(err) }
})

// Abort — kill the active query immediately so the user can send a new message
router.post('/abort', async (_req, res, next) => {
  try {
    const result = await osSession.abort()
    res.json(result)
  } catch (err) {
    logger.error('OS Session /abort: error', { error: err.message })
    next(err)
  }
})

// Save session handoff state for restart recovery
router.post('/save-state', async (req, res, next) => {
  try {
    const { current_work, active_plan, tate_last_direction, deliverables_status } = req.body
    const state = await saveHandoffState({ current_work, active_plan, tate_last_direction, deliverables_status })
    res.json({ ok: true, saved_at: state.saved_at })
  } catch (err) {
    logger.error('OS Session /save-state: error', { error: err.message })
    next(err)
  }
})

module.exports = router
