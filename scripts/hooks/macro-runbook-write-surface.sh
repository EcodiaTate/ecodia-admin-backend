#!/usr/bin/env bash
# macro-runbook-write-surface.sh
#
# PreToolUse hook for mcp__supabase__db_execute. When the SQL targets the
# macro_runbooks table (INSERT INTO macro_runbooks / UPDATE macro_runbooks),
# emits warnings about the macro-validation forcing function so the model is
# explicitly aware that:
#   1. status='validated_v1' is now schema-rejected without a corresponding
#      runbook_validation_runs row (the DB trigger will throw).
#   2. INSERTs without explicit status default to 'untested_spec'.
#   3. Doctrine: ~/ecodiaos/patterns/macros-must-be-validated-by-real-run-before-codification.md
#
# This is the warning half of the macro-validation backstop. The schema half
# is the trigger trg_enforce_validated_v1_has_validation_run on macro_runbooks
# (migration 070). The hook makes the rejection visible BEFORE the write
# rather than only at the SQL error.
#
# Behaviour:
#   1. Filter to mcp__supabase__db_execute. Other tools - exit 0.
#   2. Pull SQL string. Skip unless it contains "INTO macro_runbooks" or
#      "UPDATE macro_runbooks" (case-insensitive).
#   3. Two specific class warns:
#       a. SQL sets status='validated_v1' -> [MACRO-VALIDATION WARN] about
#          the trigger requirement.
#       b. Bulk INSERT without an explicit `status` column reference -> a
#          gentler reminder that status defaults to 'untested_spec'.
#   4. Always reference the canonical pattern file.
#   5. Exit 0 always. Warn-only.
#
# Mirrors the style of:
#   ~/ecodiaos/scripts/hooks/status-board-write-surface.sh

set -u

input=$(cat)

if ! echo "$input" | jq -e . >/dev/null 2>&1; then
  exit 0
fi

tool_name=$(echo "$input" | jq -r '.tool_name // empty')
[ "$tool_name" = "mcp__supabase__db_execute" ] || exit 0

sql=$(echo "$input" | jq -r '
  .tool_input.sql
  // .tool_input.query
  // .tool_input.statement
  // empty
')

if [ -z "$sql" ] || [ "$sql" = "null" ]; then
  exit 0
fi

# Filter: only fire when the SQL targets macro_runbooks.
if ! echo "$sql" | grep -qiE '(insert[[:space:]]+into[[:space:]]+macro_runbooks|update[[:space:]]+macro_runbooks)'; then
  exit 0
fi

PATTERN_REF="~/ecodiaos/patterns/macros-must-be-validated-by-real-run-before-codification.md"

warnings=()

# --- Class 1: status='validated_v1' (or related variations) ---
# Match: status='validated_v1', status = 'validated_v1', status="validated_v1",
# also matches multi-row VALUES forms where the literal appears anywhere in the SQL.
if echo "$sql" | grep -qiE "validated_v1"; then
  warnings+=("[MACRO-VALIDATION WARN] SQL sets status='validated_v1' on macro_runbooks. The DB trigger trg_enforce_validated_v1_has_validation_run will REJECT this UPDATE/INSERT unless a runbook_validation_runs row exists for the runbook_id. Insert the validation run FIRST (one row per real end-to-end replay against the live UI), then flip status. Doctrine: ${PATTERN_REF}.")
fi

# --- Class 2: INSERT without explicit status -> defaults to 'untested_spec' ---
# Detect INSERTs that do NOT mention the status column explicitly.
if echo "$sql" | grep -qiE 'insert[[:space:]]+into[[:space:]]+macro_runbooks'; then
  if ! echo "$sql" | grep -qiE 'status'; then
    warnings+=("[MACRO-VALIDATION WARN] INSERT INTO macro_runbooks without an explicit status column. Status will default to 'untested_spec' which is correct for never-replayed runbooks. The trusted-set query is WHERE status='validated_v1', so this row will NOT be dispatched until a validation run lands and status is flipped. Doctrine: ${PATTERN_REF}.")
  fi
fi

# --- Class 3: bulk INSERT pattern (multiple VALUES rows) - extra reminder ---
# A VALUES list with more than 3 row-tuples is a sign of "filling the cap"
# (the 22-row failure mode). Heuristic: count occurrences of "),(" plus 1.
bulk_rows=$(printf '%s' "$sql" | grep -oiE '\)[[:space:]]*,[[:space:]]*\(' | wc -l)
if echo "$sql" | grep -qiE 'insert[[:space:]]+into[[:space:]]+macro_runbooks' && [ "$bulk_rows" -ge 3 ]; then
  warnings+=("[MACRO-VALIDATION WARN] Bulk INSERT into macro_runbooks ($((bulk_rows + 1)) rows). The 29 Apr 2026 failure mode was 22 imagined runbooks INSERTed in 90 minutes. If these were authored without a real run against the target UI per ${PATTERN_REF}, retract before the row count grows. The trusted-set query stays WHERE status='validated_v1' regardless - bulk INSERTs all default to untested_spec.")
fi

# --- Telemetry emission (Layer 4) ---
TELEM_LIB="$(dirname "$0")/lib/emit-telemetry.sh"
if [ -f "$TELEM_LIB" ]; then
  # shellcheck disable=SC1090
  source "$TELEM_LIB"
  sql_excerpt=$(printf '%s' "$sql" | head -c 500)
  warn_count=${#warnings[@]}
  ctx_json=$(jq -nc \
    --arg sq "$sql_excerpt" \
    --argjson wc "$warn_count" \
    '{sql_excerpt:$sq, warn_count:$wc}' 2>/dev/null || echo '{}')
  surfaces_array='[]'
  if [ "$warn_count" -gt 0 ]; then
    surfaces_array=$(jq -nc \
      '[{pattern_path:"/home/tate/ecodiaos/patterns/macros-must-be-validated-by-real-run-before-codification.md", trigger_keyword:"macro_runbooks-write", source_layer:"hook:macro-runbook-write"}]' 2>/dev/null || echo '[]')
  fi
  emit_telemetry_safe "macro-runbook-write-surface" "$tool_name" "$ctx_json" "$surfaces_array"
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

# ---------------------------------------------------------------------------
# Test cases:
#
# WARN cases:
#   1. UPDATE macro_runbooks SET status='validated_v1' WHERE name='gmail-send'
#      -> Class 1 warn. The DB trigger will then reject the actual write
#      unless a runbook_validation_runs row exists.
#
#   2. INSERT INTO macro_runbooks (name, steps, vision_targets, validations)
#      VALUES ('foo', '[]'::jsonb, '[]'::jsonb, '[]'::jsonb)
#      -> Class 2 warn (no status column, defaults to untested_spec).
#
#   3. INSERT INTO macro_runbooks (name, steps, status) VALUES
#      ('a',...),('b',...),('c',...),('d',...)
#      -> Class 3 warn (bulk INSERT, 4+ rows).
#
# NO-WARN cases:
#   A. INSERT INTO status_board (...) - not a macro_runbooks write.
#   B. UPDATE macro_runbooks SET status='broken_needs_fix' WHERE id='...'
#      - status is in the enum, not validated_v1, no Class 1 warn.
#   C. UPDATE macro_runbooks SET last_run_at=now() WHERE id='...' - no
#      validated_v1, no INSERT pattern, no warns.
# ---------------------------------------------------------------------------
