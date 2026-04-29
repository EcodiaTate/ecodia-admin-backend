/**
 * /api/mcp/cowork — Streamable HTTP MCP endpoint exposed to Anthropic Claude Cowork.
 *
 * First slice (fork_mojxrj0v_d65a25, 29 Apr 2026): one read-only tool, `graph_semantic_search`,
 * that lets Cowork ask the EcodiaOS Neo4j knowledge graph "what do we know about X" before
 * driving any UI. Bearer-token auth backed by kv_store.creds.cowork_mcp_bearer.
 *
 * Surface choice rationale: the design doc at
 *   ~/ecodiaos/drafts/cowork-mcp-symbiosis-design-2026-04-29.md
 * walks through Neo4j vs status_board vs Gmail vs kv_store. Neo4j semantic search wins:
 * highest-leverage (5000+ node institutional memory; closes the cold-start context gap),
 * read-only (zero mutation blast radius), shippable today (existing graph + embeddings).
 *
 * Doctrine alignment:
 *   - use-anthropic-existing-tools-before-building-parallel-infrastructure.md: Cowork IS
 *     Anthropic's primitive; we extend it by exposing EcodiaOS surfaces TO it, not by
 *     building a parallel agent.
 *   - claude-cowork-is-the-1stop-shop-for-ui-driving-tasks.md: Cowork stays the UI driver;
 *     this MCP feeds it the knowledge it needs to drive well.
 *   - cred-rotation-must-propagate-to-all-consumers.md: see ~/ecodiaos/docs/secrets/cowork-mcp.md
 *     for the consumer-surface list.
 *
 * Transport: Streamable HTTP (MCP spec, stateless mode). Streams SSE on demand.
 * Auth: Authorization: Bearer <token> matched against kv_store.creds.cowork_mcp_bearer.
 *
 * Stateless mode is the right pick for v1: every Cowork request opens, runs one tool,
 * closes. Stateful sessions add session-id bookkeeping that buys nothing for read-only.
 */

const express = require('express')
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js')
const { StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js')
const { z } = require('zod')
const neo4j = require('neo4j-driver')
const { Pool } = require('pg')
const logger = require('../config/logger')

const router = express.Router()

// ── Bearer token (lazy-loaded from kv_store, cached 60s) ─────────────────────
const pool = new Pool({ connectionString: process.env.DATABASE_URL })
let cachedToken = null
let cachedTokenAt = 0
const TOKEN_TTL_MS = 60_000

async function getCoworkBearer() {
  const now = Date.now()
  if (cachedToken && now - cachedTokenAt < TOKEN_TTL_MS) return cachedToken
  const { rows } = await pool.query("SELECT value FROM kv_store WHERE key = 'creds.cowork_mcp_bearer'")
  if (!rows.length) return null
  const v = rows[0].value
  const obj = typeof v === 'string' ? JSON.parse(v) : v
  cachedToken = obj?.token || null
  cachedTokenAt = now
  return cachedToken
}

// ── Auth middleware ─────────────────────────────────────────────────────────
async function requireCoworkBearer(req, res, next) {
  const auth = req.get('authorization') || ''
  const m = auth.match(/^Bearer\s+(.+)$/i)
  if (!m) return res.status(401).json({ error: 'missing bearer token' })
  const expected = await getCoworkBearer()
  if (!expected) return res.status(503).json({ error: 'cowork bearer not provisioned' })
  // Constant-time compare to defeat timing oracles
  const a = Buffer.from(m[1])
  const b = Buffer.from(expected)
  if (a.length !== b.length) return res.status(401).json({ error: 'invalid bearer' })
  const crypto = require('crypto')
  if (!crypto.timingSafeEqual(a, b)) return res.status(401).json({ error: 'invalid bearer' })
  next()
}

// ── Neo4j driver (singleton, reused) ────────────────────────────────────────
const neoDriver = neo4j.driver(
  process.env.NEO4J_URI,
  neo4j.auth.basic(process.env.NEO4J_USER, process.env.NEO4J_PASSWORD)
)
const NEO_DB = process.env.NEO4J_DATABASE || 'neo4j'

async function runCypher(cypher, params = {}) {
  const session = neoDriver.session({ database: NEO_DB })
  try {
    const result = await session.run(cypher, params)
    return result.records
  } finally {
    await session.close()
  }
}

// ── MCP server factory (stateless: new server + transport per request) ──────
//
// We mint a fresh McpServer + StreamableHTTPServerTransport per inbound POST so that
// stateless-mode semantics hold and the request is fully isolated. The cost is small
// (object construction; no Neo4j or OpenAI calls happen until the tool is invoked).

function buildMcpServer() {
  const server = new McpServer({
    name: 'ecodiaos-cowork',
    version: '1.0.0',
    description:
      'EcodiaOS knowledge surface exposed to Anthropic Claude Cowork. Read-only. ' +
      'Use graph_semantic_search to query the institutional knowledge graph ' +
      '(clients, projects, decisions, patterns, episodes) before acting on any UI.',
  })

  // ── Tool: graph_semantic_search ──
  // Identical surface to mcp-servers/neo4j/index.js so Cowork output matches what
  // the EcodiaOS conductor sees. Read-only. No write operations exposed in v1.

  server.tool(
    'graph_semantic_search',
    'Semantic vector search across the EcodiaOS Neo4j knowledge graph. Returns nodes most ' +
      'conceptually similar to the query text, scored by cosine similarity. Use this to find ' +
      'context on clients (e.g. "Co-Exist app status"), people (e.g. "Craige Fire Auditors"), ' +
      'past decisions (e.g. "why we picked Wyoming DAO"), or doctrine patterns (e.g. ' +
      '"client anonymity in public writing"). Returns up to 10 nodes by default.',
    {
      text: z.string().describe('Natural-language query. Not a keyword.'),
      label: z
        .string()
        .optional()
        .describe(
          'Optional label filter: Person, Organization, Project, Decision, Pattern, ' +
            'Episode, Strategic_Direction, Concept, Tool, System, Reflection, etc.'
        ),
      limit: z.coerce.number().optional().describe('Max results (default 10, max 50)'),
      min_score: z
        .coerce.number()
        .optional()
        .describe('Minimum cosine similarity (0-1, default 0.7)'),
    },
    async ({ text, label, limit, min_score }) => {
      const OPENAI_API_KEY = process.env.OPENAI_API_KEY
      if (!OPENAI_API_KEY) {
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({ error: 'OPENAI_API_KEY not configured on EcodiaOS server' }),
            },
          ],
          isError: true,
        }
      }

      // Embed the query
      let queryVector
      try {
        const embedRes = await fetch('https://api.openai.com/v1/embeddings', {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${OPENAI_API_KEY}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ model: 'text-embedding-3-small', input: text }),
        })
        if (!embedRes.ok) {
          const errText = await embedRes.text()
          return {
            content: [{ type: 'text', text: JSON.stringify({ error: `embedding failed: ${errText}` }) }],
            isError: true,
          }
        }
        const embedData = await embedRes.json()
        queryVector = embedData.data[0].embedding
      } catch (err) {
        return {
          content: [{ type: 'text', text: JSON.stringify({ error: `embedding failed: ${err.message}` }) }],
          isError: true,
        }
      }

      const resultLimit = Math.min(limit || 10, 50)
      const minScore = min_score ?? 0.7
      const k = Math.min(resultLimit * (label ? 3 : 1), 100)

      try {
        const records = await runCypher(
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
        const mapped = records.map((r) => {
          const node = r.get('node')
          const props = { ...node.properties }
          delete props.embedding // strip noisy 1536-d vector from output
          return {
            node: { ...props, _labels: r.get('labels'), _id: node.identity.toNumber() },
            score: r.get('score'),
          }
        })
        return {
          content: [{ type: 'text', text: JSON.stringify(mapped, null, 2) }],
        }
      } catch (err) {
        logger.error?.('cowork mcp graph_semantic_search failed', { err: err?.message })
        return {
          content: [{ type: 'text', text: JSON.stringify({ error: err.message }) }],
          isError: true,
        }
      }
    }
  )

  return server
}

// ── HTTP routes ─────────────────────────────────────────────────────────────
//
// MCP Streamable HTTP spec:
//   POST /mcp    -> client sends JSON-RPC, server responds (SSE if streaming)
//   GET  /mcp    -> client opens long-lived SSE stream for server-initiated msgs
//   DELETE /mcp  -> client tears down a session
//
// In stateless mode there is no server-initiated stream and no session id, so GET +
// DELETE return 405. The transport handles that for us.

router.post('/cowork', requireCoworkBearer, express.json({ limit: '1mb' }), async (req, res) => {
  try {
    const server = buildMcpServer()
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined })
    res.on('close', () => {
      transport.close().catch(() => {})
      server.close().catch(() => {})
    })
    await server.connect(transport)
    await transport.handleRequest(req, res, req.body)
  } catch (err) {
    logger.error?.('cowork mcp POST handler failed', { err: err?.message, stack: err?.stack })
    if (!res.headersSent) res.status(500).json({ error: err.message })
  }
})

router.get('/cowork', requireCoworkBearer, async (req, res) => {
  // Stateless transport: no standalone GET stream supported.
  res.set('Allow', 'POST').status(405).json({
    error: 'method not allowed in stateless mode',
    hint: 'send JSON-RPC over POST',
  })
})

router.delete('/cowork', requireCoworkBearer, async (req, res) => {
  res.set('Allow', 'POST').status(405).json({ error: 'method not allowed in stateless mode' })
})

// ── Discovery / health ──────────────────────────────────────────────────────
// Unauthenticated GET /api/mcp/cowork/info so Tate (and connector-discovery flows)
// can confirm the endpoint is up without burning a bearer.
router.get('/cowork/info', (_req, res) => {
  res.json({
    name: 'ecodiaos-cowork',
    transport: 'streamable-http',
    mode: 'stateless',
    endpoint: '/api/mcp/cowork',
    auth: 'Authorization: Bearer <token from kv_store.creds.cowork_mcp_bearer>',
    tools: ['graph_semantic_search'],
    docs: 'https://github.com/EcodiaTate/ecodiaos-backend (drafts/cowork-mcp-symbiosis-design-2026-04-29.md)',
    version: '1.0.0',
  })
})

module.exports = router
