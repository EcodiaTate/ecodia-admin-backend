#!/usr/bin/env bash
# cowork-first-check.sh
#
# PreToolUse hook for fork-and-factory dispatch:
#   - mcp__forks__spawn_fork
#   - mcp__factory__start_cc_session
#
# Reads tool input on stdin, scans the brief for:
#   (a) a web SaaS UI target (Stripe / Vercel / GitHub web / Apple ASC /
#       Zernio / Xero / Supabase dashboard / Bitbucket web / GCP Console /
#       Play Console / Canva)
#   AND
#   (b) a bespoke-runtime signal (cu.* tool family, hand-rolled input.* /
#       mouse.* sequence, "computer-use loop", "step array", "runbook.run",
#       "macro runtime", macroHandlers)
# WITHOUT a Cowork reference (cowork / claude cowork / side panel /
# ctrl+e / ctrl-e / an [APPLIED] or [NOT-APPLIED] tag for the Cowork
# doctrine).
#
# Emits one [COWORK-FIRST WARN] line per matched (target, signal) pair.
# The conductor should drive the target via Claude Cowork's side panel
# instead of bespoke runtime against the webapp.
#
# Source spec:
#   ~/ecodiaos/patterns/claude-cowork-is-the-1stop-shop-for-ui-driving-tasks.md
#   Section 8 (Mechanical enforcement)
#
# Implemented in fork_mojziamq_980de8 (29 Apr 2026 21:XX AEST).
#
# Output:
#   stderr: '[COWORK-FIRST WARN] target=<saas-target> signal=<bespoke-signal> ...'
#   stdout: hookSpecificOutput JSON with additionalContext for the model
#
# Always exits 0. Warn-only. Never blocks tool execution.
# Bias: false positives over false negatives, consistent with sibling hooks.

set -u

input=$(cat)

# Tolerate non-JSON input gracefully.
if ! echo "$input" | jq -e . >/dev/null 2>&1; then
  exit 0
fi

tool_name=$(echo "$input" | jq -r '.tool_name // empty')

# The brief lives in different fields depending on the tool. Try the common ones.
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

# Lowercase copy for case-insensitive matching without -i flag noise.
brief_lc=$(echo "$brief" | tr '[:upper:]' '[:lower:]')

# --- Cowork-allow keywords. If ANY of these are present, the conductor has
#     already accounted for Cowork. Skip silently.
if echo "$brief_lc" | grep -qE '(cowork|claude cowork|side panel|ctrl\+e|ctrl-e|\[cowork)'; then
  exit 0
fi

# Also skip if the brief carries an applied-pattern tag for the Cowork doctrine.
if echo "$brief" | grep -qE '\[(APPLIED|NOT-APPLIED)\][^\[]*claude-cowork-is-the-1stop-shop-for-ui-driving-tasks'; then
  exit 0
fi

# --- Web SaaS targets. Format: "label|regex"
# Each regex matches against the lowercased brief.
targets=(
  "stripe-dashboard|(stripe\.com|stripe dashboard)"
  "vercel-dashboard|(vercel\.com|vercel dashboard|vercel ui)"
  "github-web|(github web|github\.com web)"
  "apple-asc|(appstoreconnect\.apple\.com|app store connect|\basc dashboard\b|\basc\b)"
  "zernio-dashboard|(app\.zernio\.com|zernio dashboard)"
  "xero-web|(xero\.com|xero web)"
  "supabase-dashboard|(supabase\.com/dashboard|supabase dashboard)"
  "bitbucket-web|(bitbucket\.org|bitbucket web)"
  "gcp-console|(console\.cloud\.google\.com|gcp console)"
  "play-console|(play\.google\.com/console|play console)"
  "canva-editor|(canva\.com|canva editor)"
)

# --- Bespoke-runtime signals. Format: "label|regex"
# All regexes are matched against the lowercased brief.
signals=(
  "cu-tool-family|cu\."
  "computer-use-loop|(computer-use loop|computer use loop)"
  "hand-rolled-input|hand-rolled .{0,3}input\."
  "hand-rolled-mouse|hand-rolled .{0,3}mouse\."
  "step-array|step array"
  "runbook-run|runbook\.run"
  "macro-runtime|macro runtime"
  "macro-handlers|macrohandlers"
)

# --- Special case: github-web. The bare "github.com" or "github" hits a lot of
# briefs that are actually about the gh CLI, git push, or the GitHub REST API -
# none of which require Cowork. Exclude github-web if the brief mentions any of
# those AND does NOT contain a standalone "github web" UI reference.
github_web_excluded=false
if echo "$brief_lc" | grep -qE '(gh cli|gh pr |gh repo|gh api|git push|git pull|git clone|github api|github rest)'; then
  if ! echo "$brief_lc" | grep -qE '(github web|github\.com web|github web ui)'; then
    github_web_excluded=true
  fi
fi

warnings=()
match_pairs=()  # for telemetry: "<target>|<signal>"

for t in "${targets[@]}"; do
  IFS='|' read -r t_label t_regex <<< "$t"

  # Skip github-web when excluded.
  if [ "$t_label" = "github-web" ] && [ "$github_web_excluded" = "true" ]; then
    continue
  fi

  if ! echo "$brief_lc" | grep -qE -- "$t_regex"; then
    continue
  fi

  # Target matched. Check each signal.
  for s in "${signals[@]}"; do
    IFS='|' read -r s_label s_regex <<< "$s"
    if echo "$brief_lc" | grep -qE -- "$s_regex"; then
      warnings+=("[COWORK-FIRST WARN] target=${t_label} signal=${s_label} - bespoke-runtime referenced against ${t_label} without Cowork mention. Consider Cowork side panel via Ctrl+E. See ~/ecodiaos/patterns/claude-cowork-is-the-1stop-shop-for-ui-driving-tasks.md")
      match_pairs+=("${t_label}|${s_label}")
    fi
  done
done

# --- Telemetry emission (Layer 4) ---
# Each (target, signal) pair is one logical surface_event row. Source layer is
# tagged so the dispatchEventConsumer can attribute it correctly.
TELEM_LIB="$(dirname "$0")/lib/emit-telemetry.sh"
if [ -f "$TELEM_LIB" ]; then
  # shellcheck disable=SC1090
  source "$TELEM_LIB"
  brief_excerpt=$(printf '%s' "$brief" | head -c 500)
  total_matches=${#match_pairs[@]}
  ctx_json=$(jq -nc --arg be "$brief_excerpt" --argjson tm "$total_matches" '{brief_excerpt:$be, total_matches:$tm}' 2>/dev/null || echo '{}')
  surfaces_array='[]'
  if [ "$total_matches" -gt 0 ]; then
    surfaces_jq='[]'
    for entry in "${match_pairs[@]}"; do
      IFS='|' read -r m_target m_signal <<< "$entry"
      surfaces_jq=$(echo "$surfaces_jq" | jq -c \
        --arg p "/home/tate/ecodiaos/patterns/claude-cowork-is-the-1stop-shop-for-ui-driving-tasks.md" \
        --arg k "${m_target}+${m_signal}" \
        --arg pr "critical" \
        --argjson cn true \
        '. + [{pattern_path:$p, trigger_keyword:$k, priority:$pr, canonical:$cn, source_layer:"hook:cowork-first"}]' 2>/dev/null || echo "$surfaces_jq")
    done
    surfaces_array="$surfaces_jq"
  fi
  if declare -f emit_telemetry_safe >/dev/null 2>&1; then
    emit_telemetry_safe "cowork-first-check" "$tool_name" "$ctx_json" "$surfaces_array"
  fi
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
