/**
 * OS Session Routes — /api/os-session/*
 * Interface between frontend and the persistent CC OS session.
 */
const express = require('express')
const router = express.Router()
const osSession = require('../services/osSessionService')
const usageEnergy = require('../services/usageEnergyService')
const { saveHandoffState } = require('../services/sessionHandoff')

// Send a message to the OS session.
// Response streams in real-time via WebSocket (text_delta, tool_use, os-session:complete).
// The HTTP response returns IMMEDIATELY with { accepted: true } — it does NOT block
// for the entire agentic loop. This prevents:
//   1. Frontend hanging for 5-30 minutes on a single await
//   2. User unable to send follow-up messages while previous is processing
//   3. "Connection error: Network Error" when HTTP times out on long sessions
// The frontend relies on WebSocket for the actual conversation flow.
router.post('/message', async (req, res, next) => {
  try {
    const { message } = req.body
    if (!message || typeof message !== 'string') {
      return res.status(400).json({ error: 'message is required' })
    }
    // Return immediately — the real response streams via WebSocket
    res.json({ accepted: true, status: 'streaming' })

    // Process in background — errors are broadcast via WS, not HTTP
    osSession.sendMessage(message).catch(err => {
      console.error('[OS Session /message] Background error:', err.message)
    })
  } catch (err) {
    console.error('[OS Session /message] Error:', err.message)
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

// Recover missed response after tab close / disconnect
router.get('/recover', async (req, res, next) => {
  try {
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
    console.error('[OS Session /compact] Error:', err.message)
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
    console.error('[OS Session /handover] Error:', err.message)
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

    const env = require('../config/env')
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
      console.error('[OS Upload] Supabase error:', error.message)
      return res.status(500).json({ error: error.message })
    }

    const { data } = sb.storage.from('os-attachments').getPublicUrl(slug)
    res.json({ url: data.publicUrl, name, type: contentType, size: buffer.length })
  } catch (err) { next(err) }
})

// Save session handoff state for restart recovery
router.post('/save-state', async (req, res, next) => {
  try {
    const { current_work, active_plan, tate_last_direction, deliverables_status } = req.body
    const state = await saveHandoffState({ current_work, active_plan, tate_last_direction, deliverables_status })
    res.json({ ok: true, saved_at: state.saved_at })
  } catch (err) {
    console.error('[OS Session /save-state] Error:', err.message)
    next(err)
  }
})

module.exports = router
