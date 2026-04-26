#!/usr/bin/env node
'use strict'

/**
 * 2026-04-27-peer-monitor-cron.js
 *
 * One-shot migration: registers (or updates) the peer-monitor cron row in
 * os_scheduled_tasks. Idempotent - safe to run multiple times.
 *
 * Schedule: every 72h (3 days).
 *
 * Run: node scripts/migrations/2026-04-27-peer-monitor-cron.js
 */

const path = require('path')
const ROOT = path.resolve(__dirname, '../..')
process.chdir(ROOT)

require('dotenv').config({ path: path.join(ROOT, '.env') })

const db = require(path.join(ROOT, 'src/config/db'))

const TASK_NAME = 'peer-monitor'
const CRON_EXPRESSION = 'every 72h'
const PROMPT = [
  '[SCHEDULED: peer-monitor] Run the peer-monitor scan:',
  'curated WebSearches for new AI-managed / AI-member legal entities,',
  'diff against kv_store cache (key: ceo.peer_monitor_seen),',
  'surface new peers above 0.7 confidence as Neo4j Peer nodes + status_board rows.',
  'Then write an Episode with the scan summary.',
  'Use: node scripts/cron/peer-monitor.js',
  'OR call runPeerMonitor() from src/services/peerMonitor.js directly.',
].join(' ')

// Compute next run 72h from now (mirrors scheduler MCP computeNextRun logic)
function computeNextRun() {
  return new Date(Date.now() + 72 * 3_600_000)
}

async function main() {
  console.log(`Registering cron task "${TASK_NAME}" in os_scheduled_tasks...`)

  try {
    // Check if the task already exists
    const existing = await db`
      SELECT id, status, cron_expression FROM os_scheduled_tasks
      WHERE name = ${TASK_NAME}
      LIMIT 1
    `

    if (existing.length > 0) {
      // Update existing row - refresh prompt and set status active
      const [row] = await db`
        UPDATE os_scheduled_tasks
        SET
          prompt          = ${PROMPT},
          cron_expression = ${CRON_EXPRESSION},
          status          = 'active',
          next_run_at     = ${computeNextRun()},
          updated_at      = NOW()
        WHERE name = ${TASK_NAME}
        RETURNING id, next_run_at
      `
      console.log(`Updated existing task id=${existing[0].id}. Next run: ${row.next_run_at}`)
    } else {
      // Insert new row using the same column set as the scheduler MCP
      const [row] = await db`
        INSERT INTO os_scheduled_tasks
          (type, name, prompt, cron_expression, status, next_run_at, run_count, max_runs)
        VALUES
          ('cron', ${TASK_NAME}, ${PROMPT}, ${CRON_EXPRESSION}, 'active', ${computeNextRun()}, 0, 0)
        RETURNING id, next_run_at
      `
      console.log(`Created new task id=${row.id}. Next run: ${row.next_run_at}`)
    }

    console.log('Done.')
  } catch (err) {
    console.error('Migration failed:', err.message)
    process.exitCode = 1
  } finally {
    await db.end()
  }
}

main()
