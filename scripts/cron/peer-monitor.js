#!/usr/bin/env node
'use strict'

/**
 * peer-monitor.js -- cron entry point for the peer monitor scan.
 *
 * Invoked by the OS scheduler every 72h via the os_scheduled_tasks cron row.
 * Can also be run manually: node scripts/cron/peer-monitor.js [--dry-run]
 *
 * What it does:
 *   1. Calls runPeerMonitor() from src/services/peerMonitor.js
 *   2. Writes a Neo4j Episode with the scan summary
 *   3. Logs the result and exits
 *
 * Dry-run mode (--dry-run flag): prints candidates without writing to DB/Neo4j.
 */

const path = require('path')
const ROOT = path.resolve(__dirname, '../..')
process.chdir(ROOT)

// Load .env before any src/ config files
require('dotenv').config({ path: path.join(ROOT, '.env') })

const { runPeerMonitor } = require(path.join(ROOT, 'src/services/peerMonitor'))
const { runWrite } = require(path.join(ROOT, 'src/config/neo4j'))
const db = require(path.join(ROOT, 'src/config/db'))

const isDryRun = process.argv.includes('--dry-run')

async function writeEpisode(result, durationMs) {
  const description = [
    `Peer monitor scan completed in ${Math.round(durationMs / 1000)}s.`,
    `Queries run: ${result.scanned} of 6.`,
    `Candidates extracted: ${result.candidates}.`,
    `New peers added: ${result.new_peers}.`,
    `Cache size after: ${result.cache_size_after} known peers.`,
    result.new_peer_list
      ? `New peers (dry-run): ${result.new_peer_list.map(p => p.name).join(', ')}`
      : '',
  ].filter(Boolean).join(' ')

  try {
    await runWrite(`
      MERGE (e:Episode { name: 'Peer Monitor Scan ' + $date })
      SET e.description = $description,
          e.type        = 'automated_scan',
          e.created_at  = datetime(),
          e.updated_at  = datetime()
    `, {
      date: new Date().toISOString().slice(0, 10),
      description,
    })
  } catch (err) {
    console.error('[peer-monitor] Failed to write Episode to Neo4j:', err.message)
  }
}

async function main() {
  console.log(`[peer-monitor] Starting scan${isDryRun ? ' (DRY RUN)' : ''}...`)
  const start = Date.now()

  try {
    const result = await runPeerMonitor({ dryRun: isDryRun })
    const durationMs = Date.now() - start

    console.log('[peer-monitor] Scan complete:')
    console.log(`  Queries run:       ${result.scanned}`)
    console.log(`  Candidates found:  ${result.candidates}`)
    console.log(`  New peers written: ${result.new_peers}`)
    console.log(`  Cache size after:  ${result.cache_size_after}`)
    console.log(`  Duration:          ${Math.round(durationMs / 1000)}s`)

    if (isDryRun && result.new_peer_list && result.new_peer_list.length > 0) {
      console.log('\n[peer-monitor] Dry-run candidates:')
      result.new_peer_list.forEach((p, i) => {
        console.log(`  ${i + 1}. ${p.name} (${p.kind}, ${p.jurisdiction}) confidence=${p.confidence}`)
        console.log(`     ${p.summary}`)
      })
    }

    if (!isDryRun) {
      await writeEpisode(result, durationMs)
    }
  } catch (err) {
    console.error('[peer-monitor] Fatal error:', err.message)
    process.exitCode = 1
  } finally {
    // Close the postgres connection pool so the process can exit cleanly
    try { await db.end() } catch {}
  }
}

main()
