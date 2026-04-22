#!/usr/bin/env node
/**
 * Supabase MCP Server — PostgreSQL access + Storage bucket management.
 * Provides read/write SQL, schema introspection, and file storage.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import postgres from 'postgres'
import { createClient } from '@supabase/supabase-js'
import fs from 'fs'
import path from 'path'

// Parse JSON-if-string, pass-through otherwise. Mirrors 35cdb2e (numeric) and 0bec7dd (object).
// On malformed JSON the raw value is passed through so z.array rejects it as a Zod error
// rather than throwing a raw SyntaxError that would crash the MCP server.
const arrayParam = (inner, description) =>
  z.preprocess(
    (v) => {
      if (typeof v !== 'string') return v
      try { return JSON.parse(v) } catch { return v }
    },
    z.array(inner)
  ).describe(description)

const db = postgres(process.env.DATABASE_URL, {
  max: 5,
  idle_timeout: 30,
  max_lifetime: 600,
  connect_timeout: 10,
})

// Supabase Storage client — requires SUPABASE_URL + SUPABASE_SERVICE_KEY
const supabaseUrl = process.env.SUPABASE_URL
const supabaseKey = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_ANON_KEY
const supabase = supabaseUrl && supabaseKey ? createClient(supabaseUrl, supabaseKey) : null

const server = new McpServer({ name: 'supabase', version: '2.0.0' })

// ── Read-only SQL ──

server.tool('db_query', 'Execute a read-only SQL query. Returns rows as JSON. Max 500 rows.', {
  sql: z.string().describe('SQL SELECT query to execute'),
}, async ({ sql }) => {
  const trimmed = sql.trim().replace(/;$/, '')
  const firstWord = trimmed.split(/\s/)[0].toUpperCase()
  if (['INSERT', 'UPDATE', 'DELETE', 'DROP', 'ALTER', 'TRUNCATE', 'CREATE'].includes(firstWord)) {
    return { content: [{ type: 'text', text: 'Error: db_query is read-only. Use db_execute for write operations.' }] }
  }
  try {
    const hasLimit = /\bLIMIT\s+\d+/i.test(trimmed)
    const rows = await db.unsafe(hasLimit ? trimmed : `${trimmed} LIMIT 500`)
    return { content: [{ type: 'text', text: JSON.stringify(rows, null, 2) }] }
  } catch (err) {
    return { content: [{ type: 'text', text: `SQL error: ${err.message}` }] }
  }
})

// ── Write SQL ──

server.tool('db_execute', 'Execute a write SQL statement (INSERT, UPDATE, DELETE). Returns affected rows.', {
  sql: z.string().describe('SQL statement to execute'),
}, async ({ sql }) => {
  const trimmed = sql.trim().replace(/;$/, '')
  const firstWord = trimmed.split(/\s/)[0].toUpperCase()
  if (['DROP', 'TRUNCATE', 'ALTER'].includes(firstWord)) {
    return { content: [{ type: 'text', text: 'Error: DDL operations (DROP, TRUNCATE, ALTER) are not allowed.' }] }
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

server.tool('db_list_tables', 'List all tables with their columns.', {}, async () => {
  const tables = await db`
    SELECT t.table_name,
           array_agg(c.column_name || ' ' || c.data_type ORDER BY c.ordinal_position) AS columns
    FROM information_schema.tables t
    JOIN information_schema.columns c ON t.table_name = c.table_name AND t.table_schema = c.table_schema
    WHERE t.table_schema = 'public' AND t.table_type = 'BASE TABLE'
    GROUP BY t.table_name
    ORDER BY t.table_name
  `
  return { content: [{ type: 'text', text: JSON.stringify(tables.map(t => ({ table: t.table_name, columns: t.columns })), null, 2) }] }
})

server.tool('db_describe_table', 'Get detailed schema for a specific table.', {
  table: z.string().describe('Table name'),
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

// ── Storage tools ──

server.tool('storage_upload', 'Upload a file to a Supabase Storage bucket. Returns the public URL.', {
  bucket: z.string().describe('Bucket name (e.g. "documents", "images"). Created if it does not exist.'),
  path: z.string().describe('Path inside the bucket, e.g. "invoices/invoice-001.pdf"'),
  localPath: z.string().optional().describe('Absolute path to a local file on the VPS to upload'),
  content: z.string().optional().describe('Raw file content as a string (for text/HTML files)'),
  contentType: z.string().optional().describe('MIME type, e.g. "application/pdf", "text/html". Defaults to text/plain.'),
  public: z.boolean().optional().describe('Make the file publicly accessible. Default true.'),
}, async ({ bucket, path: filePath, localPath, content, contentType, public: makePublic = true }) => {
  if (!supabase) return { content: [{ type: 'text', text: 'Error: SUPABASE_URL or SUPABASE_SERVICE_KEY not configured.' }] }
  try {
    // Ensure bucket exists (upsert)
    await supabase.storage.createBucket(bucket, { public: makePublic }).catch(() => {})

    let fileData
    let mimeType = contentType || 'text/plain'

    if (localPath) {
      fileData = fs.readFileSync(localPath)
      if (!contentType) {
        const ext = path.extname(localPath).toLowerCase()
        const mimeMap = { '.pdf': 'application/pdf', '.html': 'text/html', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.csv': 'text/csv', '.json': 'application/json', '.txt': 'text/plain' }
        mimeType = mimeMap[ext] || 'application/octet-stream'
      }
    } else if (content) {
      fileData = Buffer.from(content, 'utf8')
    } else {
      return { content: [{ type: 'text', text: 'Error: provide either localPath or content.' }] }
    }

    const { error } = await supabase.storage.from(bucket).upload(filePath, fileData, {
      contentType: mimeType,
      upsert: true,
    })
    if (error) return { content: [{ type: 'text', text: `Storage error: ${error.message}` }] }

    const { data: urlData } = supabase.storage.from(bucket).getPublicUrl(filePath)
    return { content: [{ type: 'text', text: JSON.stringify({ url: urlData.publicUrl, bucket, path: filePath, contentType: mimeType }) }] }
  } catch (err) {
    return { content: [{ type: 'text', text: `Upload failed: ${err.message}` }] }
  }
})

server.tool('storage_get_url', 'Get the public or signed download URL for a file in Supabase Storage.', {
  bucket: z.string().describe('Bucket name'),
  path: z.string().describe('File path inside the bucket'),
  signed: z.boolean().optional().describe('Generate a signed URL (expires in 1 hour) instead of public URL'),
}, async ({ bucket, path: filePath, signed }) => {
  if (!supabase) return { content: [{ type: 'text', text: 'Error: SUPABASE_URL or SUPABASE_SERVICE_KEY not configured.' }] }
  try {
    if (signed) {
      const { data, error } = await supabase.storage.from(bucket).createSignedUrl(filePath, 3600)
      if (error) return { content: [{ type: 'text', text: `Error: ${error.message}` }] }
      return { content: [{ type: 'text', text: JSON.stringify({ url: data.signedUrl, expiresIn: '1h' }) }] }
    }
    const { data } = supabase.storage.from(bucket).getPublicUrl(filePath)
    return { content: [{ type: 'text', text: JSON.stringify({ url: data.publicUrl }) }] }
  } catch (err) {
    return { content: [{ type: 'text', text: `Error: ${err.message}` }] }
  }
})

server.tool('storage_list', 'List files in a Supabase Storage bucket folder.', {
  bucket: z.string().describe('Bucket name'),
  folder: z.string().optional().describe('Folder path to list. Empty for root.'),
}, async ({ bucket, folder }) => {
  if (!supabase) return { content: [{ type: 'text', text: 'Error: SUPABASE_URL or SUPABASE_SERVICE_KEY not configured.' }] }
  try {
    const { data, error } = await supabase.storage.from(bucket).list(folder || '')
    if (error) return { content: [{ type: 'text', text: `Error: ${error.message}` }] }
    return { content: [{ type: 'text', text: JSON.stringify(data) }] }
  } catch (err) {
    return { content: [{ type: 'text', text: `Error: ${err.message}` }] }
  }
})

server.tool('storage_delete', 'Delete one or more files from a Supabase Storage bucket.', {
  bucket: z.string().describe('Bucket name'),
  paths: arrayParam(z.string(), 'Array of file paths to delete'),
}, async ({ bucket, paths }) => {
  if (!supabase) return { content: [{ type: 'text', text: 'Error: SUPABASE_URL or SUPABASE_SERVICE_KEY not configured.' }] }
  try {
    const { error } = await supabase.storage.from(bucket).remove(paths)
    if (error) return { content: [{ type: 'text', text: `Error: ${error.message}` }] }
    return { content: [{ type: 'text', text: `Deleted ${paths.length} file(s) from ${bucket}.` }] }
  } catch (err) {
    return { content: [{ type: 'text', text: `Error: ${err.message}` }] }
  }
})

const transport = new StdioServerTransport()
await server.connect(transport)
