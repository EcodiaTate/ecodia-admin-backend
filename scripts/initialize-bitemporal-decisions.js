'use strict'
/**
 * Tier-4b: Initialize bi-temporal validity on Decision / Pattern / Strategic_Direction nodes.
 *
 * Run once: node scripts/initialize-bitemporal-decisions.js
 *
 * Does three things:
 *   1. Creates range indexes on t_invalid_from for Decision, Pattern, Strategic_Direction
 *   2. Backfills t_valid_from on any existing nodes where it is missing
 *   3. Prints a summary
 */

const path = require('path')
process.chdir(path.join(__dirname, '..'))

const { getDriver, runQuery, runWrite } = require('../src/config/neo4j')

async function main() {
  try {
    // 1. Create range indexes (idempotent via IF NOT EXISTS)
    const indexDefs = [
      { label: 'Decision',            name: 'bitemporal_t_invalid_from_decision' },
      { label: 'Pattern',             name: 'bitemporal_t_invalid_from_pattern' },
      { label: 'Strategic_Direction', name: 'bitemporal_t_invalid_from_strategic_direction' },
    ]

    const indexResults = []
    for (const { label, name } of indexDefs) {
      try {
        await runWrite(
          `CREATE INDEX ${name} IF NOT EXISTS FOR (n:\`${label}\`) ON (n.t_invalid_from)`
        )
        indexResults.push(`${name}: created (or already exists)`)
      } catch (err) {
        indexResults.push(`${name}: ERROR - ${err.message}`)
      }
    }

    // 2. Backfill t_valid_from on any existing nodes where it is missing.
    // coalesce priority: date (if set as a date property) -> created_at -> now()
    const backfillRecords = await runWrite(
      `MATCH (n) WHERE (n:Decision OR n:Pattern OR n:Strategic_Direction)
         AND n.t_valid_from IS NULL
       SET n.t_valid_from = coalesce(
         CASE WHEN n.date IS NOT NULL THEN datetime(n.date) ELSE null END,
         n.created_at,
         datetime()
       )
       RETURN count(n) AS backfilled`
    )
    const backfilled =
      backfillRecords[0]?.get?.('backfilled')?.toInt?.() ??
      backfillRecords[0]?.get?.('backfilled') ??
      0

    // 3. Total count for the summary
    const countRecords = await runQuery(
      `MATCH (n) WHERE (n:Decision OR n:Pattern OR n:Strategic_Direction)
       RETURN count(n) AS total`
    )
    const total =
      countRecords[0]?.get?.('total')?.toInt?.() ??
      countRecords[0]?.get?.('total') ??
      0

    console.log('Bi-temporal initialization complete:')
    for (const r of indexResults) console.log(' -', r)
    console.log(` Nodes backfilled with t_valid_from: ${backfilled}`)
    console.log(` Total Decision/Pattern/Strategic_Direction nodes: ${total}`)

    // Close the driver so the process exits cleanly
    const d = getDriver()
    if (d) await d.close()
    process.exit(0)
  } catch (err) {
    console.error('Bi-temporal initialization failed:', err.message)
    process.exit(1)
  }
}

if (require.main === module) { main() }

module.exports = { main }
