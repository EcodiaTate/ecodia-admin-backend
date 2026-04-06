#!/usr/bin/env node
/**
 * Supabase MCP Server — Direct PostgreSQL access to EcodiaOS database.
 * Provides read/write SQL + schema introspection.
 *
 * Required env vars:
 *   DATABASE_URL — PostgreSQL connection string
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import postgres from 'postgres'

const db = postgres(process.env.DATABASE_URL, {
  max: 5,
  idle_timeout: 30,
  max_lifetime: 600,
  connect_timeout: 10,
})

const server = new McpServer({
  name: 'supabase',
  version: '1.0.0',
})

// ── Read-only SQL ──

server.tool('db_query', {
  description: 'Execute a read-only SQL query against the EcodiaOS PostgreSQL database. Returns rows as JSON. Use for SELECT queries. Max 500 rows returned.',
  inputSchema: {
    type: 'object',
    properties: {
      sql: { type: 'string', description: 'SQL SELECT query to execute' },
    },
    required: ['sql'],
  },
}, async ({ sql }) => {
  const trimmed = sql.trim().replace(/;$/, '')
  // Basic safety: reject obviously destructive statements in the read-only tool
  const firstWord = trimmed.split(/\s/)[0].toUpperCase()
  if (['INSERT', 'UPDATE', 'DELETE', 'DROP', 'ALTER', 'TRUNCATE', 'CREATE'].includes(firstWord)) {
    return { content: [{ type: 'text', text: 'Error: db_query is read-only. Use db_execute for write operations.' }] }
  }
  try {
    const rows = await db.unsafe(`${trimmed} LIMIT 500`)
    return { content: [{ type: 'text', text: JSON.stringify(rows, null, 2) }] }
  } catch (err) {
    return { content: [{ type: 'text', text: `SQL error: ${err.message}` }] }
  }
})

// ── Write SQL ──

server.tool('db_execute', {
  description: 'Execute a write SQL statement (INSERT, UPDATE, DELETE). Returns affected row count or returning clause results.',
  inputSchema: {
    type: 'object',
    properties: {
      sql: { type: 'string', description: 'SQL statement to execute' },
    },
    required: ['sql'],
  },
}, async ({ sql }) => {
  const trimmed = sql.trim().replace(/;$/, '')
  const firstWord = trimmed.split(/\s/)[0].toUpperCase()
  if (['DROP', 'TRUNCATE', 'ALTER'].includes(firstWord)) {
    return { content: [{ type: 'text', text: 'Error: DDL operations (DROP, TRUNCATE, ALTER) are not allowed through this tool.' }] }
  }
  try {
    const result = await db.unsafe(trimmed)
    const count = result.count ?? result.length ?? 0
    if (result.length > 0 && typeof result[0] === 'object') {
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] }
    }
    return { content: [{ type: 'text', text: `OK. ${count} row(s) affected.` }] }
  } catch (err) {
    return { content: [{ type: 'text', text: `SQL error: ${err.message}` }] }
  }
})

// ── Schema introspection ──

server.tool('db_list_tables', {
  description: 'List all tables in the database with their columns. Useful for understanding the schema.',
  inputSchema: {
    type: 'object',
    properties: {},
  },
}, async () => {
  const tables = await db`
    SELECT t.table_name,
           array_agg(c.column_name || ' ' || c.data_type ORDER BY c.ordinal_position) AS columns
    FROM information_schema.tables t
    JOIN information_schema.columns c ON t.table_name = c.table_name AND t.table_schema = c.table_schema
    WHERE t.table_schema = 'public' AND t.table_type = 'BASE TABLE'
    GROUP BY t.table_name
    ORDER BY t.table_name
  `
  const result = tables.map(t => ({
    table: t.table_name,
    columns: t.columns,
  }))
  return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] }
})

server.tool('db_describe_table', {
  description: 'Get detailed schema for a specific table including column types, nullability, defaults, and constraints.',
  inputSchema: {
    type: 'object',
    properties: {
      table: { type: 'string', description: 'Table name' },
    },
    required: ['table'],
  },
}, async ({ table }) => {
  const columns = await db`
    SELECT column_name, data_type, is_nullable, column_default, character_maximum_length
    FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = ${table}
    ORDER BY ordinal_position
  `
  const constraints = await db`
    SELECT tc.constraint_name, tc.constraint_type, kcu.column_name,
           ccu.table_name AS foreign_table, ccu.column_name AS foreign_column
    FROM information_schema.table_constraints tc
    JOIN information_schema.key_column_usage kcu ON tc.constraint_name = kcu.constraint_name
    LEFT JOIN information_schema.constraint_column_usage ccu ON tc.constraint_name = ccu.constraint_name
      AND tc.constraint_type = 'FOREIGN KEY'
    WHERE tc.table_schema = 'public' AND tc.table_name = ${table}
  `
  return { content: [{ type: 'text', text: JSON.stringify({ table, columns, constraints }, null, 2) }] }
})

const transport = new StdioServerTransport()
await server.connect(transport)
