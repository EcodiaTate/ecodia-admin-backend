'use strict'

/**
 * invoicePaymentState listener
 *
 * Fires on every staged_transactions INSERT where amount_cents > 0
 * (i.e. an incoming payment, not an expense or refund).
 *
 * Queries the public.invoices table at fire-time for open invoices
 * (status NOT IN paid/void/cancelled) and matches the incoming payment
 * using two heuristics:
 *   - amount_cents matches invoice.total_cents exactly → amount match
 *   - description contains a significant token from invoice.client_name → name match
 *
 * Confidence levels:
 *   high   = amount + name both match
 *   medium = amount only
 *   low    = name only (NO insert, NO wake)
 *
 * On high or medium confidence: inserts a row into invoice_payment_matches
 * and wakes the OS session via HTTP POST so it can mark the invoice paid.
 *
 * Producer-feed note: the listener queries invoices directly rather than
 * reading a projected kv_store key. Single source of truth = public.invoices.
 * The listener only fires on staged_transactions INSERT (rare event, bank
 * imports), so the per-fire SELECT is cheap.
 *
 * TODO (overdue check): add a separate timer/channel that fires when an open
 * invoice passes its due_date without a match — not implemented here.
 *
 * Wakes the OS via HTTP POST — never imports the session service directly.
 */

const logger = require('../../config/logger')
const db = require('../../config/db')
const axios = require('axios')

const PORT = process.env.PORT || 3001

async function _wakeOsSession(message, transactionId) {
  try {
    await axios.post(`http://localhost:${PORT}/api/os-session/message`, { message }, {
      timeout: 5000,
    })
  } catch (err) {
    logger.warn('invoicePaymentState: wake POST failed', {
      error: err.message,
      transactionId,
    })
  }
}

/**
 * Returns 'high', 'medium', 'low', or null for no match.
 *
 * `invoice.total_cents` is the GST-inclusive total (matches what an Australian
 * bank line-item shows for a paid invoice).
 */
function _matchConfidence(payment, invoice) {
  const amountMatch = payment.amount_cents === invoice.total_cents

  // Tokenise client_name: take any word longer than 2 chars as a search token
  const clientWords = (invoice.client_name || '')
    .toLowerCase()
    .split(/\W+/)
    .filter(w => w.length > 2)
  const nameMatch = clientWords.length > 0 &&
    clientWords.some(w => payment.description.toLowerCase().includes(w))

  if (amountMatch && nameMatch) return 'high'
  if (amountMatch) return 'medium'
  if (nameMatch) return 'low'
  return null
}


module.exports = {
  name: 'invoicePaymentState',
  subscribesTo: ['db:event'],

  relevanceFilter: (event) => {
    const d = event && event.data
    if (!d || d.type !== 'db:event') return false
    if (d.table !== 'staged_transactions') return false
    if (d.action !== 'INSERT') return false
    if (!d.row) return false
    if (!(d.row.amount_cents > 0)) return false  // skip expenses and zero-amount rows
    return true
  },

  handle: async (event, ctx) => {
    const row = event.data.row
    const transactionId = row.id

    try {
      // Query open invoices directly from public.invoices.
      // Producer-feed = the invoice writer (Stripe webhook / bookkeeping flow);
      // we just read at fire-time so there's no projection drift.
      let invoices
      try {
        invoices = await db`
          SELECT invoice_number, client_name, total_cents
          FROM invoices
          WHERE status NOT IN ('paid', 'void', 'cancelled')
        `
      } catch (queryErr) {
        logger.warn('invoicePaymentState: open-invoices query failed, skipping', {
          error: queryErr.message,
          transactionId,
        })
        return
      }

      if (!Array.isArray(invoices) || invoices.length === 0) {
        logger.info('invoicePaymentState: no open invoices, skipping', { transactionId })
        return
      }

      const payment = {
        amount_cents: row.amount_cents,
        description: row.description || '',
      }

      // Find best match across all open invoices (first high wins, then first medium)
      let bestMatch = null
      for (const invoice of invoices) {
        const confidence = _matchConfidence(payment, invoice)
        if (!confidence || confidence === 'low') continue

        if (!bestMatch || confidence === 'high') {
          bestMatch = { invoice, confidence }
          if (confidence === 'high') break  // can't do better
        }
      }

      if (!bestMatch) return

      const { invoice, confidence } = bestMatch

      // Insert match record (idempotent on conflict)
      try {
        await db`
          INSERT INTO invoice_payment_matches
            (invoice_number, staged_transaction_id, confidence, matched_amount_cents)
          VALUES
            (${invoice.invoice_number}, ${transactionId}, ${confidence}, ${row.amount_cents})
          ON CONFLICT (invoice_number, staged_transaction_id) DO NOTHING
        `
      } catch (insertErr) {
        logger.warn('invoicePaymentState: failed to insert match row', {
          error: insertErr.message,
          transactionId,
          invoiceNumber: invoice.invoice_number,
        })
        return
      }

      logger.info('invoicePaymentState: payment match detected', {
        transactionId,
        invoiceNumber: invoice.invoice_number,
        confidence,
      })

      const message = (
        `Potential invoice payment detected: transaction id=${transactionId}, ` +
        `amount=${row.amount_cents} cents, description="${row.description}". ` +
        `Matched invoice=${invoice.invoice_number} (client=${invoice.client_name}) ` +
        `with confidence=${confidence}. ` +
        `Review the match and mark the invoice paid if correct. ` +
        `Source: invoicePaymentState listener (sourceEventId=${ctx.sourceEventId}).`
      )
      await _wakeOsSession(message, transactionId)
    } catch (err) {
      logger.warn('invoicePaymentState: handle error (non-fatal)', {
        error: err.message,
        transactionId,
      })
    }
  },

  ownsWriteSurface: ['invoice_payment_matches', 'os-session-message'],
}
