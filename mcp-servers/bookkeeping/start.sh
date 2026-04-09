#!/bin/bash
export BK_API_BASE="http://localhost:3001"
export BK_API_TOKEN="$(grep ^MCP_INTERNAL_TOKEN= ~/ecodiaos/.env | sed 's/^MCP_INTERNAL_TOKEN=//')"
exec node /home/tate/ecodiaos/mcp-servers/bookkeeping/index.js
