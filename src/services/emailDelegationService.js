/**
 * Email Delegation Service — routes emails to the right system after triage.
 *
 * Triage decides what to do. This service executes the delegation:
 *   - Receipts/invoices → bookkeeping pipeline (bk_receipts + auto-match)
 *   - Dev requests → factory session dispatch
 *   - Client emails → CRM pipeline (task creation, project linking)
 *   - Everything else → action queue (existing flow)
 *
 * Called from gmailService.autoAct() after triage completes.
 * Each delegate is fire-and-forget — failures don't block email processing.
 */

const db = require('../config/db')
const logger = require('../config/logger')

// ═══════════════════════════════════════════════════════════════════════
// RECEIPT DELEGATION — invoices, receipts, payment confirmations
// ═══════════════════════════════════════════════════════════════════════

/**
 * Detect if an email is a receipt/invoice and extract it into bk_receipts.
 * Called after triage, works on the email_thread row.
 */
async function delegateReceipt(thread, triageResult) {
  // Heuristic: check if triage flagged it as a receipt, or subject/sender patterns
  const isReceipt = _looksLikeReceipt(thread, triageResult)
  if (!isReceipt) return null

  try {
    const bk = require('./bookkeeperService')

    // Extract amount from email body if possible
    const amountCents = _extractAmountFromBody(thread.full_body || thread.snippet || '')
    const supplierName = _extractSupplierFromEmail(thread.from_email, thread.from_name)
    const receiptDate = thread.received_at ? new Date(thread.received_at).toISOString().slice(0, 10) : null

    const receipt = await bk.saveReceipt({
      source_email: thread.inbox,
      email_message_id: thread.gmail_message_ids?.[0] || null,
      email_subject: thread.subject,
      email_from: thread.from_email,
      email_date: thread.received_at,
      gmail_thread_id: thread.gmail_thread_id,
      supplier_name: supplierName,
      receipt_date: receiptDate,
      amount_cents: amountCents,
      total_amount_cents: amountCents,
    })

    // Try auto-match to a bank transaction
    let match = null
    if (amountCents) {
      match = await bk.matchReceiptToTransaction(receipt.id)
    }

    logger.info('Email delegated to bookkeeping as receipt', {
      threadId: thread.gmail_thread_id,
      supplier: supplierName,
      amount: amountCents,
      matched: !!match,
    })

    return { delegated: 'receipt', receipt_id: receipt.id, matched: !!match }
  } catch (err) {
    logger.warn('Receipt delegation failed (non-blocking)', { error: err.message, threadId: thread.gmail_thread_id })
    return null
  }
}

function _looksLikeReceipt(thread, triageResult) {
  const subject = (thread.subject || '').toLowerCase()
  const from = (thread.from_email || '').toLowerCase()
  const body = (thread.full_body || thread.snippet || '').toLowerCase()

  // Triage explicitly flagged it
  if (triageResult?.isReceipt || triageResult?.category === 'receipt' || triageResult?.category === 'invoice') return true

  // Subject patterns
  const receiptPatterns = [
    /receipt/, /invoice/, /payment.*confirm/, /order.*confirm/, /billing/, /subscription/,
    /your.*payment/, /charge.*\$/, /thank.*for.*your.*purchase/, /tax.*invoice/,
  ]
  if (receiptPatterns.some(p => p.test(subject))) return true

  // Known receipt senders
  const receiptSenders = [
    'noreply@vercel.com', 'billing@supabase.io', 'noreply@stripe.com',
    'receipts@google.com', 'no_reply@email.apple.com', 'noreply@canva.com',
    'billing@digitalocean.com', 'noreply@resend.com', 'noreply@anthropic.com',
    'noreply@openai.com',
  ]
  if (receiptSenders.some(s => from.includes(s.split('@')[1]))) return true

  // Body has dollar amounts + receipt-like language
  if (/\$\d+\.\d{2}/.test(body) && (body.includes('total') || body.includes('amount') || body.includes('charged'))) return true

  return false
}

function _extractAmountFromBody(body) {
  // Look for dollar amounts — take the largest one (likely the total)
  const matches = body.match(/\$(\d{1,6}(?:,\d{3})*\.\d{2})/g)
  if (!matches || !matches.length) return null

  const amounts = matches.map(m => {
    const clean = m.replace(/[$,]/g, '')
    return Math.round(parseFloat(clean) * 100)
  })

  // Return the largest amount (likely the total, not a line item)
  return Math.max(...amounts)
}

function _extractSupplierFromEmail(email, name) {
  if (name && !name.includes('@')) return name
  // Extract domain → supplier name
  const domain = (email || '').split('@')[1] || ''
  const parts = domain.split('.')
  if (parts.length >= 2) return parts[parts.length - 2].charAt(0).toUpperCase() + parts[parts.length - 2].slice(1)
  return email || 'Unknown'
}

// ═══════════════════════════════════════════════════════════════════════
// FACTORY DELEGATION — emails that need code work
// ═══════════════════════════════════════════════════════════════════════

/**
 * If triage detects a dev request, create a factory session.
 * This is the hook the other chat building auto-dev will connect to.
 */
async function delegateToFactory(thread, triageResult) {
  const isDevRequest = _looksLikeDevRequest(thread, triageResult)
  if (!isDevRequest) return null

  try {
    // Create a task first (existing flow), tagged for factory pickup
    const [task] = await db`
      INSERT INTO tasks (title, description, source, source_ref_id, client_id, priority, status)
      VALUES (
        ${`[Dev] ${thread.subject}`},
        ${`Email from ${thread.from_name || thread.from_email}:\n\n${thread.snippet || thread.full_body?.slice(0, 500) || ''}`},
        'gmail', ${thread.id}, ${thread.client_id || null},
        ${triageResult?.taskPriority || 'medium'}, 'open'
      ) RETURNING id`

    // Try to dispatch to factory if available
    let sessionId = null
    try {
      const factory = require('./factoryTriggerService')
      if (factory.fromTask) {
        const session = await factory.fromTask(task.id, {
          prompt: `Client email from ${thread.from_name || thread.from_email}: "${thread.subject}"\n\n${thread.full_body?.slice(0, 1000) || thread.snippet || ''}`,
          source: 'gmail_delegation',
        })
        sessionId = session?.id
      }
    } catch (err) {
      logger.debug('Factory dispatch not available (non-blocking)', { error: err.message })
    }

    logger.info('Email delegated to factory/dev pipeline', {
      threadId: thread.gmail_thread_id,
      taskId: task.id,
      sessionId,
    })

    return { delegated: 'factory', task_id: task.id, session_id: sessionId }
  } catch (err) {
    logger.warn('Factory delegation failed (non-blocking)', { error: err.message })
    return null
  }
}

function _looksLikeDevRequest(thread, triageResult) {
  if (triageResult?.autonomousAction === 'start_cc_session') return true
  if (triageResult?.category === 'dev_request' || triageResult?.category === 'code') return true

  const subject = (thread.subject || '').toLowerCase()
  const body = (thread.full_body || thread.snippet || '').toLowerCase()

  const devPatterns = [
    /bug.*report/, /feature.*request/, /can.*you.*build/, /deploy/, /merge.*request/,
    /pull.*request/, /github/, /gitlab/, /code.*review/,
  ]
  return devPatterns.some(p => p.test(subject) || p.test(body))
}

// ═══════════════════════════════════════════════════════════════════════
// CRM DELEGATION — link emails to clients/projects
// ═══════════════════════════════════════════════════════════════════════

/**
 * Ensure email is linked to the right CRM client and project.
 * Auto-detect from sender email, enrich thread record.
 */
async function delegateToCRM(thread) {
  if (thread.client_id) return null // Already linked

  try {
    // Try to match sender to a CRM client
    const [client] = await db`
      SELECT id, name FROM clients
      WHERE email ILIKE ${thread.from_email}
         OR company_email ILIKE ${thread.from_email}
      LIMIT 1`

    if (client) {
      await db`UPDATE email_threads SET client_id = ${client.id} WHERE id = ${thread.id}`
      logger.info('Email linked to CRM client', { threadId: thread.gmail_thread_id, clientId: client.id, clientName: client.name })
      return { delegated: 'crm', client_id: client.id, client_name: client.name }
    }

    return null
  } catch (err) {
    logger.debug('CRM delegation failed (non-blocking)', { error: err.message })
    return null
  }
}

// ═══════════════════════════════════════════════════════════════════════
// MAIN DELEGATION ROUTER — called after triage
// ═══════════════════════════════════════════════════════════════════════

/**
 * Run all delegation checks on a triaged email.
 * Each delegate is independent — multiple can fire for the same email.
 * e.g., a receipt from a client triggers both receipt + CRM delegation.
 */
async function delegateEmail(thread, triageResult) {
  const results = []

  // Always try CRM linking
  const crmResult = await delegateToCRM(thread)
  if (crmResult) results.push(crmResult)

  // Receipt detection
  const receiptResult = await delegateReceipt(thread, triageResult)
  if (receiptResult) results.push(receiptResult)

  // Factory/dev delegation
  const factoryResult = await delegateToFactory(thread, triageResult)
  if (factoryResult) results.push(factoryResult)

  if (results.length > 0) {
    logger.info('Email delegation results', {
      threadId: thread.gmail_thread_id,
      delegations: results.map(r => r.delegated),
    })
  }

  return results
}

module.exports = {
  delegateEmail,
  delegateReceipt,
  delegateToFactory,
  delegateToCRM,
}
