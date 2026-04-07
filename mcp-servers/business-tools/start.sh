#!/bin/bash
export ECODIA_INTERNAL_TOKEN="$(grep ^ECODIA_INTERNAL_TOKEN= ~/ecodiaos/.env | sed 's/^[^=]*=//' | tr -d '\" ')"
export META_PAGE_TOKEN="$(grep ^META_PAGE_TOKEN= ~/ecodiaos/.env | sed 's/^[^=]*=//' | tr -d '\" ')"
export META_PAGE_ID="$(grep ^META_PAGE_ID= ~/ecodiaos/.env | sed 's/^[^=]*=//' | tr -d '\" ')"
export VERCEL_TOKEN="$(grep ^VERCEL_TOKEN= ~/ecodiaos/.env | sed 's/^[^=]*=//' | tr -d '\" ')"
export VERCEL_TEAM_ID="$(grep ^VERCEL_TEAM_ID= ~/ecodiaos/.env | sed 's/^[^=]*=//' | tr -d '\" ')"
exec node /home/tate/ecodiaos/mcp-servers/business-tools/index.js
