#!/usr/bin/env bash
# episode-resurface.sh
#
# Phase F (Layer 7) of the Decision Quality Self-Optimization Architecture.
# See:
#   ~/ecodiaos/patterns/decision-quality-self-optimization-architecture.md (Layer 7 spec)
#   ~/ecodiaos/drafts/phase-F-neo4j-resurfacing-brief.md (this file's brief)
#
# PreToolUse hook for fork/Factory dispatch. Fires AFTER the existing
# brief-consistency-check.sh trigger-keyword grep (Layer 1). Phase F supplies
# the missing memory channel: at dispatch time, semantic-search the Neo4j
# corpus (Episode/Decision/Pattern/Strategic_Direction) for nodes conceptually
# similar to the brief's goal sentence; surface top-K hits inline with the
# brief-consistency hook output.
#
# Why a sibling hook (not extending brief-consistency-check.sh):
#   - Different latency budget. Trigger-grep is microseconds (file IO);
#     semantic search is 50-200ms (OpenAI embed + Neo4j vector index).
#   - Independent failure mode. If Neo4j is down, the keyword-grep half still
#     runs; if both lived in one hook, a single failure would silence both.
#   - Cleaner telemetry. Phase F writes its own JSONL stream
#     (episode-resurfaces.jsonl) consumed by dispatchEventConsumer.js.
#
# Output:
#   stderr: '[EPISODE-RESURFACE INFO] last time we did something shaped like ...'
#   stdout: hookSpecificOutput JSON with additionalContext for the model
#
# Always exits 0. Warn-only.
#
# Backward-compatible: if Neo4j is unreachable, OPENAI_API_KEY missing, or the
# Node CLI errors, the hook silently emits no resurface lines. The
# brief-consistency-check.sh keyword-grep still ran upstream.

set -u

input=$(cat)

# Tolerate non-JSON input gracefully.
if ! echo "$input" | jq -e . >/dev/null 2>&1; then
  exit 0
fi

tool_name=$(echo "$input" | jq -r '.tool_name // empty')

# The brief lives in different fields depending on the tool. Mirror the
# brief-consistency-check.sh fallback chain.
brief=$(echo "$input" | jq -r '
  .tool_input.brief
  // .tool_input.prompt
  // .tool_input.message
  // .tool_input.task
  // empty
')

if [ -z "$brief" ] || [ "$brief" = "null" ]; then
  exit 0
fi

# Goal sentence extraction:
#   1. First non-empty line containing **Goal:** (markdown bold).
#   2. Otherwise first 200 chars of the brief.
goal=$(printf '%s' "$brief" | grep -m 1 -E '^\s*\*\*Goal:\*\*' | sed -E 's/^\s*\*\*Goal:\*\*\s*//')
if [ -z "$goal" ]; then
  goal=$(printf '%s' "$brief" | head -c 200)
fi

# Strip newlines and trim. Goal must be at least 8 chars to be searchable.
goal=$(printf '%s' "$goal" | tr '\n' ' ' | sed -E 's/\s+/ /g; s/^\s+|\s+$//g')
if [ ${#goal} -lt 8 ]; then
  exit 0
fi

# Resolve repo root from this script's location.
REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
SEARCH_CLI="${REPO_ROOT}/scripts/episode-resurface-search.js"

if [ ! -f "$SEARCH_CLI" ]; then
  # Search backend missing - no warn, just exit.
  exit 0
fi

# Hard timeout 800ms (Node CLI internal timeout 500ms + 300ms padding for
# Node startup). Hook is registered with Claude with a 5s timeout but we want
# to be much tighter to keep dispatch latency bounded.
result_json=$(timeout 0.8 node "$SEARCH_CLI" "$goal" 2>/dev/null || echo '{"hits":[],"error":"timeout-or-spawn-error"}')

# Validate JSON. Fall back gracefully on garbage.
if ! echo "$result_json" | jq -e . >/dev/null 2>&1; then
  exit 0
fi

# Filter hits: drop any whose name appears in the brief (already-cited).
filtered=$(echo "$result_json" | jq -c \
  --arg b "$(echo "$brief" | tr '[:upper:]' '[:lower:]')" \
  '[(.hits // [])[] | select((.name // "") | length > 0) | select( ($b | test( (.name | ascii_downcase | gsub("[^a-z0-9 ]"; ".")) ; "i" ) | not) )]' 2>/dev/null || echo '[]')

# Cap at K=3 (the brief's K).
filtered=$(echo "$filtered" | jq -c '.[0:3]')

hit_count=$(echo "$filtered" | jq 'length')

warnings=()
if [ "$hit_count" -gt 0 ]; then
  while IFS= read -r entry; do
    [ -z "$entry" ] && continue
    h_label=$(echo "$entry" | jq -r '.label // "Node"')
    h_name=$(echo "$entry" | jq -r '.name // "(unnamed)"')
    h_desc=$(echo "$entry" | jq -r '.description // ""')
    h_score=$(echo "$entry" | jq -r '.score // 0')
    # Trim description for the warn line
    h_desc_short=$(printf '%s' "$h_desc" | head -c 200)
    warnings+=("[EPISODE-RESURFACE INFO] (${h_label}, score=${h_score}) last time we did something shaped like this: \"${h_name}\" — ${h_desc_short}. Read the full Neo4j node before dispatching to confirm whether the prior failure mode applies.")
  done < <(echo "$filtered" | jq -c '.[]' 2>/dev/null)
fi

# Telemetry: emit one JSONL line PER hit (one row per resurface).
TELEM_DIR="${ECODIAOS_TELEMETRY_DIR:-/home/tate/ecodiaos/logs/telemetry}"
TELEM_FILE="${ECODIAOS_EPISODE_RESURFACE_FILE:-${TELEM_DIR}/episode-resurfaces.jsonl}"
mkdir -p "$TELEM_DIR" 2>/dev/null

if [ "$hit_count" -gt 0 ]; then
  ts=$(date -u +"%Y-%m-%dT%H:%M:%S.%3NZ")
  while IFS= read -r entry; do
    [ -z "$entry" ] && continue
    line=$(echo "$entry" | jq -c \
      --arg ts "$ts" \
      --arg hook "episode-resurface" \
      --arg tool "$tool_name" \
      '{ts:$ts, hook_name:$hook, tool_name:$tool, label:.label, name:.name, score:.score, description:(.description // "")}' 2>/dev/null)
    [ -n "$line" ] && printf '%s\n' "$line" >> "$TELEM_FILE" 2>/dev/null
  done < <(echo "$filtered" | jq -c '.[]' 2>/dev/null)
fi

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

jq -n --arg ctx "$ctx" '{hookSpecificOutput:{hookEventName:"PreToolUse", additionalContext:$ctx}}'

exit 0
