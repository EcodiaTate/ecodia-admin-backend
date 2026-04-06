#!/bin/bash
export DATABASE_URL="$(grep ^DATABASE_URL= ~/ecodiaos/.env | sed 's/^DATABASE_URL=//')"
exec node /home/tate/ecodiaos/mcp-servers/supabase/index.js
