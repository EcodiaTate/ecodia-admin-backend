#!/bin/bash
export TWILIO_ACCOUNT_SID="$(grep ^TWILIO_ACCOUNT_SID ~/ecodiaos/.env | sed 's/^[^=]*=//' | tr -d '\" ')"
export TWILIO_AUTH_TOKEN="$(grep ^TWILIO_AUTH_TOKEN ~/ecodiaos/.env | sed 's/^[^=]*=//' | tr -d '\" ')"
export TWILIO_FROM_NUMBER="$(grep ^TWILIO_FROM_NUMBER ~/ecodiaos/.env | sed 's/^[^=]*=//' | tr -d '\" ')"
exec node /home/tate/ecodiaos/mcp-servers/sms/index.js
