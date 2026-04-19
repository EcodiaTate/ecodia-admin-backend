#!/usr/bin/env bash
# EcodiaOS API Watchdog
# Post-mortem: Apr 15-19 2026 -- PM2 exhausted max_restarts, api silent for 4 days.
# Runs every 60s via systemd timer, independent of PM2.
#
# Happy path:  curl health -> 2xx JSON -> update timestamp -> exit 0
# Blip path:   unhealthy for < 5 min -> log and exit 0
# Alert path:  unhealthy for >= 5 min -> pm2 restart -> wait 30s -> recheck
#              still down -> SMS Tate via Twilio (rate-limited to 1 per 30 min)

set -eu

BASE_DIR="/home/tate/ecodiaos"
API_URL="http://localhost:3001/api/health"
HEALTHY_FILE="${BASE_DIR}/.watchdog-last-healthy"
SMS_FILE="${BASE_DIR}/.watchdog-last-sms"
LOG_FILE="${BASE_DIR}/logs/watchdog.log"
TATE_NUMBER="+61404247153"
SMS_BODY="EcodiaOS api is down. Watchdog tried pm2 restart, still unhealthy. SSH in: ssh tate@170.64.170.191"
BLIP_SECS=300    # 5 min -- transient blip threshold
SMS_COOLDOWN=1800 # 30 min -- alert rate limit

mkdir -p "$(dirname "${LOG_FILE}")"

log() {
  printf '{"ts":"%s","action":"%s","outcome":"%s"}\n' \
    "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "${1}" "${2}" >> "${LOG_FILE}"
}

check_health() {
  local tmp http_status ok
  tmp=$(mktemp)
  http_status=$(curl -s --max-time 10 -o "${tmp}" -w "%{http_code}" "${API_URL}" 2>/dev/null || echo "000")
  ok=1
  if [[ "${http_status}" =~ ^2 ]] && jq -e . "${tmp}" > /dev/null 2>&1; then
    ok=0
  fi
  rm -f "${tmp}"
  return ${ok}
}

send_sms() {
  local now last_sms
  now=$(date +%s)
  if [[ -f "${SMS_FILE}" ]]; then
    last_sms=$(cat "${SMS_FILE}")
    if (( now - last_sms < SMS_COOLDOWN )); then
      log "sms_skipped" "cooldown"
      return 0
    fi
  fi

  [[ -f "${BASE_DIR}/.env" ]] || { log "sms_failed" "no_env_file"; return 0; }

  local sid auth from
  sid=$(grep -E '^TWILIO_ACCOUNT_SID=' "${BASE_DIR}/.env" | head -1 | cut -d= -f2-)
  auth=$(grep -E '^TWILIO_AUTH_TOKEN=' "${BASE_DIR}/.env" | head -1 | cut -d= -f2-)
  from=$(grep -E '^TWILIO_FROM_NUMBER=' "${BASE_DIR}/.env" | head -1 | cut -d= -f2-)
  # Strip surrounding quotes if present
  sid="${sid%\"}"; sid="${sid#\"}"; sid="${sid%\'}"; sid="${sid#\'}"
  auth="${auth%\"}"; auth="${auth#\"}"; auth="${auth%\'}"; auth="${auth#\'}"
  from="${from%\"}"; from="${from#\"}"; from="${from%\'}"; from="${from#\'}"

  [[ -n "${sid}" && -n "${auth}" && -n "${from}" ]] || { log "sms_failed" "missing_creds"; return 0; }

  local http_status
  http_status=$(curl -s -o /dev/null -w "%{http_code}" --max-time 30 \
    -X POST "https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json" \
    -u "${sid}:${auth}" \
    --data-urlencode "To=${TATE_NUMBER}" \
    --data-urlencode "From=${from}" \
    --data-urlencode "Body=${SMS_BODY}" 2>/dev/null || echo "000")

  if [[ "${http_status}" =~ ^2 ]]; then
    echo "${now}" > "${SMS_FILE}"
    log "sms_sent" "http_${http_status}"
  else
    log "sms_failed" "http_${http_status}"
  fi
}

# -- Main ------------------------------------------------------------------

now=$(date +%s)

if check_health; then
  echo "${now}" > "${HEALTHY_FILE}"
  exit 0
fi

# Unhealthy -- how long has it been?
last_healthy=0
[[ -f "${HEALTHY_FILE}" ]] && last_healthy=$(cat "${HEALTHY_FILE}")
gap=$(( now - last_healthy ))

if (( gap < BLIP_SECS )); then
  log "unhealthy_blip" "gap=${gap}s"
  exit 0
fi

# Sustained failure -- restart PM2
log "restarting" "gap=${gap}s"
pm2 restart ecodia-api 2>/dev/null || log "pm2_failed" "restart_error"
sleep 30

if check_health; then
  echo "$(date +%s)" > "${HEALTHY_FILE}"
  log "recovered" "healthy_after_restart"
  exit 0
fi

# Still down -- alert Tate
log "alert" "still_unhealthy_after_restart"
send_sms
exit 1
