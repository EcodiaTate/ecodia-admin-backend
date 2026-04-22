#!/usr/bin/env node
/**
 * scripts/run-extractor-write.js
 *
 * Batch-runs the Neo4j entity extractor over nodes matching a Cypher filter,
 * writing edges at >=0.85 confidence. Feature flag must be enabled via
 * NEO4J_EXTRACTOR_WRITE_ENABLED=true or the --force flag.
 *
 * Usage:
 *   node scripts/run-extractor-write.js [--limit=N] [--dry-run] [--force] [--labels=Decision,Episode,Pattern]
 *
 * By default it targets edgeless Decision/Episode/Pattern/CCSession nodes.
 */

const path = require('path')
process.chdir(path.resolve(__dirname, '..'))

const { extractAndWrite, extractEntitiesFromNode, writeExtractedEdges } = require('../src/services/neo4jEntityExtractor')
const { runQuery } = require('../src/config/neo4j')
const logger = require('../src/config/logger')
const neo4j = require('neo4j-driver')

function parseArgs(argv) {
  const args = { limit: 25, dryRun: false, force: false, labels: ['Decision', 'Episode', 'Pattern', 'CCSession'] }
  for (const a of argv.slice(2)) {
    if (a === '--dry-run') args.dryRun = true
    else if (a === '--force') args.force = true
    else if (a.startsWith('--limit=')) args.limit = parseInt(a.split('=')[1], 10) || 25
    else if (a.startsWith('--labels=')) args.labels = a.split('=')[1].split(',')
  }
  return args
}

async function findEdgelessNodes(labels, limit) {
  const records = await runQuery(
    `MATCH (n)
     WHERE any(lbl IN labels(n) WHERE lbl IN $labels)
       AND n.name IS NOT NULL
       AND NOT (n)-[]->()
       AND NOT ()-[]->(n)
     RETURN elementId(n) AS nodeId, labels(n) AS labels, n.name AS name
     ORDER BY coalesce(n.date, n.created_at, datetime('1970-01-01T00:00:00Z')) DESC
     LIMIT $limit`,
    { labels, limit: neo4j.int(limit) }
  )
  return records.map(r => ({
    nodeId: r.get('nodeId'),
    labels: r.get('labels'),
    name: r.get('name'),
  }))
}

async function main() {
  const args = parseArgs(process.argv)
  console.log('Extractor CLI starting:', args)

  const nodes = await findEdgelessNodes(args.labels, args.limit)
  console.log(`Found ${nodes.length} edgeless nodes to process`)

  const totals = { processed: 0, proposed: 0, written: 0, skipped_low_conf: 0, skipped_disabled: 0, errors: 0 }

  for (const node of nodes) {
    try {
      if (args.dryRun) {
        const ex = await extractEntitiesFromNode(node.nodeId)
        const eligible = ex.proposedEdges.filter(e => e.confidence >= 0.85)
        console.log(`  [dry] ${node.labels[0]} "${node.name}" -> ${ex.proposedEdges.length} proposed, ${eligible.length} would write`)
        totals.proposed += ex.proposedEdges.length
      } else {
        const r = await extractAndWrite(node.nodeId, { force: args.force })
        console.log(`  ${node.labels[0]} "${node.name}" -> ${r.proposedEdges.length} proposed, ${r.write.written} written, ${r.write.skipped_low_conf} skipped (conf), ${r.write.skipped_disabled} skipped (flag)`)
        totals.proposed += r.proposedEdges.length
        totals.written += r.write.written
        totals.skipped_low_conf += r.write.skipped_low_conf
        totals.skipped_disabled += r.write.skipped_disabled
        totals.errors += r.write.errors
      }
      totals.processed += 1
    } catch (err) {
      console.error(`  ERROR on ${node.name}:`, err.message)
      totals.errors += 1
    }
  }

  console.log('\nTotals:', totals)
  process.exit(totals.errors > 0 ? 1 : 0)
}

main().catch(err => {
  console.error('Fatal:', err)
  process.exit(2)
})
