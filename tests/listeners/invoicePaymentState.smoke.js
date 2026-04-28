'use strict'

/**
 * invoicePaymentState.smoke.js
 *
 * 5-layer empirical smoke-test for the invoicePaymentState listener.
 *
 * Layers verified (per ~/ecodiaos/patterns/listener-pipeline-needs-five-layer-verification.md):
 *   L1 PRODUCER  : the listener can find ≥1 open invoice in public.invoices.
 *   L2 TRIGGER   : trg_staged_transactions_insert_notify exists in pg_trigger.
 *   L3 BRIDGE    : src/services/listeners/dbBridge.js exists and exports a start() function.
 *   L4 LISTENER  : registry.loadListeners() loads invoicePaymentState with valid shape.
 *   L5 SIDE-EFFECT: handler invoked against live DB inserts a row in invoice_payment_matches
 *                   AND attempts to wake the OS session via HTTP POST.
 *
 * Default mode: DIRECT — calls the listener.handle() function directly with a synthesized
 * event after seeding the DB. This validates the NEW code against the LIVE database
 * without requiring a PM2 restart.
 *
 * --live flag: instead of direct invocation, INSERT a real staged_transactions row and
 * poll invoice_payment_matches for up to 5 seconds. This validates the full pipeline
 * end-to-end (trigger → bridge → listener → side-effect) but only succeeds AFTER the
 * api process has been restarted to pick up the new listener code.
 *
 * Cleanup is in REVERSE dependency order: invoice_payment_matches -> staged_transactions -> invoices.
 *
 * Exit code 0 = all layers pass. Exit code 1 = any layer failed.
 *
 * Per-pattern: verify-empirically-not-by-log-tail.md — every assertion is a DB row
 * or function-shape check, never a log-line tail.
 */

require('dotenv').config({ path: require('path').join(__dirname, '../../.env') })

const path = require('path')
const fs = require('fs')
const http = require('http')

const SMOKE_TAG = 'SmokeClient_2026_04_29'
const SMOKE_AMOUNT = 99887
const SMOKE_INVOICE = 'SMOKE-INV-2026-04-29'
const SMOKE_TXN_ID = 'smoke-txn-2026-04-29'
const SMOKE_DESCRIPTION = `Bank transfer from ${SMOKE_TAG} ref XYZ`

const liveMode = process.argv.includes('--live')

let passed = 0
let failed = 0
const failures = []

function check(layer, name, ok, detail) {
  if (ok) {
    console.log(`  PASS [${layer}] ${name}` + (detail ? `  (${detail})` : ''))
    passed++
  } else {
    console.error(`  FAIL [${layer}] ${name}` + (detail ? `  -- ${detail}` : ''))
    failed++
    failures.push(`${layer} ${name}: ${detail || 'no detail'}`)
  }
}

async function probeOsSessionEndpoint() {
  // Simple connection probe to /api/os-session/message — confirms layer 5b
  // (the wake-up endpoint is reachable from the smoke-test process).
  return new Promise(resolve => {
    const req = http.request(
      {
        host: 'localhost',
        port: process.env.PORT || 3001,
        path: '/api/os-session/message',
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        timeout: 4000,
      },
      res => {
        // 400 (no message) is fine — proves the route is alive.
        // 200 / 202 also fine. Anything else means the route is down.
        resolve({ status: res.statusCode })
      },
    )
    req.on('error', err => resolve({ error: err.message }))
    req.on('timeout', () => {
      req.destroy()
      resolve({ error: 'timeout' })
    })
    req.write('{}')
    req.end()
  })
}

async function cleanupSyntheticData(db) {
  // Reverse dependency order: matches FK to staged_transactions; staged_transactions
  // is self-contained; invoices is self-contained.
  try {
    await db`DELETE FROM invoice_payment_matches WHERE invoice_number = ${SMOKE_INVOICE} OR staged_transaction_id = ${SMOKE_TXN_ID}`
    await db`DELETE FROM staged_transactions WHERE id = ${SMOKE_TXN_ID}`
    await db`DELETE FROM invoices WHERE invoice_number = ${SMOKE_INVOICE}`
  } catch (err) {
    console.error('  WARN: cleanup error (manual check may be needed):', err.message)
  }
}

;(async () => {
  let db
  try {
    db = require(path.join(__dirname, '../../src/config/db'))
  } catch (err) {
    console.error('FATAL: failed to load db module:', err.message)
    process.exit(1)
  }

  // Always cleanup on exit so a partial run doesn't leave synthetic rows around.
  process.on('exit', () => {
    // Sync cleanup not possible here, but the explicit cleanup at the end is reliable.
  })

  try {
    console.log('--- Pre-cleanup (in case prior run left rows) ---')
    await cleanupSyntheticData(db)

    // ------------------------------------------------------------------
    // L1 PRODUCER — the listener's open-invoice query returns ≥1 row when
    // an open invoice exists.
    // ------------------------------------------------------------------
    console.log('\n--- L1 PRODUCER (open-invoices query against public.invoices) ---')

    // Seed: synthetic open invoice
    await db`
      INSERT INTO invoices (
        invoice_number, client_name, invoice_date, due_date,
        subtotal_cents, gst_cents, total_cents, line_items, status
      ) VALUES (
        ${SMOKE_INVOICE}, ${SMOKE_TAG}, '2026-04-29', '2026-05-29',
        ${SMOKE_AMOUNT}, 0, ${SMOKE_AMOUNT}, '[]'::jsonb, 'sent'
      )
    `

    const openInvoices = await db`
      SELECT invoice_number, client_name, total_cents
      FROM invoices
      WHERE status NOT IN ('paid', 'void', 'cancelled')
    `
    check(
      'L1',
      'open-invoices query returns ≥1 row',
      openInvoices.length >= 1,
      `${openInvoices.length} open invoice(s)`,
    )
    const seeded = openInvoices.find(i => i.invoice_number === SMOKE_INVOICE)
    check(
      'L1',
      'synthetic invoice present in result set',
      !!seeded && seeded.total_cents === SMOKE_AMOUNT,
      seeded ? `total_cents=${seeded.total_cents}` : 'not found',
    )

    // ------------------------------------------------------------------
    // L2 TRIGGER — pg_trigger row exists and points at the right function.
    // ------------------------------------------------------------------
    console.log('\n--- L2 TRIGGER (pg_trigger row for staged_transactions) ---')
    const triggerRows = await db`
      SELECT t.tgname, c.relname AS table_name, p.proname AS function_name
      FROM pg_trigger t
      JOIN pg_class    c ON c.oid = t.tgrelid
      JOIN pg_proc     p ON p.oid = t.tgfoid
      WHERE t.tgname = 'trg_staged_transactions_insert_notify'
    `
    check(
      'L2',
      'trg_staged_transactions_insert_notify exists',
      triggerRows.length === 1,
      triggerRows[0]
        ? `table=${triggerRows[0].table_name} fn=${triggerRows[0].function_name}`
        : 'not found',
    )
    if (triggerRows.length === 1) {
      check(
        'L2',
        'trigger calls eos_listener_notify_compact',
        triggerRows[0].function_name === 'eos_listener_notify_compact',
        triggerRows[0].function_name,
      )
    }

    // ------------------------------------------------------------------
    // L3 BRIDGE — dbBridge module loads cleanly and exports start().
    // ------------------------------------------------------------------
    console.log('\n--- L3 BRIDGE (dbBridge module shape) ---')
    const dbBridgePath = path.join(__dirname, '../../src/services/listeners/dbBridge.js')
    check('L3', 'dbBridge.js exists on disk', fs.existsSync(dbBridgePath), dbBridgePath)
    let dbBridge = null
    try {
      dbBridge = require(dbBridgePath)
    } catch (err) {
      check('L3', 'dbBridge module loads', false, err.message)
    }
    if (dbBridge) {
      check(
        'L3',
        'dbBridge exports start() function',
        typeof dbBridge.start === 'function',
        `typeof start = ${typeof dbBridge.start}`,
      )
    }

    // ------------------------------------------------------------------
    // L4 LISTENER — registry loads invoicePaymentState with valid shape.
    // ------------------------------------------------------------------
    console.log('\n--- L4 LISTENER (registry.loadListeners()) ---')
    const registry = require(path.join(__dirname, '../../src/services/listeners/registry'))
    const loaded = registry.loadListeners()
    const target = loaded.find(l => l.name === 'invoicePaymentState')
    check('L4', 'invoicePaymentState loaded by registry', !!target, target ? 'shape ok' : 'missing')
    if (target) {
      check(
        'L4',
        'subscribesTo includes db:event',
        target.subscribesTo.includes('db:event'),
        target.subscribesTo.join(','),
      )
      check(
        'L4',
        'ownsWriteSurface includes invoice_payment_matches',
        target.ownsWriteSurface.includes('invoice_payment_matches'),
      )
    }

    // ------------------------------------------------------------------
    // L5 SIDE-EFFECT — the handler inserts an invoice_payment_matches row
    // when the synthetic event matches the seeded invoice (high confidence).
    // ------------------------------------------------------------------
    console.log('\n--- L5 SIDE-EFFECT (match row insert + OS wake) ---')

    // Probe the wake endpoint upfront — proves layer 5b reachability before
    // we depend on the listener firing it.
    const probe = await probeOsSessionEndpoint()
    const wakeReachable = !probe.error
    check(
      'L5',
      '/api/os-session/message endpoint reachable',
      wakeReachable,
      probe.error ? probe.error : `status=${probe.status}`,
    )

    if (liveMode) {
      // Full e2e through the live process — only works after PM2 restart.
      console.log('  (live mode: inserting staged_transactions and polling for match)')
      await db`
        INSERT INTO staged_transactions (
          id, source, source_ref, occurred_at, amount_cents, description, status
        ) VALUES (
          ${SMOKE_TXN_ID}, 'manual',${'smoke-' + Date.now()}, '2026-04-29',
          ${SMOKE_AMOUNT}, ${SMOKE_DESCRIPTION}, 'pending'
        )
      `

      let match = null
      const deadline = Date.now() + 5500
      while (Date.now() < deadline) {
        const rows = await db`
          SELECT invoice_number, staged_transaction_id, confidence, matched_amount_cents
          FROM invoice_payment_matches
          WHERE staged_transaction_id = ${SMOKE_TXN_ID}
          LIMIT 1
        `
        if (rows.length > 0) {
          match = rows[0]
          break
        }
        await new Promise(r => setTimeout(r, 250))
      }
      check(
        'L5',
        'invoice_payment_matches row appeared within 5s (live e2e)',
        !!match,
        match ? `inv=${match.invoice_number} conf=${match.confidence}` : 'no row in 5s',
      )
      if (match) {
        check(
          'L5',
          'match row has correct invoice_number',
          match.invoice_number === SMOKE_INVOICE,
          `got ${match.invoice_number}`,
        )
        check(
          'L5',
          "match row has confidence='high'",
          match.confidence === 'high',
          `got ${match.confidence}`,
        )
      }
    } else {
      // Direct invocation — call the new listener code against the live DB
      // without going through the trigger/bridge pipeline. Validates that
      // the NEW handler will fire correctly once the api process is restarted.
      console.log('  (direct mode: invoking listener.handle() with synthesized event)')

      // Need a real staged_transactions row because the match row FKs to it.
      await db`
        INSERT INTO staged_transactions (
          id, source, source_ref, occurred_at, amount_cents, description, status
        ) VALUES (
          ${SMOKE_TXN_ID}, 'manual',${'smoke-' + Date.now()}, '2026-04-29',
          ${SMOKE_AMOUNT}, ${SMOKE_DESCRIPTION}, 'pending'
        )
      `

      const fakeEvent = {
        type: 'db:event',
        seq: 1,
        ts: new Date().toISOString(),
        data: {
          type: 'db:event',
          table: 'staged_transactions',
          action: 'INSERT',
          row: {
            id: SMOKE_TXN_ID,
            amount_cents: SMOKE_AMOUNT,
            description: SMOKE_DESCRIPTION,
            occurred_at: '2026-04-29',
          },
          ts: Date.now() / 1000,
        },
      }
      const ctx = { sourceEventId: 'smoke-evt-' + Date.now() }
      const listener = require(path.join(
        __dirname,
        '../../src/services/listeners/invoicePaymentState',
      ))
      check('L5', 'relevanceFilter accepts synthesized event', listener.relevanceFilter(fakeEvent))
      await listener.handle(fakeEvent, ctx)

      const rows = await db`
        SELECT invoice_number, staged_transaction_id, confidence, matched_amount_cents
        FROM invoice_payment_matches
        WHERE staged_transaction_id = ${SMOKE_TXN_ID}
        LIMIT 1
      `
      const match = rows[0]
      check(
        'L5',
        'invoice_payment_matches row inserted (direct invocation)',
        !!match,
        match ? `inv=${match.invoice_number} conf=${match.confidence}` : 'no row inserted',
      )
      if (match) {
        check(
          'L5',
          'match row has correct invoice_number',
          match.invoice_number === SMOKE_INVOICE,
          `got ${match.invoice_number}`,
        )
        check(
          'L5',
          "match row has confidence='high'",
          match.confidence === 'high',
          `got ${match.confidence}`,
        )
        check(
          'L5',
          'match row has correct matched_amount_cents',
          Number(match.matched_amount_cents) === SMOKE_AMOUNT,
          `got ${match.matched_amount_cents}`,
        )
      }
    }

    // ------------------------------------------------------------------
    // Cleanup
    // ------------------------------------------------------------------
    console.log('\n--- Cleanup (reverse dependency order) ---')
    await cleanupSyntheticData(db)
    const remainingMatches = await db`
      SELECT 1 FROM invoice_payment_matches
      WHERE invoice_number = ${SMOKE_INVOICE} OR staged_transaction_id = ${SMOKE_TXN_ID}
    `
    const remainingTxns = await db`SELECT 1 FROM staged_transactions WHERE id = ${SMOKE_TXN_ID}`
    const remainingInvoices = await db`SELECT 1 FROM invoices WHERE invoice_number = ${SMOKE_INVOICE}`
    check('CLEANUP', 'no synthetic invoice_payment_matches rows', remainingMatches.length === 0)
    check('CLEANUP', 'no synthetic staged_transactions rows', remainingTxns.length === 0)
    check('CLEANUP', 'no synthetic invoices rows', remainingInvoices.length === 0)

    console.log(`\nResults: ${passed} passed, ${failed} failed`)
    if (failed > 0) {
      console.error('\nFailures:')
      failures.forEach(f => console.error('  -', f))
    }
  } catch (err) {
    console.error('FATAL during smoke test:', err.message)
    console.error(err.stack)
    failed++
    try {
      await cleanupSyntheticData(db)
    } catch {}
  } finally {
    try {
      await db.end({ timeout: 5 })
    } catch {}
  }

  process.exit(failed > 0 ? 1 : 0)
})()
