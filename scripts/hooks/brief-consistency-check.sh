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
  # API-call negation: skip if all "platform" mentions are within Capacitor/process/navigator
  # API-call references (isNativePlatform, getPlatform, process.platform, etc) and there is no
  # standalone multi-tenant/platform-as-product reference. Tuned 2026-04-29-PM by author of
  # ~/ecodiaos/patterns/windows-spawn-must-use-spawnSync... after a session of false-positives.
  platform_total=$(echo "$brief" | grep -oiE '(platform|multi-tenant|multi tenant|multitenant)' | wc -l)
  api_platform=$(echo "$brief" | grep -oiE '(isNativePlatform|getPlatform|process\.platform|navigator\.platform|Capacitor\.platform|platform === [^a-z]ios|platform === [^a-z]android|platform === [^a-z]web|platform: [^a-z](ios|android|web))' | wc -l)
  # Explicit single-tenant negation: brief explicitly says single-tenant or not multi-tenant.
  if echo "$brief" | grep -qiE '(single-tenant|single tenant|not multi-tenant|no multi-tenant|not platform-style)'; then
    : # explicit single-tenant - skip Check 2
  elif [ "$platform_total" -le "$api_platform" ]; then
    : # all "platform" mentions are API-call names, not multi-tenancy - skip Check 2
  # Outreach-prep / drafting-only negation: skip Check 2 when the brief is pure markdown
  # drafting (outreach prep, pitch deck, marketing copy, intro prep, etc.) AND contains no
  # code-modification verb that is not already negated. Tuned 2026-04-29 after Chambers
  # federation prep + Carbon-MRV intro prep forks false-positived. The platform-mention in
  # those briefs was domain context ("compliance platform", "MRV platform") not a
  # multi-tenancy spec. Negated forms ("no actual deploy", "no commit", "do not push") are
  # stripped before the verb check so they do not count as real code-mod verbs.
  elif echo "$brief" | grep -qiE '(outreach prep|outreach drafting|outreach email template|outreach email\b|intro prep|marketing copy|pitch deck|pitch one-pager|drafts only|drafting only)' && \
       ! echo "$brief" | sed -E '
         s/\b(no|not)[[:space:]]+(actual[[:space:]]+)?(commits?|merges?|merging|pushes|pushing|deploys?|deploying|ships?|shipping|releases?|releasing|rollouts?|sending|contact)\b//gi
         s/\b(do[[:space:]]+not|do[[:space:]]+NOT)[[:space:]]+(commit|merge|push|deploy|ship|release|rollout|modify|send)\b//gi
         s/\bno[[:space:]]+(PR|code[[:space:]]+changes?)\b//gi
       ' | grep -qiE '\b(commit|merge|push|deploy|ship|release|rollout)\b'; then
    : # outreach/drafting-only with no real (non-negated) code-modification verb - skip Check 2
  # Heading guard: an explicit "Architecture invariant" / "Architectural invariant" heading
  # (case-insensitive, dash or space separator allowed, optional bold/colon) followed by any
  # non-trivial content is sufficient. Empty/heading-only sections do not satisfy the guard.
  elif echo "$brief" | grep -qiE '(architecture|architectural)[ -]?invariant[*:[:space:]]+[^[:space:]]'; then
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
  # Recon-only / read-only / diagnostic-only negation: skip when brief explicitly states no
  # code change occurs. Tuned 2026-04-29-PM after a session of false-positives where
  # diagnostic / audit / doctrine briefs that referenced repo paths only to read them got
  # flagged as needing deploy-verify.
  elif echo "$brief" | grep -qiE '(recon only|recon[ -]+only|read-only|read only on|diagnostic only|doctrine only|no code change|no code changes|no PR|no merge|no deploy|no ship|do not push|do NOT push|do not modify|do NOT modify|do not commit|do NOT commit|out of scope.+(ship|publish|deploy)|recon \+ recommendation|verification only|inspection only|audit only|read-only on)'; then
    : # explicitly recon/read-only - skip Check 3
  # Outreach-prep / drafting-only negation: skip Check 3 when the brief is pure markdown
  # drafting (outreach prep, pitch deck, marketing copy, intro prep, etc.). Tuned 2026-04-29
  # after Chambers federation prep + Carbon-MRV intro prep forks false-positived because they
  # mentioned codebase keywords ("Vercel", "frontend", domain names) only as context for who
  # the outreach target is, not as deploy targets.
  elif echo "$brief" | grep -qiE '(drafting only|drafts only|outreach prep|outreach drafting|outreach email template|outreach email\b|intro prep|marketing copy|pitch deck|pitch one-pager|no actual contact|no actual sending|no actual deploy|no actual ship)'; then
    : # explicitly drafting/outreach-only - skip Check 3
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
