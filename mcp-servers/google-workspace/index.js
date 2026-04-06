#!/usr/bin/env node
/**
 * Google Workspace MCP Server — Gmail + Calendar + Drive
 * Uses service account with Domain-Wide Delegation.
 *
 * Required env vars:
 *   GOOGLE_SERVICE_ACCOUNT_JSON — full service account JSON key
 *   GOOGLE_PRIMARY_ACCOUNT — email to impersonate (e.g. tate@ecodia.au)
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { registerGmailTools } from './gmail.js'
import { registerCalendarTools } from './calendar.js'
import { registerDriveTools } from './drive.js'

const server = new McpServer({
  name: 'google-workspace',
  version: '1.0.0',
})

registerGmailTools(server)
registerCalendarTools(server)
registerDriveTools(server)

const transport = new StdioServerTransport()
await server.connect(transport)
