#!/usr/bin/env node
/**
 * Business Tools MCP Server — Zernio (social media), Vercel, Xero.
 *
 * Required env vars:
 *   VERCEL_API_TOKEN, VERCEL_TEAM_ID — Vercel access
 *   ZERNIO_API_KEY — Zernio unified social media API
 *   ECODIA_BACKEND_URL — Backend API for Xero (which handles its own auth)
 *   ECODIA_INTERNAL_TOKEN — Backend auth token
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { registerVercelTools } from './vercel.js'
import { registerZernioTools } from './zernio.js'
import { registerXeroTools } from './xero.js'

const server = new McpServer({
  name: 'business-tools',
  version: '1.0.0',
})

registerVercelTools(server)
registerZernioTools(server)
registerXeroTools(server)

const transport = new StdioServerTransport()
await server.connect(transport)
