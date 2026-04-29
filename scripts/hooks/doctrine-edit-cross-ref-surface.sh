#!/usr/bin/env bash
# doctrine-edit-cross-ref-surface.sh
#
# PreToolUse hook for Write / Edit / MultiEdit when the target file is in a
# durable doctrine layer. Reads tool input on stdin, finds related doctrine
# files (by trigger-keyword overlap), and emits [DOCTRINE-CROSS-REF SUGGEST]
# warnings (never blocks) so the model considers cross-referencing them.
#
# Implements the meta-pattern in:
#   ~/ecodiaos/patterns/context-surfacing-must-be-reliable-and-selective.md
#
# Doctrine paths covered:
#   ~/ecodiaos/patterns/*.md
#   ~/ecodiaos/clients/*.md
#   ~/ecodiaos/docs/*.md  (recursive - includes docs/secrets/, docs/architecture/, etc.)
#   ~/CLAUDE.md
#   ~/ecodiaos/CLAUDE.md
#
# Behaviour:
#   1. Resolve target file_path. Skip if not in a doctrine path.
#   2. Pull keyword candidates from the new_string (Edit) / content (Write).
#      Match those candidates against trigger lines across the doctrine corpus.
#   3. Exclude the file being edited itself.
#   4. Emit one warn per related doctrine file (capped at 6).
#   5. Always exit 0.
#
# Output:
#   stderr: '[DOCTRINE-CROSS-REF SUGGEST] file you are editing matches triggers
#            in <other-file> - consider cross-referencing.'
#   stdout: hookSpecificOutput JSON with additionalContext for the model
#
# Tolerates non-JSON gracefully.

set -u

input=$(cat)

# Tolerate non-JSON input gracefully.
if ! echo "$input" | jq -e . >/dev/null 2>&1; then
  exit 0
fi

tool_name=$(echo "$input" | jq -r '.tool_name // empty')

case "$tool_name" in
  Write|Edit|MultiEdit) : ;;
  *) exit 0 ;;
esac

file_path=$(echo "$input" | jq -r '.tool_input.file_path // empty')
[ -z "$file_path" ] || [ "$file_path" = "null" ] && exit 0

# --- Doctrine path filter ---
# Tilde-resolution first.
fp_resolved="$file_path"
case "$fp_resolved" in
  '~'*) fp_resolved="${HOME}${fp_resolved#~}" ;;
esac

is_doctrine=0
case "$fp_resolved" in
  /home/tate/ecodiaos/patterns/*.md)  is_doctrine=1 ;;
  /home/tate/ecodiaos/clients/*.md)   is_doctrine=1 ;;
  /home/tate/ecodiaos/docs/*.md)      is_doctrine=1 ;;
  /home/tate/CLAUDE.md)               is_doctrine=1 ;;
  /home/tate/.claude/CLAUDE.md)       is_doctrine=1 ;;
  /home/tate/ecodiaos/CLAUDE.md)      is_doctrine=1 ;;
esac
[ "$is_doctrine" -eq 0 ] && exit 0

# --- Extract the new content being written/edited ---
# Write: .tool_input.content
# Edit:  .tool_input.new_string  (the replacement text)
# MultiEdit: .tool_input.edits[].new_string  (concatenated)
content=$(echo "$input" | jq -r '
  .tool_input.content
  // .tool_input.new_string
  // (
    if (.tool_input.edits // null) != null then
      [.tool_input.edits[].new_string // ""] | join("\n")
    else empty end
  )
  // empty
')

# If we cannot pull content (e.g. unknown shape), skip - we have nothing to scan.
if [ -z "$content" ] || [ "$content" = "null" ]; then
  exit 0
fi

# Length cap - extremely long contents get truncated to keep the grep cost bounded.
# 200KB is well above any realistic doctrine-file edit.
content_truncated=$(printf '%s' "$content" | head -c 200000)

# --- Doctrine corpus walk ---
DOCTRINE_DIRS=(
  "/home/tate/ecodiaos/patterns"
  "/home/tate/ecodiaos/clients"
  "/home/tate/ecodiaos/docs/secrets"
  "/home/tate/ecodiaos/docs"
)

# WARN_CAP: max suggestions emitted per invocation. Prevents flood when
# editing a long doctrine file that touches many domains.
WARN_CAP=6

cross_ref_warns=()
cross_ref_count=0

# Track files already suggested (a file in patterns/ should not be suggested
# again if it also lives in docs/).
declare -A seen_files
seen_files["$fp_resolved"]=1

for dir in "${DOCTRINE_DIRS[@]}"; do
  [ -d "$dir" ] || continue
  while IFS= read -r f; do
    [ -z "$f" ] && continue
    # Skip the file being edited.
    [ -n "${seen_files[$f]:-}" ] && continue

    # Extract triggers: line content (everything after "triggers:" up to EOL).
    trig_line=$(head -10 "$f" 2>/dev/null | grep -m 1 '^triggers:' | sed -E 's/^triggers:[[:space:]]*//')
    [ -z "$trig_line" ] && continue

    base=$(basename "$f")

    # Tokenise triggers and check whether ANY trigger keyword appears in the
    # content being written. One match is enough to suggest the cross-ref.
    matched_kw=""
    IFS=',' read -ra kw_arr <<< "$trig_line"
    for kw in "${kw_arr[@]}"; do
      kw=$(echo "$kw" | sed -E 's/^[[:space:]]+|[[:space:]]+$//g')
      [ ${#kw} -lt 4 ] && continue
      case "$kw" in *\**|*\?*|*\[*|*\]*) continue ;; esac
      kw_lc=$(echo "$kw" | tr '[:upper:]' '[:lower:]')
      if printf '%s' "$content_truncated" | grep -qiF -- "$kw_lc"; then
        # Skip if the doctrine file is already explicitly cross-referenced
        # in the new content (by basename or path).
        if ! printf '%s' "$content_truncated" | grep -qF -- "$base" \
           && ! printf '%s' "$content_truncated" | grep -qF -- "$f"; then
          matched_kw="$kw_lc"
          break
        else
          # Already cross-referenced; mark as seen and stop scanning this file.
          seen_files["$f"]=1
          matched_kw=""
          break
        fi
      fi
    done

    if [ -n "$matched_kw" ]; then
      if [ "$cross_ref_count" -lt "$WARN_CAP" ]; then
        cross_ref_warns+=("[DOCTRINE-CROSS-REF SUGGEST] file being edited (${file_path}) matches trigger keyword '${matched_kw}' from ${f} - consider cross-referencing it. See ~/ecodiaos/patterns/context-surfacing-must-be-reliable-and-selective.md for the cross-ref discipline.")
        cross_ref_count=$((cross_ref_count + 1))
        seen_files["$f"]=1
      fi
    fi

    [ "$cross_ref_count" -ge "$WARN_CAP" ] && break 2
  done < <(find "$dir" -maxdepth 1 -name '*.md' -not -name 'INDEX.md' 2>/dev/null)
done

# --- Telemetry emission (Layer 4) ---
# This hook fires when the conductor edits a doctrine file. Each suggestion
# is one surface event: the file being edited matched a trigger keyword from
# another doctrine file. Capture (file_being_edited, suggested_path, keyword)
# triples for the consumer.
TELEM_LIB="$(dirname "$0")/lib/emit-telemetry.sh"
if [ -f "$TELEM_LIB" ]; then
  # shellcheck disable=SC1090
  source "$TELEM_LIB"
  ctx_json=$(jq -nc --arg fp "$file_path" --arg tn "$tool_name" '{file_path:$fp, tool:$tn}' 2>/dev/null || echo '{}')
  surfaces_array='[]'
  if [ "${#cross_ref_warns[@]}" -gt 0 ]; then
    surfaces_jq='[]'
    for w in "${cross_ref_warns[@]}"; do
      f_path=$(echo "$w" | grep -oE 'from /home/tate/ecodiaos/[^ ]*\.md' | head -1 | sed -E 's/^from //')
      kw=$(echo "$w" | grep -oE "trigger keyword '[^']+'" | head -1 | sed -E "s/trigger keyword '([^']+)'/\1/")
      [ -z "$f_path" ] && continue
      surfaces_jq=$(echo "$surfaces_jq" | jq -c \
        --arg p "$f_path" \
        --arg k "$kw" \
        '. + [{pattern_path:$p, trigger_keyword:$k, source_layer:"hook:doctrine-edit-cross-ref"}]' 2>/dev/null || echo "$surfaces_jq")
    done
    surfaces_array="$surfaces_jq"
  fi
  emit_telemetry_safe "doctrine-edit-cross-ref-surface" "$tool_name" "$ctx_json" "$surfaces_array"
fi

if [ "${#cross_ref_warns[@]}" -eq 0 ]; then
  exit 0
fi

ctx=""
for w in "${cross_ref_warns[@]}"; do
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
#   1. Write to ~/ecodiaos/patterns/new-rule.md whose content mentions "vercel"
#      and "deploy-verify" - should suggest deploy-verify-or-the-fork-didnt-finish.md.
#
#   2. Edit ~/ecodiaos/CLAUDE.md replacing a section that mentions "factory" -
#      should suggest factory-approve-no-push-no-commit-sha.md (and possibly
#      others).
#
# NO-WARN cases:
#   A. Write to /tmp/scratch.md - not a doctrine path.
#   B. Edit ~/ecodiaos/patterns/foo.md whose new_string already references the
#      paths of every matching trigger doctrine file.
#   C. Edit a non-.md file under any of these dirs (we filter on .md).
# ---------------------------------------------------------------------------
