#!/usr/bin/env bash
# fork-by-default-nudge.sh
#
# PreToolUse hook for tools that commonly carry "doing real work on main"
# signals. Reads tool input on stdin, classifies the call, and warns
# (never blocks) when the conductor appears to be executing forkable work
# directly instead of dispatching a fork.
#
# Third-strike enforcement layer for the doctrine in:
#   ~/ecodiaos/patterns/fork-by-default-stay-thin-on-main.md
#
# Trigger: Tate, 29 Apr 2026 13:17 AEST: "STOP DOING THE WORK. GET FORKS
# TO DO IT. They're context-identical clones of you."
#
# Output:
#   stderr: '[FORK-NUDGE] ...' one line per matched signal
#   stdout: hookSpecificOutput JSON with additionalContext for the model
#
# Always exits 0. Warn-only. Tolerates non-JSON gracefully.

set -u

input=$(cat)

# Tolerate non-JSON input gracefully.
if ! echo "$input" | jq -e . >/dev/null 2>&1; then
  exit 0
fi

tool_name=$(echo "$input" | jq -r '.tool_name // empty')

# --- Allow-list: tools that ARE conductor moves or read-only orientation. ---
# These never get a fork-nudge.
case "$tool_name" in
  mcp__forks__spawn_fork|mcp__forks__send_message|mcp__forks__abort_fork|mcp__forks__list_forks)
    exit 0
    ;;
  Read|Grep|Glob|LS|TodoWrite|WebSearch|WebFetch)
    exit 0
    ;;
  mcp__supabase__db_query|mcp__supabase__db_list_tables|mcp__supabase__db_describe_table|mcp__supabase__storage_list|mcp__supabase__storage_get_url)
    exit 0
    ;;
  mcp__crm__*|mcp__neo4j__graph_query|mcp__neo4j__graph_search|mcp__neo4j__graph_schema|mcp__neo4j__graph_context|mcp__neo4j__graph_semantic_search)
    exit 0
    ;;
  mcp__google-workspace__gmail_*|mcp__google-workspace__calendar_list_events|mcp__google-workspace__calendar_get_event|mcp__google-workspace__contacts_*|mcp__google-workspace__drive_search|mcp__google-workspace__drive_get_file|mcp__google-workspace__drive_list_folder|mcp__google-workspace__drive_read_sheet)
    exit 0
    ;;
  mcp__sms__*|mcp__scheduler__*|mcp__factory__get_factory_status|mcp__factory__get_session_progress|mcp__factory__get_cc_session_details|mcp__factory__list_codebases|mcp__factory__review_factory_session)
    exit 0
    ;;
esac

warnings=()

# --- Bash tool: scan command for "doing work on main" signals. ---
if [ "$tool_name" = "Bash" ]; then
  cmd=$(echo "$input" | jq -r '.tool_input.command // empty')
  if [ -z "$cmd" ] || [ "$cmd" = "null" ]; then
    exit 0
  fi

  signals=()

  # Multi-line command: > 1 newline-separated step.
  line_count=$(printf '%s\n' "$cmd" | wc -l)
  if [ "$line_count" -gt 1 ]; then
    signals+=("multi-line command (${line_count} lines)")
  fi

  # Multi-step via && or ; (excluding pure comment ; inside quotes is hard
  # to detect, but the false-positive is cheap and the rule is warn-only).
  if echo "$cmd" | grep -qE '(\&\&|;)'; then
    # Soft suppress when the only ; is inside a here-doc EOF marker. Rare.
    if echo "$cmd" | grep -qE '\&\&|[^<]\;[^<]'; then
      signals+=("multi-step (&& / ;)")
    fi
  fi

  # Repo work.
  if echo "$cmd" | grep -qE '(\bgit push\b|\bgit commit\b|\bgit rebase\b|\bgh pr\b|\bgh release\b)'; then
    signals+=("repo write (git push/commit/rebase or gh pr)")
  fi

  # PM2 operational work.
  if echo "$cmd" | grep -qE '\bpm2 (restart|reload|stop|start|delete)\b'; then
    signals+=("PM2 operational write (pm2 restart/reload/stop/start)")
  fi

  # Transport work.
  if echo "$cmd" | grep -qE '\b(rsync|scp)\b'; then
    signals+=("transport (rsync/scp)")
  fi

  # Multi-step laptop agent work via curl POST to port 7456.
  if echo "$cmd" | grep -qE 'curl.*:7456/api/tool'; then
    if echo "$cmd" | grep -qE '("?tool"?\s*:\s*"?(filesystem\.writeFile|filesystem\.deleteFile|shell\.shell|process\.killProcess|process\.launchApp))'; then
      signals+=("laptop-agent write op (filesystem.writeFile / shell.shell / process.* via curl :7456)")
    fi
  fi

  # File-write / apply heredocs (cat > ... <<EOF or cat >> ... <<EOF).
  if echo "$cmd" | grep -qE 'cat\s*>{1,2}\s*[^[:space:]]+\s*<<'; then
    signals+=("heredoc file-write (cat > path <<EOF)")
  fi

  if [ "${#signals[@]}" -gt 0 ]; then
    sig_str=$(printf '%s; ' "${signals[@]}")
    sig_str="${sig_str%; }"
    warnings+=("[FORK-NUDGE] Bash call carries forkable-work signals: ${sig_str}. This is forkable. The fork has the same MCP tools and context. Consider mcp__forks__spawn_fork instead. To proceed anyway, the work must be (a) under 30s, (b) read-only, or (c) directly responsive to a Tate-typed instruction this turn.")
  fi
fi

# --- mcp__vps__shell_exec: same signal class as Bash. ---
if [ "$tool_name" = "mcp__vps__shell_exec" ]; then
  cmd=$(echo "$input" | jq -r '.tool_input.command // empty')
  if [ -z "$cmd" ] || [ "$cmd" = "null" ]; then
    exit 0
  fi
  signals=()
  line_count=$(printf '%s\n' "$cmd" | wc -l)
  if [ "$line_count" -gt 1 ]; then
    signals+=("multi-line command (${line_count} lines)")
  fi
  if echo "$cmd" | grep -qE '\&\&'; then
    signals+=("multi-step (&&)")
  fi
  if echo "$cmd" | grep -qE '(\bgit push\b|\bgit commit\b|\bgh pr\b)'; then
    signals+=("repo write")
  fi
  if echo "$cmd" | grep -qE '\bpm2 (restart|reload|stop|start|delete)\b'; then
    signals+=("PM2 operational write")
  fi
  if echo "$cmd" | grep -qE 'cat\s*>{1,2}\s*[^[:space:]]+\s*<<'; then
    signals+=("heredoc file-write")
  fi
  if [ "${#signals[@]}" -gt 0 ]; then
    sig_str=$(printf '%s; ' "${signals[@]}")
    sig_str="${sig_str%; }"
    warnings+=("[FORK-NUDGE] mcp__vps__shell_exec call carries forkable-work signals: ${sig_str}. This is forkable. Consider mcp__forks__spawn_fork. Conductor stays thin on main. To proceed anyway, the work must be (a) under 30s, (b) read-only, or (c) directly responsive to a Tate-typed instruction this turn.")
  fi
fi

# --- Edit / Write: any direct file edit on main is a candidate to fork. ---
if [ "$tool_name" = "Edit" ] || [ "$tool_name" = "Write" ] || [ "$tool_name" = "MultiEdit" ] || [ "$tool_name" = "NotebookEdit" ]; then
  fp=$(echo "$input" | jq -r '.tool_input.file_path // .tool_input.notebook_path // empty')
  # Light suppression: the pattern of "single trivial edit responsive to
  # Tate-typed instruction this turn" is impossible to detect from input
  # alone. This stays warn-only and short.
  warnings+=("[FORK-NUDGE] direct file ${tool_name} on main (${fp}). Multi-file or multi-step edits should fork. Consider mcp__forks__spawn_fork. To proceed anyway, the edit must be (a) under 30s, (b) read-only diagnostic, or (c) a single-file change directly responsive to a Tate-typed instruction this turn.")
fi

# --- mcp__supabase__db_execute: data-mutating SQL. ---
if [ "$tool_name" = "mcp__supabase__db_execute" ]; then
  warnings+=("[FORK-NUDGE] mcp__supabase__db_execute is a data-mutating SQL call. If this is part of a multi-step migration or sync, consider forking it. The fork has db_execute access too. To proceed on main, the call must be a single targeted update directly responsive to a Tate-typed instruction this turn.")
fi

# --- mcp__supabase__storage_upload / storage_delete: storage mutations. ---
if [ "$tool_name" = "mcp__supabase__storage_upload" ] || [ "$tool_name" = "mcp__supabase__storage_delete" ]; then
  warnings+=("[FORK-NUDGE] ${tool_name} is a storage mutation. Multi-file uploads or deletions should fork. To proceed on main, the call must be a single targeted op directly responsive to a Tate-typed instruction this turn.")
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
# Test cases (run via fixtures/run-tests-fork-nudge.sh):
#
# WARN cases:
#   1. Bash multi-step:
#        {"tool_name":"Bash","tool_input":{"command":"cd ~/repo && git push && pm2 restart api"}}
#      -> warns: multi-step + repo write + PM2 operational
#
#   2. Bash heredoc file-write:
#        {"tool_name":"Bash","tool_input":{"command":"cat > /tmp/patch.js <<'EOF'\n...\nEOF"}}
#      -> warns: heredoc file-write
#
#   3. Bash gh pr create with heredoc body:
#        {"tool_name":"Bash","tool_input":{"command":"gh pr create --base main ..."}}
#      -> warns: repo write
#
#   4. Edit:
#        {"tool_name":"Edit","tool_input":{"file_path":"/home/tate/foo.js"}}
#      -> warns: direct file Edit on main
#
#   5. mcp__supabase__db_execute:
#        {"tool_name":"mcp__supabase__db_execute","tool_input":{"sql":"update ..."}}
#      -> warns: data-mutating SQL
#
# NO-WARN cases:
#   A. Single-line read-only Bash:
#        {"tool_name":"Bash","tool_input":{"command":"ls -la /tmp"}}
#      -> no warning
#
#   B. spawn_fork itself (the conductor move):
#        {"tool_name":"mcp__forks__spawn_fork","tool_input":{"brief":"..."}}
#      -> no warning (allow-listed)
#
#   C. Single Read tool call:
#        {"tool_name":"Read","tool_input":{"file_path":"/tmp/x"}}
#      -> no warning (allow-listed)
#
#   D. db_query (read-only):
#        {"tool_name":"mcp__supabase__db_query","tool_input":{"sql":"select ..."}}
#      -> no warning (allow-listed)
#
#   E. gmail_send (real-time triage is conductor work):
#        {"tool_name":"mcp__google-workspace__gmail_send","tool_input":{...}}
#      -> no warning (allow-listed)
# ---------------------------------------------------------------------------
