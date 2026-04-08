#!/bin/bash
export DATABASE_URL="$(grep ^DATABASE_URL= ~/ecodiaos/.env | sed 's/^DATABASE_URL=//')"
export SUPABASE_URL="$(grep ^SUPABASE_URL= ~/ecodiaos/.env | sed 's/^SUPABASE_URL=//')"
export SUPABASE_SERVICE_KEY="$(grep ^SUPABASE_SERVICE_KEY= ~/ecodiaos/.env | sed 's/^SUPABASE_SERVICE_KEY=//')"
exec node /home/tate/ecodiaos/mcp-servers/supabase/index.js
