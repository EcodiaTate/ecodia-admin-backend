#!/usr/bin/env bash
# brief-consistency-check.sh
#
# PreToolUse hook for mcp__forks__spawn_fork and mcp__factory__start_cc_session.
# Reads tool input on stdin, extracts the brief, runs four checks, and warns
# (never blocks) when known anti-patterns are present.
#
# Surfaces:
#   ~/ecodiaos/patterns/brief-names-the-product-not-the-immediate-task.md
#   ~/ecodiaos/patterns/deploy-verify-or-the-fork-didnt-finish.md
#   ~/ecodiaos/patterns/project-naming-mirrors-repo-name.md
#
# Output:
#   stderr: '[BRIEF-CHECK WARN] anti-pattern: <name> in <tool> - <detail>'
#   stdout: hookSpecificOutput JSON with additionalContext for the model
#
# Always exits 0. Warn-only.

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

warnings=()

# --- Check 1: "FULL ... [ProperNoun] ... implementation" without platform/multi-tenant context ---
# Matches "FULL X implementation" or "FULL working SCYCC implementation" - any words between
# FULL and 'implementation' as long as at least one is a ProperNoun (capitalised first letter
# followed by another letter, to exclude single-letter or all-caps acronyms standalone).
if echo "$brief" | grep -qE 'FULL ([A-Za-z0-9_-]+ ){0,4}[A-Z][A-Za-z0-9_-]+ ([A-Za-z0-9_-]+ ){0,4}implementation'; then
  if ! echo "$brief" | grep -qiE '(platform|multi-tenant|multi tenant|multitenant)'; then
    match=$(echo "$brief" | grep -oE 'FULL ([A-Za-z0-9_-]+ ){0,4}[A-Z][A-Za-z0-9_-]+ ([A-Za-z0-9_-]+ ){0,4}implementation' | head -1)
    warnings+=("[BRIEF-CHECK WARN] anti-pattern: full-properNoun-implementation in ${tool_name} - matched \"${match}\" without 'platform' or 'multi-tenant' anywhere in brief. See ~/ecodiaos/patterns/brief-names-the-product-not-the-immediate-task.md")
  fi
fi

# --- Check 2: platform/multi-tenant work without architectural-invariant ANYWHERE in brief ---
# Tuned 2026-04-29 (fix/brief-consistency-tune-2026-04-29): previously scanned only the first
# paragraph, which false-positived on briefs whose first paragraph was a "Goal:" framing line
# and whose invariant lived under a labelled "Architecture invariant" heading further down.
# Now scans the full brief and adds an explicit "Architecture invariant" / "Architectural
# invariant" heading guard.
if echo "$brief" | grep -qiE '(platform|multi-tenant|multi tenant|multitenant)'; then
  # Heading guard: an explicit "Architecture invariant" / "Architectural invariant" heading
  # (case-insensitive, dash or space separator allowed, optional bold/colon) followed by any
  # non-trivial content is sufficient. Empty/heading-only sections do not satisfy the guard.
  if echo "$brief" | grep -qiE '(architecture|architectural)[ -]?invariant[*:[:space:]]+[^[:space:]]'; then
    : # explicit Architecture-invariant heading with content - skip Check 2
  elif ! echo "$brief" | grep -qiE '(invariant|tenant resolution|\bRLS\b|tenant-scoped|hostname|tenant-aware|ARCHITECTURE|tenant_id|JWT custom claim)'; then
    warnings+=("[BRIEF-CHECK WARN] anti-pattern: platform-without-invariant in ${tool_name} - brief mentions platform/multi-tenant but lacks an architectural-invariant statement anywhere (no mention of: invariant, tenant resolution, RLS, tenant-scoped, hostname, tenant-aware, ARCHITECTURE, tenant_id, JWT). See ~/ecodiaos/patterns/brief-names-the-product-not-the-immediate-task.md")
  fi
fi

# --- Check 3: Vercel-linked codebase touched without deploy-verify content ---
# Tuned 2026-04-29 (fix/brief-consistency-tune-2026-04-29): previously matched only the
# case-sensitive literal 'DEPLOY VERIFY'. Real briefs use the lowercase doctrine pointer
# 'deploy-verify' and equivalent natural-language phrasings ('Vercel READY polling',
# 'poll Vercel until READY', 'wait until deployment ready'). Match is now case-insensitive
# and accepts those alternates. Negation guard list also extended to cover the
# '(NOT Vercel-linked)' / '(NOT Vercel)' parenthetical form.
if echo "$brief" | grep -qiE '(\bvercel\b|frontend|ecodiaos-frontend|roam-frontend|coexist|chambers|ordit-frontend|next\.js|nextjs)'; then
  # Negation guard: skip Check 3 if the brief explicitly states a non-Vercel deployment posture.
  # Prevents false-positive on briefs that mention "Vercel" only to negate it.
  if echo "$brief" | grep -qiE '(PM2[ -]?managed|not Vercel[ -]?linked|VPS[ -]?only|no Vercel deploy|ecodiaos backend is PM2|\(NOT Vercel[ -]?linked\)|\(NOT Vercel\))'; then
    : # explicitly non-Vercel - skip Check 3
  elif ! echo "$brief" | grep -qiE '(deploy[ _-]?verify|vercel[^.]{0,40}ready|poll[^.]{0,40}vercel|poll[^.]{0,40}ready|until[^.]{0,40}ready|wait[^.]{0,40}ready|deployment[^.]{0,40}ready)'; then
    warnings+=("[BRIEF-CHECK WARN] anti-pattern: vercel-linked-no-deploy-verify in ${tool_name} - brief touches a Vercel-linked codebase but lacks deploy-verify content. The fork is not done at git push - it must poll Vercel until READY. See ~/ecodiaos/patterns/deploy-verify-or-the-fork-didnt-finish.md")
  fi
fi

# --- Check 4: New Vercel project scaffolding without PROJECT NAMING note ---
if echo "$brief" | grep -qiE '(scaffold.*vercel|new vercel project|create vercel project|vercel link|vercel init|vercel project create)'; then
  if ! echo "$brief" | grep -qE 'PROJECT[ _-]?NAMING'; then
    warnings+=("[BRIEF-CHECK WARN] anti-pattern: scaffold-no-project-naming in ${tool_name} - brief scaffolds a new Vercel project but lacks a PROJECT NAMING note. Vercel project name must equal GitHub repo name; never accept the directory-default ('fe'/'be'). See ~/ecodiaos/patterns/project-naming-mirrors-repo-name.md")
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
