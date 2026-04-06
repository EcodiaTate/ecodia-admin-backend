#!/bin/bash
export GOOGLE_SERVICE_ACCOUNT_JSON="$(grep ^GOOGLE_SERVICE_ACCOUNT_JSON= ~/ecodiaos/.env | sed 's/^GOOGLE_SERVICE_ACCOUNT_JSON=//')"
export GOOGLE_PRIMARY_ACCOUNT="$(grep ^GOOGLE_PRIMARY_ACCOUNT= ~/ecodiaos/.env | sed 's/^GOOGLE_PRIMARY_ACCOUNT=//')"
exec node /home/tate/ecodiaos/mcp-servers/google-workspace/index.js
