#!/bin/bash
export DATABASE_URL="$(grep ^DATABASE_URL= ~/ecodiaos/.env | sed 's/^[^=]*=//' | tr -d '\"')"
export PORT="$(grep ^PORT= ~/ecodiaos/.env | sed 's/^[^=]*=//' | tr -d '\" ')"
exec node /home/tate/ecodiaos/mcp-servers/scheduler/index.js
