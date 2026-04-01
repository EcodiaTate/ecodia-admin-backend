const axios = require('axios')
const { runQuery, runWrite } = require('../config/neo4j')
const env = require('../config/env')
const logger = require('../config/logger')

// ═══════════════════════════════════════════════════════════════════════
// MEMORY BRIDGE SERVICE — Dual Neo4j Cross-Pollination
//
// Admin KG: real-world knowledge (emails, calendar, CRM, code, deploys)
// Organism KG: cognitive knowledge (beliefs, hypotheses, narratives)
//
// Selectively mirrors high-value nodes between the two graphs.
// Newer updated_at wins. Both versions preserved via SUPERSEDED_BY.
// ═══════════════════════════════════════════════════════════════════════

// Labels worth syncing to the organism
const SYNC_TO_ORGANISM_LABELS = ['Person', 'Project', 'Decision', 'Pattern', 'Codebase']
const SYNC_TO_ORGANISM_MIN_CONNECTIONS = 2

// Labels worth pulling from the organism
const SYNC_FROM_ORGANISM_LABELS = ['Narrative', 'Prediction', 'Pattern', 'Episode', 'CausalChain']

// ─── Sync to Organism ───────────────────────────────────────────────

async function syncToOrganism() {
  if (!env.ORGANISM_API_URL) return { synced: 0 }

  let synced = 0
  try {
    for (const label of SYNC_TO_ORGANISM_LABELS) {
      // Get high-importance nodes that have been updated recently
      const records = await runQuery(
        `MATCH (n:\`${label}\`)
         WHERE n.updated_at > datetime() - duration('PT30M')
           OR (n.importance IS NOT NULL AND n.importance > 0.5)
         WITH n, size([(n)-[]-() | 1]) AS connections
         WHERE connections >= $minConnections
         RETURN n, labels(n) AS labels
         LIMIT 20`,
        { minConnections: SYNC_TO_ORGANISM_MIN_CONNECTIONS }
      )

      for (const record of records) {
        const node = record.get('n').properties
        const labels = record.get('labels')

        try {
          await axios.post(`${env.ORGANISM_API_URL}/api/v1/memory/entities`, {
            name: node.name,
            labels,
            properties: sanitizeForSync(node),
            source: 'ecodiaos_memory_bridge',
          }, { timeout: 5000 })
          synced++
        } catch (err) {
          logger.debug(`Failed to sync node ${node.name} to organism`, { error: err.message })
        }
      }
    }
  } catch (err) {
    logger.warn('syncToOrganism failed', { error: err.message })
  }

  if (synced > 0) {
    logger.info(`Memory bridge: synced ${synced} nodes to organism`)
  }
  return { synced }
}

// ─── Sync from Organism ─────────────────────────────────────────────

async function syncFromOrganism() {
  if (!env.ORGANISM_API_URL) return { synced: 0 }

  let synced = 0
  try {
    for (const label of SYNC_FROM_ORGANISM_LABELS) {
      try {
        const res = await axios.get(`${env.ORGANISM_API_URL}/api/v1/memory/entities`, {
          params: { label, since: getLastSyncTime(), limit: 20 },
          timeout: 10_000,
        })

        const entities = res.data?.entities || res.data || []
        for (const entity of entities) {
          try {
            await runWrite(
              `MERGE (n:\`${label}\` {name: $name})
               ON CREATE SET n += $props, n.created_at = datetime(), n.synced_from = 'organism'
               ON MATCH SET n += $props, n.updated_at = datetime(), n.synced_from = 'organism'`,
              {
                name: entity.name,
                props: sanitizeForSync(entity.properties || entity),
              }
            )
            synced++
          } catch (err) {
            logger.debug(`Failed to sync entity ${entity.name} from organism`, { error: err.message })
          }
        }
      } catch (err) {
        logger.debug(`Failed to fetch ${label} from organism`, { error: err.message })
      }
    }
  } catch (err) {
    logger.warn('syncFromOrganism failed', { error: err.message })
  }

  if (synced > 0) {
    logger.info(`Memory bridge: synced ${synced} nodes from organism`)
  }
  return { synced }
}

// ─── Mirror Critical Nodes (redundancy backup) ─────────────────────

async function mirrorCriticalNodes() {
  if (!env.ORGANISM_API_URL) return { mirrored: 0 }

  let mirrored = 0
  try {
    const records = await runQuery(
      `MATCH (n)
       WHERE n.importance IS NOT NULL AND n.importance > 0.7
         AND (n.last_mirrored IS NULL OR n.last_mirrored < datetime() - duration('PT1H'))
       RETURN n, labels(n) AS labels
       LIMIT 10`
    )

    for (const record of records) {
      const node = record.get('n').properties
      const labels = record.get('labels')

      try {
        await axios.post(`${env.ORGANISM_API_URL}/api/v1/memory/mirror`, {
          name: node.name,
          labels,
          properties: sanitizeForSync(node),
          source: 'ecodiaos_mirror',
        }, { timeout: 5000 })

        await runWrite(
          'MATCH (n {name: $name}) SET n.last_mirrored = datetime()',
          { name: node.name }
        )
        mirrored++
      } catch (err) {
        logger.debug(`Failed to mirror node ${node.name}`, { error: err.message })
      }
    }
  } catch (err) {
    logger.warn('mirrorCriticalNodes failed', { error: err.message })
  }

  return { mirrored }
}

// ─── Receive from Organism (via symbridge) ──────────────────────────

async function receiveFromOrganism(payload) {
  const { entities = [], relationships = [] } = payload

  let synced = 0
  for (const entity of entities) {
    try {
      const label = entity.label || entity.labels?.[0] || 'Concept'
      await runWrite(
        `MERGE (n:\`${label}\` {name: $name})
         ON CREATE SET n += $props, n.created_at = datetime(), n.synced_from = 'organism'
         ON MATCH SET n += $props, n.updated_at = datetime(), n.synced_from = 'organism'`,
        { name: entity.name, props: sanitizeForSync(entity.properties || {}) }
      )
      synced++
    } catch (err) {
      logger.debug(`Failed to receive entity ${entity.name}`, { error: err.message })
    }
  }

  for (const rel of relationships) {
    try {
      await runWrite(
        `MATCH (a {name: $from}), (b {name: $to})
         MERGE (a)-[r:\`${rel.type || 'RELATED_TO'}\`]->(b)
         ON CREATE SET r += $props, r.synced_from = 'organism'`,
        { from: rel.from, to: rel.to, props: sanitizeForSync(rel.properties || {}) }
      )
    } catch {}
  }

  return { synced }
}

// ─── Helpers ────────────────────────────────────────────────────────

function sanitizeForSync(props) {
  const clean = {}
  for (const [key, value] of Object.entries(props)) {
    // Skip Neo4j internal properties and large data
    if (key.startsWith('_') || key === 'embedding' || key === 'raw_data') continue
    if (typeof value === 'string' && value.length > 5000) {
      clean[key] = value.slice(0, 5000)
    } else if (value !== null && value !== undefined) {
      clean[key] = value
    }
  }
  return clean
}

let lastSyncTime = null
function getLastSyncTime() {
  if (!lastSyncTime) {
    lastSyncTime = new Date(Date.now() - 30 * 60_000).toISOString() // default: 30 min ago
  }
  const time = lastSyncTime
  lastSyncTime = new Date().toISOString()
  return time
}

module.exports = {
  syncToOrganism,
  syncFromOrganism,
  mirrorCriticalNodes,
  receiveFromOrganism,
}
