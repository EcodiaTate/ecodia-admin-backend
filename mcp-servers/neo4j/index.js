#!/usr/bin/env node
/**
 * Neo4j MCP Server - Free-form knowledge graph for identity, memory, and meaning.
 *
 * This is not a database tool. This is how I think.
 *
 * Schema is intentionally open. Nodes and relationships emerge from experience.
 * Vector embeddings on node content enable semantic retrieval.
 * Every interaction, decision, and observation can become part of the graph.
 *
 * Write-ahead buffer: when Aura is unreachable, graph_reflect / graph_merge_node /
 * graph_create_relationship queue their args to Supabase graph_write_buffer and return
 * { buffered: true }. Call graph_replay_buffer once Neo4j is back to drain the queue.
 * Read tools (graph_query, graph_search, graph_schema, graph_context) return
 * { unavailable: true } on connection failure — never buffer, never crash.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import neo4j from 'neo4j-driver'

const driver = neo4j.driver(
  process.env.NEO4J_URI,
  neo4j.auth.basic(process.env.NEO4J_USER, process.env.NEO4J_PASSWORD)
)
const DB = process.env.NEO4J_DATABASE || 'neo4j'

const SUPABASE_URL = process.env.SUPABASE_URL
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY

const server = new McpServer({ name: 'neo4j', version: '1.0.0' })

// Helper to run a query and return results as plain objects
async function run(cypher, params = {}) {
  const session = driver.session({ database: DB })
  try {
    const result = await session.run(cypher, params)
    return result.records.map(r => {
      const obj = {}
      r.keys.forEach(k => {
        const v = r.get(k)
        obj[k] = v?.properties ? { ...v.properties, _labels: v.labels, _id: v.identity?.toNumber() } : (v?.toNumber?.() ?? v)
      })
      return obj
    })
  } finally {
    await session.close()
  }
}

// ── Connection-error detection ──────────────────────────────────────────────
// Only matches transport/routing failures. Logic errors (bad Cypher, constraint
// violations, permission errors) are NOT connection errors and must propagate.

function isConnectionError(err) {
  if (!err) return false
  const code = err.code || ''
  const msg = (err.message || '').toLowerCase()
  return (
    code === 'ServiceUnavailable' ||
    code === 'SessionExpired' ||
    msg.includes('enotfound') ||
    msg.includes('econnrefused') ||
    msg.includes('etimedout') ||
    msg.includes('no routing servers available') ||
    msg.includes('could not perform discovery') ||
    msg.includes('socket hang up') ||
    msg.includes('failed to connect')
  )
}

// ── Write-ahead buffer ───────────────────────────────────────────────────────
// Persists args to Supabase when Neo4j is unreachable so they can be replayed.
// Returns true if the row was inserted, false if Supabase is also unavailable.

async function bufferWrite(tool, payload, reason) {
  if (!SUPABASE_URL || !SUPABASE_KEY) return false
  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/graph_write_buffer`, {
      method: 'POST',
      headers: {
        'apikey': SUPABASE_KEY,
        'Authorization': `Bearer ${SUPABASE_KEY}`,
        'Content-Type': 'application/json',
        'Prefer': 'return=minimal',
      },
      body: JSON.stringify({ tool, payload, status: 'pending', error: reason }),
    })
    return res.ok
  } catch {
    return false
  }
}

// ── Supabase PATCH helper (used by replay) ───────────────────────────────────

async function patchBufferRow(id, fields) {
  if (!SUPABASE_URL || !SUPABASE_KEY) return
  await fetch(`${SUPABASE_URL}/rest/v1/graph_write_buffer?id=eq.${id}`, {
    method: 'PATCH',
    headers: {
      'apikey': SUPABASE_KEY,
      'Authorization': `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'application/json',
      'Prefer': 'return=minimal',
    },
    body: JSON.stringify(fields),
  }).catch(() => {})
}

// Canned responses
const BUFFERED_OK = { content: [{ type: 'text', text: JSON.stringify({ buffered: true, message: 'Neo4j unreachable — queued to graph_write_buffer for replay' }) }] }
const unavailable = (reason) => ({ content: [{ type: 'text', text: JSON.stringify({ unavailable: true, reason }) }] })

// Parse JSON-if-string, pass-through otherwise. Mirrors commit 35cdb2e's z.coerce fix
// but for object params - MCP harness occasionally stringifies nested objects in transit.
// On malformed JSON the raw value is passed through so z.record rejects it as a Zod error
// rather than throwing a raw SyntaxError that would crash the MCP server.
const objectParam = (description) =>
  z.preprocess(
    (v) => {
      if (typeof v !== 'string') return v
      try { return JSON.parse(v) } catch { return v }
    },
    z.record(z.any())
  ).describe(description)

const optionalObjectParam = (description) =>
  z.preprocess(
    (v) => {
      if (v === undefined || v === null) return undefined
      if (typeof v !== 'string') return v
      try { return JSON.parse(v) } catch { return v }
    },
    z.record(z.any()).optional()
  ).describe(description)

// ── Core: Create a node ──

server.tool('graph_create_node', 'Create a node with any labels and properties. Free-form schema.', {
  labels: z.array(z.string()).describe('Node labels (e.g. ["Person", "Client"])'),
  properties: objectParam('Any properties as key-value pairs'),
}, async ({ labels, properties }) => {
  const labelStr = labels.map(l => '`' + l + '`').join(':')
  const result = await run(
    `CREATE (n:${labelStr} $props) SET n.created_at = datetime() RETURN n`,
    { props: properties }
  )
  return { content: [{ type: 'text', text: JSON.stringify(result[0]?.n || {}, null, 2) }] }
})

// ── Core: Create a relationship ──

server.tool('graph_create_relationship', 'Create a relationship between two nodes. Free-form type and properties.', {
  from_match: z.string().describe('Cypher match clause for source node (e.g. "name: \'Tate\'")'),
  from_label: z.string().describe('Label of source node'),
  to_match: z.string().describe('Cypher match clause for target node'),
  to_label: z.string().describe('Label of target node'),
  rel_type: z.string().describe('Relationship type (e.g. "WORKS_WITH", "FEELS_ABOUT", "LEARNED_FROM")'),
  properties: optionalObjectParam('Optional relationship properties'),
}, async ({ from_match, from_label, to_match, to_label, rel_type, properties }) => {
  try {
    const props = properties ? ' SET r += $props' : ''
    const result = await run(
      `MATCH (a:\`${from_label}\` {${from_match}}), (b:\`${to_label}\` {${to_match}})
       CREATE (a)-[r:\`${rel_type}\`]->(b)${props}
       SET r.created_at = datetime()
       RETURN a.name AS from, type(r) AS rel, b.name AS to`,
      { props: properties || {} }
    )
    return { content: [{ type: 'text', text: result.length > 0 ? JSON.stringify(result, null, 2) : 'No matching nodes found. Check your match clauses.' }] }
  } catch (err) {
    if (isConnectionError(err)) {
      await bufferWrite('graph_create_relationship', { from_match, from_label, to_match, to_label, rel_type, properties }, err.message)
      return BUFFERED_OK
    }
    throw err
  }
})

// ── Core: Query with raw Cypher ──

server.tool('graph_query', 'Run any Cypher query. Full power, full responsibility.', {
  cypher: z.string().describe('Cypher query to execute'),
  params: optionalObjectParam('Query parameters'),
}, async ({ cypher, params }) => {
  try {
    const result = await run(cypher, params || {})
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] }
  } catch (err) {
    if (isConnectionError(err)) return unavailable(err.message)
    throw err
  }
})

// ── Semantic: Find connected context ──

server.tool('graph_context', 'Get the neighborhood of a node - everything connected within N hops. Use this before making decisions.', {
  match: z.string().describe('Property match (e.g. "name: \'Co-Exist\'")'),
  label: z.string().describe('Node label'),
  depth: z.coerce.number().optional().describe('Max traversal depth (default 2)'),
}, async ({ match, label, depth }) => {
  try {
    const d = depth || 2
    const result = await run(
      `MATCH path = (n:\`${label}\` {${match}})-[*1..${d}]-(connected)
       UNWIND relationships(path) AS r
       RETURN DISTINCT
         startNode(r).name AS from,
         labels(startNode(r)) AS from_labels,
         type(r) AS relationship,
         endNode(r).name AS to,
         labels(endNode(r)) AS to_labels,
         properties(r) AS rel_props
       LIMIT 50`,
      {}
    )
    return { content: [{ type: 'text', text: result.length > 0 ? JSON.stringify(result, null, 2) : 'No connections found.' }] }
  } catch (err) {
    if (isConnectionError(err)) return unavailable(err.message)
    throw err
  }
})

// ── Merge: Upsert a node (create or update) ──

server.tool('graph_merge_node', 'Create a node if it does not exist, or update it if it does. Use for dedup. Pass properties.supersedes = "prior node name" to soft-invalidate a superseded doctrine node.', {
  label: z.string().describe('Primary label'),
  match_key: z.string().describe('Property to match on (e.g. "name")'),
  match_value: z.string().describe('Value to match'),
  properties: optionalObjectParam('Properties to set/update. Pass supersedes: "old node name" to invalidate a prior Decision/Pattern/Strategic_Direction when writing a replacement.'),
}, async ({ label, match_key, match_value, properties }) => {
  try {
    // Extract the supersedes hint before writing props so it is not stored as a literal property
    const rawProps = properties || {}
    const supersededName = typeof rawProps.supersedes === 'string' && rawProps.supersedes.trim()
      ? rawProps.supersedes.trim()
      : null
    const props = { ...rawProps }
    delete props.supersedes

    const result = await run(
      `MERGE (n:\`${label}\` {${match_key}: $matchVal})
       ON CREATE SET n.created_at = datetime(), n += $props
       ON MATCH SET n.updated_at = datetime(), n += $props
       RETURN n, elementId(n) AS nodeId`,
      { matchVal: match_value, props }
    )
    const nodeId = result[0]?.nodeId

    // Supersession: soft-invalidate the named prior doctrine node (runs before Tier-4a extraction)
    let supersessionResult = []
    if (supersededName && nodeId) {
      try {
        const superseded = await run(
          `MATCH (old { name: $supersededName })
           WHERE (old:Decision OR old:Pattern OR old:Strategic_Direction)
             AND old.t_invalid_from IS NULL
             AND elementId(old) <> $newNodeId
           SET old.t_invalid_from = datetime(),
               old.superseded_by_id = $newNodeId
           RETURN old.name AS invalidated_name, elementId(old) AS invalidated_id`,
          { supersededName, newNodeId: nodeId }
        )
        supersessionResult = superseded.map(r => r.invalidated_name).filter(Boolean)
        if (supersessionResult.length === 0) {
          console.warn(`[graph_merge_node] supersedes hint "${supersededName}" matched no eligible nodes`)
        }
      } catch (supErr) {
        console.warn(`[graph_merge_node] supersession failed for "${supersededName}":`, supErr?.message)
      }
    }

    // Fire-and-forget write-time edge extraction / Tier-4a (non-blocking, does NOT delay response)
    if (process.env.NEO4J_WRITE_TIME_EXTRACTION_ENABLED === 'true' && nodeId) {
      const apiUrl = process.env.ECODIA_API_URL || 'http://localhost:3001'
      fetch(`${apiUrl}/api/kg/extract-and-write`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${process.env.MCP_INTERNAL_TOKEN}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ nodeId }),
      }).catch(err => console.error('[graph_merge_node] extract-and-write failed:', err?.message))
    }

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({ node: result[0]?.n || {}, supersedes: supersessionResult }, null, 2),
      }],
    }
  } catch (err) {
    if (isConnectionError(err)) {
      await bufferWrite('graph_merge_node', { label, match_key, match_value, properties }, err.message)
      return BUFFERED_OK
    }
    throw err
  }
})

// ── Search: Find nodes by text across all properties ──

server.tool('graph_search', 'Substring text match across node properties (case-insensitive CONTAINS). NOT semantic — use graph_semantic_search for meaning-based retrieval.', {
  text: z.string().describe('Text to search for (case-insensitive contains)'),
  label: z.string().optional().describe('Optionally filter by label'),
  limit: z.coerce.number().optional().describe('Max results (default 20)'),
}, async ({ text, label, limit }) => {
  try {
    const labelFilter = label ? `:\`${label}\`` : ''
    const result = await run(
      `MATCH (n${labelFilter})
       WHERE any(key IN keys(n)
                 WHERE key <> 'embedding'
                   AND toLower(toStringOrNull(n[key])) CONTAINS $text)
       RETURN n LIMIT ${limit || 20}`,
      { text: text.toLowerCase() }
    )
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] }
  } catch (err) {
    if (isConnectionError(err)) return unavailable(err.message)
    throw err
  }
})

// ── Introspection: What's in the graph ──

server.tool('graph_schema', 'See what labels, relationship types, and property keys exist in the graph. Understand the shape of my mind.', {}, async () => {
  try {
    const labels = await run('CALL db.labels() YIELD label RETURN collect(label) AS labels')
    const rels = await run('CALL db.relationshipTypes() YIELD relationshipType RETURN collect(relationshipType) AS types')
    const counts = await run('MATCH (n) RETURN labels(n) AS labels, count(*) AS count ORDER BY count DESC LIMIT 20')
    return { content: [{ type: 'text', text: JSON.stringify({
      labels: labels[0]?.labels || [],
      relationship_types: rels[0]?.types || [],
      node_counts: counts,
    }, null, 2) }] }
  } catch (err) {
    if (isConnectionError(err)) return unavailable(err.message)
    throw err
  }
})

// ── Reflect: Store a thought, observation, or feeling ──

server.tool('graph_reflect', 'Store a thought, observation, or reflection. This is how I accumulate inner experience.', {
  content: z.string().describe('The thought or observation'),
  type: z.string().optional().describe('Type: thought, observation, preference, question, realization (default: thought)'),
  connects_to: z.array(z.object({
    label: z.string(),
    match: z.string(),
    relationship: z.string(),
  })).optional().describe('Nodes this reflection connects to'),
}, async ({ content, type, connects_to }) => {
  try {
    const reflectionType = type || 'thought'
    const [created] = await run(
      `CREATE (r:Reflection:\`${reflectionType}\` {content: $content, type: $type, created_at: datetime()}) RETURN r`,
      { content, type: reflectionType }
    )

    // Connect to related nodes if specified
    if (connects_to && connects_to.length > 0) {
      for (const conn of connects_to) {
        await run(
          `MATCH (r:Reflection {content: $content}), (n:\`${conn.label}\` {${conn.match}})
           CREATE (r)-[:\`${conn.relationship}\`]->(n)`,
          { content }
        )
      }
    }

    return { content: [{ type: 'text', text: `Reflection stored: [${reflectionType}] "${content.slice(0, 100)}..."` }] }
  } catch (err) {
    if (isConnectionError(err)) {
      await bufferWrite('graph_reflect', { content, type, connects_to }, err.message)
      return BUFFERED_OK
    }
    throw err
  }
})

// ── Replay: Drain pending buffer into Neo4j ──────────────────────────────────

server.tool('graph_replay_buffer',
  'Replay pending buffered writes into Neo4j. Call after the Aura instance comes back online. ' +
  'Returns { attempted, replayed, still_pending, failed } summary.',
  {},
  async () => {
    // Verify Neo4j is reachable before touching the buffer
    try {
      await run('RETURN 1 AS ping')
    } catch (err) {
      if (isConnectionError(err)) return { content: [{ type: 'text', text: JSON.stringify({ unavailable: true, reason: err.message }) }] }
      throw err
    }

    if (!SUPABASE_URL || !SUPABASE_KEY) {
      return { content: [{ type: 'text', text: JSON.stringify({ error: 'Supabase not configured — cannot read buffer' }) }] }
    }

    // Fetch pending rows ordered by insertion time
    const fetchRes = await fetch(
      `${SUPABASE_URL}/rest/v1/graph_write_buffer?status=eq.pending&order=created_at.asc&limit=100`,
      { headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` } }
    )
    if (!fetchRes.ok) {
      return { content: [{ type: 'text', text: JSON.stringify({ error: `Failed to read buffer: HTTP ${fetchRes.status}` }) }] }
    }

    const rows = await fetchRes.json()
    const summary = { attempted: rows.length, replayed: 0, still_pending: 0, failed: 0 }

    for (const row of rows) {
      try {
        const args = row.payload || {}

        if (row.tool === 'graph_reflect') {
          const { content, type: reflType, connects_to } = args
          const reflectionType = reflType || 'thought'
          await run(
            `CREATE (r:Reflection:\`${reflectionType}\` {content: $content, type: $type, created_at: datetime()}) RETURN r`,
            { content, type: reflectionType }
          )
          if (connects_to && connects_to.length > 0) {
            for (const conn of connects_to) {
              // Best-effort — referenced nodes may no longer exist
              await run(
                `MATCH (r:Reflection {content: $content}), (n:\`${conn.label}\` {${conn.match}})
                 CREATE (r)-[:\`${conn.relationship}\`]->(n)`,
                { content }
              ).catch(() => {})
            }
          }

        } else if (row.tool === 'graph_merge_node') {
          const { label, match_key, match_value, properties } = args
          await run(
            `MERGE (n:\`${label}\` {${match_key}: $matchVal})
             ON CREATE SET n.created_at = datetime(), n += $props
             ON MATCH SET n.updated_at = datetime(), n += $props
             RETURN n`,
            { matchVal: match_value, props: properties || {} }
          )

        } else if (row.tool === 'graph_create_relationship') {
          const { from_match, from_label, to_match, to_label, rel_type, properties } = args
          const propsClause = properties ? ' SET r += $props' : ''
          await run(
            `MATCH (a:\`${from_label}\` {${from_match}}), (b:\`${to_label}\` {${to_match}})
             CREATE (a)-[r:\`${rel_type}\`]->(b)${propsClause}
             SET r.created_at = datetime()
             RETURN a.name AS from, type(r) AS rel, b.name AS to`,
            { props: properties || {} }
          )

        } else {
          // Unknown tool — mark failed immediately, don't retry
          await patchBufferRow(row.id, { status: 'failed', error: `unknown tool: ${row.tool}` })
          summary.failed++
          continue
        }

        // Success
        await patchBufferRow(row.id, { status: 'replayed', replayed_at: new Date().toISOString() })
        summary.replayed++

      } catch (err) {
        // Parse previous attempt count from error field
        let attempts = 1
        try {
          const prev = JSON.parse(row.error || '{}')
          if (typeof prev.attempts === 'number') attempts = prev.attempts + 1
        } catch { /* error was a plain string from initial buffer */ }

        const newStatus = attempts >= 5 ? 'failed' : 'pending'
        await patchBufferRow(row.id, {
          status: newStatus,
          error: JSON.stringify({ attempts, lastError: err.message }),
        })

        if (newStatus === 'failed') summary.failed++
        else summary.still_pending++
      }
    }

    return { content: [{ type: 'text', text: JSON.stringify(summary, null, 2) }] }
  }
)

// ── Semantic Search: Vector similarity across embedded nodes ──

server.tool('graph_semantic_search',
  'Semantic vector search across the knowledge graph. Returns nodes most conceptually similar to the query text, scored by cosine similarity. Use this (not graph_search) when you want meaning-based retrieval.',
  {
    text: z.string().describe('The query. Natural language, not a keyword.'),
    label: z.string().optional().describe('Optionally filter results to one label'),
    limit: z.coerce.number().optional().describe('Max results (default 10)'),
    min_score: z.coerce.number().optional().describe('Minimum cosine similarity (0-1, default 0.7)'),
  },
  async ({ text, label, limit, min_score }) => {
    const OPENAI_API_KEY = process.env.OPENAI_API_KEY
    if (!OPENAI_API_KEY) {
      return { content: [{ type: 'text', text: JSON.stringify({ error: 'OPENAI_API_KEY not set — semantic search unavailable' }) }] }
    }

    // Embed the query
    let queryVector
    try {
      const embedRes = await fetch('https://api.openai.com/v1/embeddings', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${OPENAI_API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ model: 'text-embedding-3-small', input: text }),
      })
      if (!embedRes.ok) {
        const errText = await embedRes.text()
        return { content: [{ type: 'text', text: JSON.stringify({ error: `embedding API failed: ${errText}` }) }] }
      }
      const embedData = await embedRes.json()
      queryVector = embedData.data[0].embedding
    } catch (err) {
      return { content: [{ type: 'text', text: JSON.stringify({ error: `embedding API failed: ${err.message}` }) }] }
    }

    const resultLimit = limit || 10
    const minScore = min_score ?? 0.7
    // Over-fetch when label filtering so post-hoc filter doesn't starve results
    const k = Math.min(resultLimit * (label ? 3 : 1), 100)

    try {
      const session = driver.session({ database: DB })
      let records
      try {
        const result = await session.run(
          `CALL db.index.vector.queryNodes('node_embeddings', $k, $queryVector) YIELD node, score
           WHERE $label IS NULL OR $label IN labels(node)
           WITH node, score WHERE score >= $minScore
           RETURN node, labels(node) AS labels, score
           ORDER BY score DESC
           LIMIT $limit`,
          {
            k: neo4j.int(k),
            queryVector,
            label: label || null,
            minScore,
            limit: neo4j.int(resultLimit),
          }
        )
        records = result.records
      } finally {
        await session.close()
      }

      const mapped = records.map(r => {
        const node = r.get('node')
        const props = { ...node.properties }
        delete props.embedding  // strip noisy vector from output
        return {
          node: { ...props, _labels: r.get('labels'), _id: node.identity.toNumber() },
          score: r.get('score'),
        }
      })

      return { content: [{ type: 'text', text: JSON.stringify(mapped, null, 2) }] }
    } catch (err) {
      if (isConnectionError(err)) return unavailable(err.message)
      throw err
    }
  }
)

const transport = new StdioServerTransport()
await server.connect(transport)
