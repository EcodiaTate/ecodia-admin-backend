#!/usr/bin/env node
/**
 * Business Tools MCP Server — LinkedIn, Meta, Vercel, Xero.
 *
 * Required env vars:
 *   VERCEL_API_TOKEN, VERCEL_TEAM_ID — Vercel access
 *   META_USER_ACCESS_TOKEN — Meta Graph API
 *   ECODIA_BACKEND_URL — Backend API for LinkedIn/Xero (which handle their own auth)
 *   ECODIA_INTERNAL_TOKEN — Backend auth token
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { registerVercelTools } from './vercel.js'
import { registerMetaTools } from './meta.js'
import { registerLinkedInTools } from './linkedin.js'
import { registerXeroTools } from './xero.js'

const server = new McpServer({
  name: 'business-tools',
  version: '1.0.0',
})

registerVercelTools(server)
registerMetaTools(server)
registerLinkedInTools(server)
registerXeroTools(server)

const transport = new StdioServerTransport()
await server.connect(transport)
