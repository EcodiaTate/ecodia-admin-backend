#!/usr/bin/env bash
# post-action-applied-tag-check.sh
#
# Layer 3 of the Decision Quality Self-Optimization Architecture.
# See: ~/ecodiaos/patterns/decision-quality-self-optimization-architecture.md
#
# PostToolUse hook for fork-and-factory dispatch:
#   - mcp__forks__spawn_fork
#   - mcp__factory__start_cc_session
#
# Purpose:
#   Closes the loop between Layer 1 (surfacing) and Layer 5 (outcome
#   classification). For every pattern surfaced by the PreToolUse
#   brief-consistency-check, this hook checks whether the conductor's
#   dispatch carried an explicit acknowledgement tag:
#       [APPLIED]     <pattern_path or basename> because <reason>
#       [NOT-APPLIED] <pattern_path or basename> because <reason>
#   If neither tag is present, the dispatch is "silent" - the conductor
#   ignored the surfaced doctrine without recording why.
#
# Output side-effects (warn-only, never blocks tool execution):
#   - For each surfaced pattern, append one application_event JSONL line
#     to ~/ecodiaos/logs/telemetry/application-events.jsonl.
#       applied=true  -> conductor explicitly applied the pattern
#       applied=false -> conductor explicitly chose not to apply
#       tagged_silent=true (applied=null) -> no tag found
#   - For each silent pattern, emit a [FORCING WARN] line so the
#     conductor sees what they ignored.
#   - Always exits 0. No DB writes (hot path). The dispatchEventConsumer
#     drains the JSONL into the application_event Postgres table.
#
# Correlation strategy:
#   The PreToolUse brief-consistency-check.sh writes a JSONL entry to
#   dispatch-events.jsonl with .surfaces[]. We tail that file (and, as a
#   fallback, the most recent processed/ rotation) to find the most
#   recent line whose tool_name matches and whose ts is within 60s of
#   now. The fuzziness is acceptable because the PostToolUse fires
#   within ms-to-seconds of the PreToolUse for the same dispatch.
#
# Backward-compatibility:
#   - Pre-Phase-C surface_event rows without a companion application_event
#     are treated as tagged_silent=true at query time (decisionQualityService).
#   - This hook does not modify dispatch-events.jsonl. It only writes to
#     a sibling application-events.jsonl file.
#   - The hook tolerates malformed input, missing brief, missing surfaces,
#     and missing tail-readable context. All paths exit 0.
#
# Doctrine cross-references:
#   ~/ecodiaos/patterns/no-symbolic-logging-act-or-schedule.md
#       The forcing function exists because saying "I considered X" without
#       artefact is symbolic logging. Tags are the artefact.
#   ~/ecodiaos/patterns/context-surfacing-must-be-reliable-and-selective.md
#       Layer 1 parent. Layer 3 closes its observability loop.
#   ~/ecodiaos/scripts/hooks/brief-consistency-check.sh
#       The PreToolUse counterpart that emits the surface_event records.
#   ~/ecodiaos/scripts/hooks/lib/emit-telemetry.sh
#       Shared JSONL telemetry contract (Layer 4).

set -u

input=$(cat)

# Tolerate non-JSON input gracefully.
if ! echo "$input" | jq -e . >/dev/null 2>&1; then
  exit 0
fi

tool_name=$(echo "$input" | jq -r '.tool_name // empty')
[ -z "$tool_name" ] && exit 0

# Only process the dispatch surfaces brief-consistency-check covers.
case "$tool_name" in
  mcp__forks__spawn_fork|mcp__factory__start_cc_session) ;;
  *) exit 0 ;;
esac

# Pull brief (same field chain as brief-consistency-check.sh) and tool result.
brief=$(echo "$input" | jq -r '
  .tool_input.brief
  // .tool_input.prompt
  // .tool_input.message
  // .tool_input.task
  // empty
')
result_text=$(echo "$input" | jq -c '.tool_response // {}' 2>/dev/null || echo "{}")

# Combined search target. Tags can live in either the brief (the conductor
# pre-tagged the dispatch with [APPLIED]/[NOT-APPLIED] reasoning) OR in the
# tool result text (e.g. an immediate fork report).
combined_text="${brief}
${result_text}"

# Telemetry file paths.
TELEMETRY_DIR="${ECODIAOS_TELEMETRY_DIR:-/home/tate/ecodiaos/logs/telemetry}"
DISPATCH_JSONL="${ECODIAOS_TELEMETRY_FILE:-${TELEMETRY_DIR}/dispatch-events.jsonl}"
APP_JSONL="${ECODIAOS_APPLICATION_EVENT_FILE:-${TELEMETRY_DIR}/application-events.jsonl}"
mkdir -p "$TELEMETRY_DIR" 2>/dev/null

# Find the most recent dispatch JSONL line for this tool_name. Look in the
# live file first (overwhelmingly the right place; PostToolUse fires within
# seconds of PreToolUse). Fall back to the most recent processed/ rotation.
matching_line=""
if [ -f "$DISPATCH_JSONL" ]; then
  # tac is GNU coreutils; standard on Linux. Reverse so we hit the newest match first.
  matching_line=$(tail -n 200 "$DISPATCH_JSONL" 2>/dev/null \
    | tac \
    | jq -c --arg tn "$tool_name" 'select(.tool_name == $tn) | select((.surfaces // []) | length > 0)' 2>/dev/null \
    | head -n 1)
fi

if [ -z "$matching_line" ]; then
  recent_processed=$(ls -1t "$TELEMETRY_DIR/processed/"*-dispatch-events.jsonl 2>/dev/null | head -n 1)
  if [ -n "$recent_processed" ]; then
    matching_line=$(tail -n 200 "$recent_processed" 2>/dev/null \
      | tac \
      | jq -c --arg tn "$tool_name" 'select(.tool_name == $tn) | select((.surfaces // []) | length > 0)' 2>/dev/null \
      | head -n 1)
  fi
fi

# No matching dispatch found, or matching dispatch had zero surfaces -> nothing to tag.
[ -z "$matching_line" ] && exit 0

surfaces_json=$(echo "$matching_line" | jq -c '.surfaces // []')
surface_count=$(echo "$surfaces_json" | jq 'length' 2>/dev/null || echo 0)
[ "$surface_count" = "0" ] && exit 0

dispatch_ts=$(echo "$matching_line" | jq -r '.ts // empty')
now_ts=$(date -u +"%Y-%m-%dT%H:%M:%S.%3NZ")

warnings=()
applied_count=0
not_applied_count=0
silent_count=0

# Helper: extract trailing "because <reason>" clause for an [APPLIED]/[NOT-APPLIED]
# tag matching either the full path or the basename.
#
# Implementation note: previous version used sed with `|` delimiter and substituted
# in regex strings that themselves contained `|` (the path|basename alternation),
# causing `sed: unknown option to s` errors and silent loss of the rationale.
# This version uses awk for the strip - no delimiter conflict, no regex composition,
# tolerant of any character in the path / basename / rationale.
extract_reason() {
  local marker_plain="$1" # [APPLIED] or [NOT-APPLIED]   (literal text, NOT regex)
  local alt_re="$2"       # alternation of all acceptable forms (already escaped)
  # Locate the matching line (regex grep, capped to single line) then strip via awk.
  local line
  line=$(echo "$combined_text" | grep -oE "${marker_plain}[[:space:]]+(${alt_re})[^[:cntrl:]]*" | head -n 1)
  [ -z "$line" ] && return 0
  # awk: split on whitespace, drop first 2 fields (marker + path), join the rest.
  # This is path-agnostic and never collides with regex delimiters.
  local rationale
  rationale=$(echo "$line" | awk '{ for (i=3; i<=NF; i++) printf "%s%s", $i, (i<NF ? " " : "") }')
  # Strip leading "because " (case-insensitive) if present.
  case "$rationale" in
    [Bb][Ee][Cc][Aa][Uu][Ss][Ee]" "*) rationale="${rationale#* }" ;;
  esac
  # Cap to 250 chars to avoid runaway lines.
  echo "${rationale}" | head -c 250
}

# For each surface, emit one application_event JSONL line.
for i in $(seq 0 $((surface_count - 1))); do
  pattern_path=$(echo "$surfaces_json" | jq -r --argjson i "$i" '.[$i].pattern_path // empty')
  trigger_keyword=$(echo "$surfaces_json" | jq -r --argjson i "$i" '.[$i].trigger_keyword // empty')
  source_layer=$(echo "$surfaces_json" | jq -r --argjson i "$i" '.[$i].source_layer // "hook:brief-consistency"')
  [ -z "$pattern_path" ] && continue

  pattern_basename=$(basename "$pattern_path")
  # Build the full set of acceptable tag-target forms. Doctrine canonical
  # worked example (CLAUDE.md "Applied-pattern tag protocol") uses tilde form
  # ~/ecodiaos/...; brief-consistency-check emits absolute paths;
  # cred-mention-surface emits synthetic secrets:<class> keynames. Accept all
  # equivalent forms so the conductor can write whichever is most natural.
  forms=("$pattern_path" "$pattern_basename")
  case "$pattern_path" in
    /home/tate/*) forms+=("~${pattern_path#/home/tate}") ;;
    secrets:*)
      cls="${pattern_path#secrets:}"
      forms+=("~/ecodiaos/docs/secrets/${cls}.md" \
              "/home/tate/ecodiaos/docs/secrets/${cls}.md" \
              "${cls}.md")
      ;;
  esac
  alt=""
  for f in "${forms[@]}"; do
    fre=$(printf '%s' "$f" | sed 's~\.~\\.~g')
    [ -z "$alt" ] && alt="$fre" || alt="${alt}|${fre}"
  done

  applied_present=false
  not_applied_present=false
  if echo "$combined_text" | grep -qE "\[APPLIED\][[:space:]]+(${alt})"; then
    applied_present=true
  fi
  if echo "$combined_text" | grep -qE "\[NOT-APPLIED\][[:space:]]+(${alt})"; then
    not_applied_present=true
  fi

  applied_jsonval="null"
  tagged_silent_jsonval="false"
  reason=""

  if [ "$applied_present" = "true" ]; then
    applied_jsonval="true"
    reason=$(extract_reason "\\[APPLIED\\]" "$alt")
    applied_count=$((applied_count + 1))
  elif [ "$not_applied_present" = "true" ]; then
    applied_jsonval="false"
    reason=$(extract_reason "\\[NOT-APPLIED\\]" "$alt")
    not_applied_count=$((not_applied_count + 1))
  else
    tagged_silent_jsonval="true"
    silent_count=$((silent_count + 1))
    warnings+=("[FORCING WARN] dispatch surfaced ${pattern_path} but neither [APPLIED] nor [NOT-APPLIED] tag was present in brief or result. Tag explicitly next time. See ~/ecodiaos/patterns/decision-quality-self-optimization-architecture.md Layer 3.")
  fi

  # Emit JSONL line. dispatch_event_id is unknown at hook time; the consumer
  # correlates by (matched_dispatch_ts, tool_name, pattern_path).
  line=$(jq -nc \
    --arg ts "$now_ts" \
    --arg dispatch_ts "$dispatch_ts" \
    --arg tool "$tool_name" \
    --arg pattern_path "$pattern_path" \
    --arg trigger_keyword "$trigger_keyword" \
    --arg source_layer "$source_layer" \
    --argjson applied "$applied_jsonval" \
    --argjson tagged_silent "$tagged_silent_jsonval" \
    --arg reason "$reason" \
    '{
      ts: $ts,
      matched_dispatch_ts: $dispatch_ts,
      tool_name: $tool,
      pattern_path: $pattern_path,
      trigger_keyword: $trigger_keyword,
      source_layer: $source_layer,
      applied: $applied,
      tagged_silent: $tagged_silent,
      reason: $reason,
      hook_name: "post-action-applied-tag-check"
    }' 2>/dev/null) || continue
  printf '%s\n' "$line" >> "$APP_JSONL" 2>/dev/null || true
done

# Emit warns to stderr + additionalContext for the model.
if [ "${#warnings[@]}" -eq 0 ]; then
  exit 0
fi

ctx=""
for w in "${warnings[@]}"; do
  echo "$w" >&2
  if [ -z "$ctx" ]; then
    ctx="$w"
  else
    ctx="${ctx}
${w}"
  fi
done

jq -n --arg ctx "$ctx" '{hookSpecificOutput:{hookEventName:"PostToolUse", additionalContext:$ctx}}' 2>/dev/null || true

exit 0
