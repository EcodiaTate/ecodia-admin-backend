/**
 * Pending Questions — /api/pending-questions/*
 *
 * Fork-callable Tate-question pause primitive. Forks insert a question
 * row and poll for the answer; meanwhile a chat injection notifies the
 * conductor (and via the conductor, Tate).
 *
 * Endpoints:
 *   POST /api/pending-questions             body { fork_id, question, options?, deliver_via?, context? }
 *     -> { id, surfaced_at }
 *   GET  /api/pending-questions/:id          -> row (answered/pending)
 *   POST /api/pending-questions/:id/answer  body { answer }
 *     -> { id, answered_at, answer }
 *   GET  /api/pending-questions             ?unanswered=true  -> rows
 *
 * Vision-first macro doctrine prerequisite. Shipped 29 Apr 2026
 * (fork_mojs0mm2_79180b).
 */
const express = require('express')
const router = express.Router()
const db = require('../config/db')
const logger = require('../config/logger')

// Surface a question. Inserts the row, then fires a "Tate question
// pending" line into the conductor chat stream so the conductor can
// see it and route it appropriately.
router.post('/', async (req, res) => {
  try {
    const { fork_id, question, options, deliver_via, context, expires_in_seconds } = req.body || {}
    if (!question || typeof question !== 'string') return res.status(400).json({ error: 'question (string) required' })

    const expiresAt = expires_in_seconds
      ? new Date(Date.now() + Math.min(Math.max(60, expires_in_seconds), 3600) * 1000)
      : new Date(Date.now() + 600 * 1000) // default 10 min

    const [row] = await db`
      INSERT INTO pending_questions (fork_id, question, options, deliver_via, context, expires_at)
      VALUES (
        ${fork_id || null},
        ${question},
        ${options ? JSON.stringify(options) : null}::jsonb,
        ${deliver_via || 'chat'},
        ${context ? JSON.stringify(context) : null}::jsonb,
        ${expiresAt}
      )
      RETURNING id, surfaced_at, fork_id, question, options, deliver_via, expires_at
    `

    // Fire-and-forget chat injection. Never block the surface call on
    // notification success - the row is the source of truth, the chat
    // line is just a heads-up.
    _injectIntoConductorChat(row).catch(err => {
      logger.warn('pending-questions: chat injection failed', { id: row.id, error: err.message })
    })

    res.json({
      id: row.id,
      surfaced_at: row.surfaced_at,
      fork_id: row.fork_id,
      deliver_via: row.deliver_via,
      expires_at: row.expires_at,
    })
  } catch (err) {
    logger.error('pending-questions: surface error', { error: err.message })
    res.status(500).json({ error: err.message })
  }
})

// Poll for the answer. Forks call this every 5s up to 5min.
router.get('/:id', async (req, res) => {
  try {
    const [row] = await db`
      SELECT id, fork_id, question, options, surfaced_at, answered_at, answer, expires_at
      FROM pending_questions WHERE id = ${req.params.id}
    `
    if (!row) return res.status(404).json({ error: 'Not found' })

    const expired = row.expires_at && new Date(row.expires_at) < new Date() && !row.answered_at
    res.json({
      id: row.id,
      fork_id: row.fork_id,
      question: row.question,
      options: row.options,
      surfaced_at: row.surfaced_at,
      answered: !!row.answered_at,
      answered_at: row.answered_at,
      answer: row.answer,
      expired,
    })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// Tate (or main conductor on his behalf) answers the question.
router.post('/:id/answer', async (req, res) => {
  try {
    const { answer } = req.body || {}
    if (typeof answer !== 'string') return res.status(400).json({ error: 'answer (string) required' })

    const [row] = await db`
      UPDATE pending_questions
      SET answer = ${answer}, answered_at = NOW()
      WHERE id = ${req.params.id} AND answered_at IS NULL
      RETURNING id, fork_id, question, answer, answered_at
    `
    if (!row) return res.status(404).json({ error: 'Not found or already answered' })

    res.json({ id: row.id, fork_id: row.fork_id, answer: row.answer, answered_at: row.answered_at })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// List pending or recent answered questions.
//
// Filters:
//   ?unanswered=true   -> only rows that are not yet answered
//   ?conductor=true    -> rows whose deliver_via is 'conductor' (the
//                          recipient class introduced 29 Apr 2026 by the
//                          irrevocable-actions doctrine: macros in
//                          ambiguity surface to the conductor session,
//                          NOT to Tate's chat). Combine with unanswered=true
//                          for the conductor's polling inbox.
router.get('/', async (req, res) => {
  try {
    const unansweredOnly = String(req.query.unanswered || '').toLowerCase() === 'true'
    const conductorOnly = String(req.query.conductor || '').toLowerCase() === 'true'

    let rows
    if (conductorOnly && unansweredOnly) {
      rows = await db`SELECT id, fork_id, question, options, surfaced_at, deliver_via, expires_at, context
                      FROM pending_questions
                      WHERE answered_at IS NULL AND deliver_via = 'conductor'
                      ORDER BY surfaced_at DESC LIMIT 50`
    } else if (conductorOnly) {
      rows = await db`SELECT id, fork_id, question, options, surfaced_at, answered_at, answer, deliver_via, context
                      FROM pending_questions
                      WHERE deliver_via = 'conductor'
                      ORDER BY surfaced_at DESC LIMIT 50`
    } else if (unansweredOnly) {
      rows = await db`SELECT id, fork_id, question, options, surfaced_at, deliver_via, expires_at, context
                      FROM pending_questions WHERE answered_at IS NULL ORDER BY surfaced_at DESC LIMIT 50`
    } else {
      rows = await db`SELECT id, fork_id, question, options, surfaced_at, answered_at, answer, deliver_via, context
                      FROM pending_questions ORDER BY surfaced_at DESC LIMIT 50`
    }
    res.json({ rows })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

async function _injectIntoConductorChat(row) {
  // Hand the question to the conductor as a system-style message.
  // source='scheduler' means stampTateActive is suppressed (no false
  // "Tate is here" signal). The conductor sees the line, decides whether
  // to forward to Tate via SMS/chat per row.deliver_via, and routes
  // Tate's reply back to /:id/answer.
  const fetch = global.fetch
  const port = process.env.PORT || 3001
  const optionsBlock = row.options ? `\nOptions: ${JSON.stringify(row.options)}` : ''
  const message = [
    `[FORK QUESTION pending — id ${row.id}]`,
    row.fork_id ? `Fork: ${row.fork_id}` : null,
    `Question: ${row.question}${optionsBlock}`,
    `Answer via: POST /api/pending-questions/${row.id}/answer { "answer": "..." }`,
    `Deliver hint: ${row.deliver_via}`,
  ].filter(Boolean).join('\n')

  try {
    await fetch(`http://localhost:${port}/api/os-session/message`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message, source: 'scheduler' }),
    })
  } catch (err) {
    logger.warn('pending-questions: localhost POST failed', { error: err.message })
  }
}

module.exports = router
