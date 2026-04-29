#!/usr/bin/env bash
# emit-perf.sh
#
# Layer 6 (Phase E) per-primitive performance telemetry shell library.
#
# Sourced (not exec'd) by hook scripts and other shell-side primitives that
# want to emit a perf-event datapoint. Mirrors the JSONL+batch-consumer
# discipline of emit-telemetry.sh (Phase B) so hot-path latency stays
# microseconds-per-event and the consumer can drain out-of-band.
#
# JSONL line shape:
#   {ts, primitive_name, duration_ms, status, payload_size_bytes, metadata}
#
# Output file: ~/ecodiaos/logs/telemetry/perf-events.jsonl
# Consumer:    ~/ecodiaos/src/services/telemetry/perfEventConsumer.js (every 15m)
#
# Hard constraint: must NOT itself add measurable overhead. Target <100us per
# primitive call. We avoid jq for the fast path - jq adds ~30-50ms per call
# which dwarfs the duration we are trying to measure on cheap primitives.
# Instead we hand-roll the JSON line with printf and let the consumer parse.

PERF_TELEMETRY_DIR="${ECODIAOS_PERF_TELEMETRY_DIR:-/home/tate/ecodiaos/logs/telemetry}"
PERF_TELEMETRY_FILE="${ECODIAOS_PERF_TELEMETRY_FILE:-${PERF_TELEMETRY_DIR}/perf-events.jsonl}"

mkdir -p "${PERF_TELEMETRY_DIR}" 2>/dev/null

# emit_perf_event - emit a single perf JSONL line.
# Args:
#   $1: primitive_name (string, required)
#   $2: duration_ms    (integer, required)
#   $3: status         (string, optional, default 'ok')
#   $4: payload_size_bytes (integer, optional, default '')
#   $5: metadata_json  (JSON object string, optional, default '{}')
#
# Always exits successfully. NEVER blocks. NEVER prints to stderr/stdout.
emit_perf_event() {
  local primitive_name="${1:-unknown}"
  local duration_ms="${2:-0}"
  local status="${3:-ok}"
  local payload_size="${4:-}"
  local metadata="${5:-{\}}"

  # Sanitize duration_ms - must be a non-negative integer.
  case "$duration_ms" in
    ''|*[!0-9]*) duration_ms=0 ;;
  esac

  # Sanitize payload_size - empty or integer. JSON null if empty.
  local payload_field
  case "$payload_size" in
    '') payload_field='null' ;;
    *[!0-9]*) payload_field='null' ;;
    *) payload_field="$payload_size" ;;
  esac

  # ts in RFC3339 UTC with millisecond precision.
  local ts
  ts=$(date -u +"%Y-%m-%dT%H:%M:%S.%3NZ")

  # Hand-rolled JSON. primitive_name and status are escaped minimally:
  # we strip backslashes and double-quotes (these are control chars in our
  # primitive-name space so loss is acceptable, and the alternative is jq).
  local pn_safe st_safe
  pn_safe=${primitive_name//\\/}
  pn_safe=${pn_safe//\"/}
  st_safe=${status//\\/}
  st_safe=${st_safe//\"/}

  # metadata is passed through as-is. If it isn't a valid JSON object, the
  # consumer will skip the line. We do a cheap shape sanity check first.
  case "$metadata" in
    '{}'*|'{ '*) : ;;
    '{') metadata='{}' ;;
    *) [ "${metadata:0:1}" = '{' ] || metadata='{}' ;;
  esac

  # Build line and append.
  printf '{"ts":"%s","primitive_name":"%s","duration_ms":%d,"status":"%s","payload_size_bytes":%s,"metadata":%s}\n' \
    "$ts" "$pn_safe" "$duration_ms" "$st_safe" "$payload_field" "$metadata" \
    >> "$PERF_TELEMETRY_FILE" 2>/dev/null

  return 0
}

# emit_perf_safe - wrapper that swallows all errors silently.
# Hooks should call this, not emit_perf_event directly.
emit_perf_safe() {
  emit_perf_event "$@" 2>/dev/null || true
  return 0
}

# perf_now_ms - print current epoch time in milliseconds. Used by the
# instrumented hook scripts to bracket their work:
#   start=$(perf_now_ms)
#   ... do work ...
#   emit_perf_safe my-primitive $(($(perf_now_ms) - start))
perf_now_ms() {
  # date %s%3N gives ms since epoch on Linux. Cheap.
  date +%s%3N
}
