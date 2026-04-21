#!/usr/bin/env node
/**
 * Edgeless-node retrofit dry run.
 *
 * Queries 10 edgeless nodes (Episode, Pattern, CCSession, Reflection),
 * runs extractEntitiesFromNode on each, writes results to
 * /tmp/edgeless-retrofit-dry-run.json, and prints a summary table.
 *
 * NO graph mutations. Zero MERGE/CREATE/SET Cypher.
 */

'use strict'

const path = require('path')
const fs   = require('fs')

// Resolve paths relative to the ecodiaos root
const ROOT = path.resolve(__dirname, '..')
process.chdir(ROOT)

// Load dotenv equivalent via the existing env config
const env = require(path.join(ROOT, 'src/config/env'))
const { runQuery } = require(path.join(ROOT, 'src/config/neo4j'))
const { extractEntitiesFromNode } = require(path.join(ROOT, 'src/services/neo4jEntityExtractor'))

const OUTPUT_PATH = '/tmp/edgeless-retrofit-dry-run.json'

async function main() {
  console.log('Querying edgeless nodes...\n')

  // Fetch 10 edgeless nodes spread across labels
  const records = await runQuery(
    `MATCH (n) WHERE NOT (n)--()
       AND (n:Episode OR n:Pattern OR n:CCSession OR n:Reflection)
     RETURN elementId(n) AS id, labels(n) AS labels, n.name AS name
     LIMIT 10`
  )

  if (records.length === 0) {
    console.log('No edgeless nodes found.')
    process.exit(0)
  }

  console.log(`Found ${records.length} edgeless nodes. Running extractor...\n`)

  const results = []
  for (const rec of records) {
    const nodeId = rec.get('id')
    const labels = rec.get('labels')
    const name   = rec.get('name') || '(unnamed)'

    process.stdout.write(`  Extracting: ${name.slice(0, 60).replace(/\n/g, ' ')}... `)

    let result
    try {
      result = await extractEntitiesFromNode(nodeId)
    } catch (err) {
      result = { nodeId, nodeLabel: labels[0], nodeName: name, error: err.message, proposedEdges: [] }
    }

    // Attach labels from the query (extractor might not have them in error case)
    result._labels = labels
    results.push(result)

    console.log(`${result.proposedEdges.length} edge(s) proposed`)
  }

  // Write JSON output
  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(results, null, 2), 'utf8')
  console.log(`\nResults written to ${OUTPUT_PATH}\n`)

  // Print summary table
  const COL = { node: 55, label: 12, edges: 8, conf: 10 }
  const header = [
    'Node'.padEnd(COL.node),
    'Label'.padEnd(COL.label),
    'Edges'.padEnd(COL.edges),
    'Max conf'.padEnd(COL.conf),
  ].join('  ')
  const separator = '-'.repeat(header.length)

  console.log(header)
  console.log(separator)

  for (const r of results) {
    const nodeName = (r.nodeName || '(unnamed)').replace(/\n/g, ' ').slice(0, COL.node - 1).padEnd(COL.node)
    const label    = (r.nodeLabel || '?').slice(0, COL.label - 1).padEnd(COL.label)
    const edgeCount = String(r.proposedEdges.length).padEnd(COL.edges)

    const maxConf = r.proposedEdges.length > 0
      ? Math.max(...r.proposedEdges.map(e => e.confidence)).toFixed(2)
      : '-'

    console.log([nodeName, label, edgeCount, maxConf.padEnd(COL.conf)].join('  '))
  }

  console.log(separator)
  const totalEdges = results.reduce((sum, r) => sum + r.proposedEdges.length, 0)
  console.log(`\nTotal nodes: ${results.length}  Total proposed edges: ${totalEdges}\n`)
}

main().then(() => process.exit(0)).catch(err => {
  console.error('Fatal:', err)
  process.exit(1)
})
