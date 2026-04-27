#!/usr/bin/env node
'use strict'

// =========================================================================
// PEER MONITOR — CLI runner + re-export
//
// Usage:
//   node src/scripts/peerMonitor.js              # live run
//   node src/scripts/peerMonitor.js --dry-run    # inspect without writing
//
// Acceptance gate: --dry-run prints { candidatesEvaluated, qualifiedNew,
// alreadySeen, wouldSurface, queries } and exits 0 without writing to
// kv_store, Neo4j, or status_board.
//
// Delegates all logic to src/services/peerMonitor.js.
// =========================================================================

require('../config/env')
const logger = require('../config/logger')
const { runPeerMonitor } = require('../services/peerMonitor')

// Re-export so callers can `require('./peerMonitor').runPeerMonitor`
module.exports = { runPeerMonitor }

// -- CLI entry point --------------------------------------------------------

if (require.main === module) {
  const dryRun = process.argv.includes('--dry-run')

  if (dryRun) {
    logger.info('peerMonitor: running in DRY-RUN mode — no writes will occur')
  }

  runPeerMonitor({ dryRun })
    .then(result => {
      if (dryRun) {
        // Print diff structure matching acceptance spec
        const report = {
          candidatesEvaluated: result.candidates,
          qualifiedNew: result.new_peers,
          alreadySeen: result.cache_size_after - result.new_peers,
          wouldSurface: result.new_peers >= 3 || false,
          queries: result.scanned,
          new_peer_list: result.new_peer_list || [],
        }
        console.log('\n-- DRY RUN REPORT --')
        console.log(JSON.stringify(report, null, 2))
        logger.info('peerMonitor: dry-run complete', report)
      } else {
        logger.info('peerMonitor: run complete', result)
      }
      process.exit(0)
    })
    .catch(err => {
      logger.error('peerMonitor: fatal error', { error: err.message, stack: err.stack })
      process.exit(1)
    })
}
