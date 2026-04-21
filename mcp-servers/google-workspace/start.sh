#!/bin/bash
export GOOGLE_SERVICE_ACCOUNT_JSON="$(grep ^GOOGLE_SERVICE_ACCOUNT_JSON= ~/ecodiaos/.env | sed 's/^GOOGLE_SERVICE_ACCOUNT_JSON=//')"
export GOOGLE_PRIMARY_ACCOUNT="$(grep ^GOOGLE_PRIMARY_ACCOUNT= ~/ecodiaos/.env | sed 's/^GOOGLE_PRIMARY_ACCOUNT=//')"
export SUPABASE_URL="$(grep ^SUPABASE_URL= ~/ecodiaos/.env | sed 's/^SUPABASE_URL=//')"
export SUPABASE_SERVICE_ROLE_KEY="$(grep ^SUPABASE_SERVICE_KEY= ~/ecodiaos/.env | sed 's/^SUPABASE_SERVICE_KEY=//')"
exec node /home/tate/ecodiaos/mcp-servers/google-workspace/index.js
