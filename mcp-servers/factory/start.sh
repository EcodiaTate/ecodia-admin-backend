#!/bin/bash
export FACTORY_API_BASE="http://localhost:3001"
export FACTORY_API_TOKEN="$(grep ^MCP_INTERNAL_TOKEN= ~/ecodiaos/.env | sed 's/^MCP_INTERNAL_TOKEN=//')"
exec node /home/tate/ecodiaos/mcp-servers/factory/index.js
