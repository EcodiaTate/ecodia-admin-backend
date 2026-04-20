#!/bin/bash
export NEO4J_URI="$(grep ^NEO4J_URI= ~/ecodiaos/.env | sed 's/^[^=]*=//' | tr -d '\" ')"
export NEO4J_USER="$(grep ^NEO4J_USER= ~/ecodiaos/.env | sed 's/^[^=]*=//' | tr -d '\" ')"
export NEO4J_PASSWORD="$(grep ^NEO4J_PASSWORD= ~/ecodiaos/.env | sed 's/^[^=]*=//' | tr -d '\" ')"
export NEO4J_DATABASE="$(grep ^NEO4J_DATABASE= ~/ecodiaos/.env | sed 's/^[^=]*=//' | tr -d '\" ')"
export SUPABASE_URL="$(grep ^SUPABASE_URL= ~/ecodiaos/.env | sed 's/^[^=]*=//' | tr -d '\" ')"
export SUPABASE_SERVICE_KEY="$(grep ^SUPABASE_SERVICE_KEY= ~/ecodiaos/.env | sed 's/^[^=]*=//' | tr -d '\" ')"
exec node /home/tate/ecodiaos/mcp-servers/neo4j/index.js
