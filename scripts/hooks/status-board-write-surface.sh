#!/usr/bin/env bash
# status-board-write-surface.sh
#
# PreToolUse hook for mcp__supabase__db_execute. When the SQL targets the
# status_board table (INSERT INTO status_board / UPDATE status_board), parses
# the row's name + status + next_action + context text, runs the same trigger-
# keyword index used by brief-consistency-check.sh / cred-mention-surface.sh,
# and emits [STATUS-BOARD-CONTEXT SUGGEST] warnings (never blocks) so the model
# considers reading the relevant doctrine before completing the write.
#
# Implements the meta-pattern in:
#   ~/ecodiaos/patterns/context-surfacing-must-be-reliable-and-selective.md
#
# Behaviour:
#   1. Filter to mcp__supabase__db_execute. Other tools - exit 0.
#   2. Pull SQL string. Skip unless it contains "INTO status_board" or
#      "UPDATE status_board" (case-insensitive).
#   3. Use the SQL as the keyword-scan haystack (the row's name, status,
#      next_action, context strings will all appear in the SQL literal text).
#   4. Walk the doctrine corpus (patterns/, clients/, docs/secrets/, docs/),
#      extract triggers: lines, and for each trigger keyword found in the SQL
#      that does NOT already reference the owning file by basename or path,
#      emit one warn (capped at 5).
#   5. Exit 0 always.
#
# Warn-only. Hook never delays the write. Trigger-tightening is the lever for
# false-positive class warnings.
#
# Output:
#   stderr: '[STATUS-BOARD-CONTEXT SUGGEST] row matches trigger ... in <file>
#            - consider reading before this write.'
#   stdout: hookSpecificOutput JSON with additionalContext for the model

set -u

input=$(cat)

if ! echo "$input" | jq -e . >/dev/null 2>&1; then
  exit 0
fi

tool_name=$(echo "$input" | jq -r '.tool_name // empty')
[ "$tool_name" = "mcp__supabase__db_execute" ] || exit 0

# Pull SQL from any of the standard slot names.
sql=$(echo "$input" | jq -r '
  .tool_input.sql
  // .tool_input.query
  // .tool_input.statement
  // empty
')

if [ -z "$sql" ] || [ "$sql" = "null" ]; then
  exit 0
fi

# Filter: only fire when the SQL targets status_board.
if ! echo "$sql" | grep -qiE '(insert[[:space:]]+into[[:space:]]+status_board|update[[:space:]]+status_board)'; then
  exit 0
fi

# Length cap on the SQL we scan. status_board rows are small; keep grep cheap.
sql_truncated=$(printf '%s' "$sql" | head -c 50000)

DOCTRINE_DIRS=(
  "/home/tate/ecodiaos/patterns"
  "/home/tate/ecodiaos/clients"
  "/home/tate/ecodiaos/docs/secrets"
  "/home/tate/ecodiaos/docs"
)

WARN_CAP=5

surface_warns=()
surface_count=0
declare -A seen_files

for dir in "${DOCTRINE_DIRS[@]}"; do
  [ -d "$dir" ] || continue
  while IFS= read -r f; do
    [ -z "$f" ] && continue
    [ -n "${seen_files[$f]:-}" ] && continue

    trig_line=$(head -10 "$f" 2>/dev/null | grep -m 1 '^triggers:' | sed -E 's/^triggers:[[:space:]]*//')
    [ -z "$trig_line" ] && continue
    base=$(basename "$f")

    matched_kw=""
    IFS=',' read -ra kw_arr <<< "$trig_line"
    for kw in "${kw_arr[@]}"; do
      kw=$(echo "$kw" | sed -E 's/^[[:space:]]+|[[:space:]]+$//g')
      [ ${#kw} -lt 4 ] && continue
      case "$kw" in *\**|*\?*|*\[*|*\]*) continue ;; esac
      kw_lc=$(echo "$kw" | tr '[:upper:]' '[:lower:]')
      if printf '%s' "$sql_truncated" | grep -qiF -- "$kw_lc"; then
        if ! printf '%s' "$sql_truncated" | grep -qF -- "$base" \
           && ! printf '%s' "$sql_truncated" | grep -qF -- "$f"; then
          matched_kw="$kw_lc"
          break
        else
          seen_files["$f"]=1
          matched_kw=""
          break
        fi
      fi
    done

    if [ -n "$matched_kw" ]; then
      if [ "$surface_count" -lt "$WARN_CAP" ]; then
        surface_warns+=("[STATUS-BOARD-CONTEXT SUGGEST] status_board write matches trigger keyword '${matched_kw}' from ${f} - consider reading before/after the write to mirror durable doctrine. See ~/ecodiaos/patterns/context-surfacing-must-be-reliable-and-selective.md.")
        surface_count=$((surface_count + 1))
        seen_files["$f"]=1
      fi
    fi

    [ "$surface_count" -ge "$WARN_CAP" ] && break 2
  done < <(find "$dir" -maxdepth 1 -name '*.md' -not -name 'INDEX.md' 2>/dev/null)
done

# --- Telemetry emission (Layer 4) ---
# Fires when status_board write SQL matched a doctrine trigger. Capture the
# row text excerpt (sql first 500 chars) and the suggested patterns.
TELEM_LIB="$(dirname "$0")/lib/emit-telemetry.sh"
if [ -f "$TELEM_LIB" ]; then
  # shellcheck disable=SC1090
  source "$TELEM_LIB"
  sql_excerpt=$(printf '%s' "$sql" | head -c 500)
  ctx_json=$(jq -nc --arg sq "$sql_excerpt" '{sql_excerpt:$sq}' 2>/dev/null || echo '{}')
  surfaces_array='[]'
  if [ "${#surface_warns[@]}" -gt 0 ]; then
    surfaces_jq='[]'
    for w in "${surface_warns[@]}"; do
      f_path=$(echo "$w" | grep -oE 'from /home/tate/ecodiaos/[^ ]*\.md' | head -1 | sed -E 's/^from //')
      kw=$(echo "$w" | grep -oE "trigger keyword '[^']+'" | head -1 | sed -E "s/trigger keyword '([^']+)'/\1/")
      [ -z "$f_path" ] && continue
      surfaces_jq=$(echo "$surfaces_jq" | jq -c \
        --arg p "$f_path" \
        --arg k "$kw" \
        '. + [{pattern_path:$p, trigger_keyword:$k, source_layer:"hook:status-board-write"}]' 2>/dev/null || echo "$surfaces_jq")
    done
    surfaces_array="$surfaces_jq"
  fi
  emit_telemetry_safe "status-board-write-surface" "$tool_name" "$ctx_json" "$surfaces_array"
fi

if [ "${#surface_warns[@]}" -eq 0 ]; then
  exit 0
fi

ctx=""
for w in "${surface_warns[@]}"; do
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

# ---------------------------------------------------------------------------
# Test cases:
#
# WARN cases:
#   1. INSERT INTO status_board (name, next_action) VALUES ('Ordit Cognito
#      auth migration', 'Read PR 212 review comments') - should match trigger
#      keywords for ordit, auth, cognito, etc.
#
#   2. UPDATE status_board SET next_action = 'Tate must enable Extra Usage
#      for factory CLI dispatch' - should match factory-related triggers.
#
# NO-WARN cases:
#   A. INSERT INTO clients (name, ...) - not a status_board write.
#   B. UPDATE status_board SET archived_at = NOW() WHERE id = '...' - no
#      trigger keywords in the SQL beyond the table name itself.
#   C. INSERT INTO status_board with text that already explicitly cites the
#      relevant doctrine path (e.g. "see ~/ecodiaos/patterns/foo.md").
# ---------------------------------------------------------------------------
