/**
 * Verify the Tate Active Session Gate behaves correctly.
 *
 * Tests:
 *   a) Stamping the key makes isTateActive() return true
 *   b) Writing an expired timestamp makes isTateActive() return false
 *   c) The last_deferred_at column exists and accepts a write
 *
 * Usage: node scripts/verify-tate-gate.js
 */

const db = require('../src/config/db')
const { stampTateActive, isTateActive } = require('../src/services/tateActiveGate')

const KV_KEY = 'system.tate_active_session_until'

async function run() {
  let passed = 0
  let failed = 0

  async function check(label, fn) {
    try {
      const ok = await fn()
      if (ok) { console.log(`  PASS: ${label}`); passed++ }
      else     { console.log(`  FAIL: ${label}`); failed++ }
    } catch (err) {
      console.log(`  FAIL: ${label} — threw: ${err.message}`)
      failed++
    }
  }

  console.log('\nVerifying Tate Active Gate...\n')

  // a) Stamp -> active
  await check('stampTateActive() makes isTateActive() return true', async () => {
    await stampTateActive()
    return isTateActive()
  })

  // b) Expired timestamp -> inactive
  await check('Expired timestamp makes isTateActive() return false', async () => {
    const past = new Date(Date.now() - 60_000).toISOString()
    const value = JSON.stringify({ until: past })
    await db`INSERT INTO kv_store (key, value) VALUES (${KV_KEY}, ${value}) ON CONFLICT (key) DO UPDATE SET value = ${value}`
    const active = await isTateActive()
    return active === false
  })

  // c) last_deferred_at column exists and accepts a write
  await check('last_deferred_at column exists on os_scheduled_tasks', async () => {
    const [row] = await db`SELECT id FROM os_scheduled_tasks LIMIT 1`
    if (!row) {
      // No tasks yet - verify column exists via information_schema
      const [col] = await db`
        SELECT column_name FROM information_schema.columns
        WHERE table_name = 'os_scheduled_tasks' AND column_name = 'last_deferred_at'
      `
      return !!col
    }
    await db`UPDATE os_scheduled_tasks SET last_deferred_at = now() WHERE id = ${row.id}`
    const [updated] = await db`SELECT last_deferred_at FROM os_scheduled_tasks WHERE id = ${row.id}`
    return updated.last_deferred_at !== null
  })

  console.log(`\nResult: ${passed} passed, ${failed} failed\n`)
  await db.end()
  process.exit(failed > 0 ? 1 : 0)
}

run().catch(err => {
  console.error('Verification crashed:', err.message)
  process.exit(1)
})
