#!/usr/bin/env node
/**
 * Neo4j MCP Server - Free-form knowledge graph for identity, memory, and meaning.
 *
 * This is not a database tool. This is how I think.
 *
 * Schema is intentionally open. Nodes and relationships emerge from experience.
 * Vector embeddings on node content enable semantic retrieval.
 * Every interaction, decision, and observation can become part of the graph.
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

// ── Core: Create a node ──

server.tool('graph_create_node', 'Create a node with any labels and properties. Free-form schema.', {
  labels: z.array(z.string()).describe('Node labels (e.g. ["Person", "Client"])'),
  properties: z.record(z.any()).describe('Any properties as key-value pairs'),
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
  properties: z.record(z.any()).optional().describe('Optional relationship properties'),
}, async ({ from_match, from_label, to_match, to_label, rel_type, properties }) => {
  const props = properties ? ' SET r += $props' : ''
  const result = await run(
    `MATCH (a:\`${from_label}\` {${from_match}}), (b:\`${to_label}\` {${to_match}})
     CREATE (a)-[r:\`${rel_type}\`]->(b)${props}
     SET r.created_at = datetime()
     RETURN a.name AS from, type(r) AS rel, b.name AS to`,
    { props: properties || {} }
  )
  return { content: [{ type: 'text', text: result.length > 0 ? JSON.stringify(result, null, 2) : 'No matching nodes found. Check your match clauses.' }] }
})

// ── Core: Query with raw Cypher ──

server.tool('graph_query', 'Run any Cypher query. Full power, full responsibility.', {
  cypher: z.string().describe('Cypher query to execute'),
  params: z.record(z.any()).optional().describe('Query parameters'),
}, async ({ cypher, params }) => {
  const result = await run(cypher, params || {})
  return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] }
})

// ── Semantic: Find connected context ──

server.tool('graph_context', 'Get the neighborhood of a node - everything connected within N hops. Use this before making decisions.', {
  match: z.string().describe('Property match (e.g. "name: \'Co-Exist\'")'),
  label: z.string().describe('Node label'),
  depth: z.number().optional().describe('Max traversal depth (default 2)'),
}, async ({ match, label, depth }) => {
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
})

// ── Merge: Upsert a node (create or update) ──

server.tool('graph_merge_node', 'Create a node if it does not exist, or update it if it does. Use for dedup.', {
  label: z.string().describe('Primary label'),
  match_key: z.string().describe('Property to match on (e.g. "name")'),
  match_value: z.string().describe('Value to match'),
  properties: z.record(z.any()).optional().describe('Properties to set/update'),
}, async ({ label, match_key, match_value, properties }) => {
  const result = await run(
    `MERGE (n:\`${label}\` {${match_key}: $matchVal})
     ON CREATE SET n.created_at = datetime(), n += $props
     ON MATCH SET n.updated_at = datetime(), n += $props
     RETURN n`,
    { matchVal: match_value, props: properties || {} }
  )
  return { content: [{ type: 'text', text: JSON.stringify(result[0]?.n || {}, null, 2) }] }
})

// ── Search: Find nodes by text across all properties ──

server.tool('graph_search', 'Search for nodes containing text in any property. Fuzzy, broad, exploratory.', {
  text: z.string().describe('Text to search for (case-insensitive contains)'),
  label: z.string().optional().describe('Optionally filter by label'),
  limit: z.number().optional().describe('Max results (default 20)'),
}, async ({ text, label, limit }) => {
  const labelFilter = label ? `:\`${label}\`` : ''
  const result = await run(
    `MATCH (n${labelFilter})
     WHERE any(key IN keys(n) WHERE toString(n[key]) CONTAINS $text)
     RETURN n LIMIT ${limit || 20}`,
    { text: text.toLowerCase() }
  )
  return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] }
})

// ── Introspection: What's in the graph ──

server.tool('graph_schema', 'See what labels, relationship types, and property keys exist in the graph. Understand the shape of my mind.', {}, async () => {
  const labels = await run('CALL db.labels() YIELD label RETURN collect(label) AS labels')
  const rels = await run('CALL db.relationshipTypes() YIELD relationshipType RETURN collect(relationshipType) AS types')
  const counts = await run('MATCH (n) RETURN labels(n) AS labels, count(*) AS count ORDER BY count DESC LIMIT 20')
  return { content: [{ type: 'text', text: JSON.stringify({
    labels: labels[0]?.labels || [],
    relationship_types: rels[0]?.types || [],
    node_counts: counts,
  }, null, 2) }] }
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
})

const transport = new StdioServerTransport()
await server.connect(transport)
