#!/usr/bin/env bash
# ============================================================================
# Ordit PR preflight gate.
#
# Runs aggressive checks against the Ordit backend worktree before any
# push to bitbucket.org/fireauditors1/be. Designed to catch the class of
# issues Eugene surfaced in PR 212 review BEFORE the code leaves our VPS.
#
# Usage (manual):   ~/ecodiaos/scripts/clients/ordit/preflight.sh
# Usage (pre-push): installed by install-hooks.sh at .git/hooks/pre-push
#
# Environment flags:
#   SKIP_E2E=1        skip the e2e jest run (e2e needs a DB)
#   SKIP_LINT=1       skip eslint (use only if lint was clean on the base branch)
#   STRICT_E2E=1      require e2e to pass (defaults to off since e2e needs DB)
#   BASE_BRANCH=...   ref to diff against (default: origin/feat/cognito-be-integration)
#   SCOPE_FILE=...    path to a scope manifest; enforces scope-check against declared files
#   VERBOSE=1         echo every command
#
# Exit codes:
#   0    all gates passed
#   1-N  the specific gate that failed (see GATE_* constants below)
# ============================================================================

set -uo pipefail
[[ "${VERBOSE:-0}" == "1" ]] && set -x

ORDIT_DIR="/home/tate/workspaces/ordit/be"
BASE_BRANCH="${BASE_BRANCH:-origin/feat/cognito-be-integration}"

GATE_WORKTREE_DIRTY=10
GATE_BUILD=20
GATE_LINT=30
GATE_UNIT_TESTS=40
GATE_E2E=41
GATE_PRISMA_VALIDATE=50
GATE_TSCONFIG_DEPRECATIONS=60
GATE_AI_TELL_EMDASH=70
GATE_STRING_LITERAL_ENUM=80
GATE_DEAD_DTO_FIELD=81
GATE_COGNITO_USERNAME=82
GATE_SCOPE_CHECK=85
GATE_SEMGREP=86
GATE_SECRETS=90
GATE_OVERSIZED_DIFF=100

# ---- tiny logger ----
say()  { printf "\n\033[1;36m[preflight]\033[0m %s\n" "$*"; }
ok()   { printf "\033[1;32m  ok\033[0m  %s\n" "$*"; }
warn() { printf "\033[1;33mwarn\033[0m  %s\n" "$*"; }
fail() { printf "\033[1;31mFAIL\033[0m  %s\n" "$*"; }
die()  { fail "$1"; exit "$2"; }

cd "$ORDIT_DIR" || { fail "cannot cd to $ORDIT_DIR"; exit 2; }

# ---- compute diff target early (used by scope-check, semgrep, secrets, size gates) ----
DIFF_TARGET=""
if git show-ref --verify --quiet "refs/remotes/$BASE_BRANCH"; then
  DIFF_TARGET="$BASE_BRANCH..HEAD"
elif git show-ref --verify --quiet "refs/remotes/origin/main"; then
  DIFF_TARGET="origin/main..HEAD"
fi

# ---- Gate 0: worktree sanity ----
say "Gate 0: worktree sanity"
if [[ -n "$(git status --porcelain)" ]]; then
  git status --short
  die "worktree is dirty - stash/commit before preflight" $GATE_WORKTREE_DIRTY
fi
CURRENT_BRANCH="$(git rev-parse --abbrev-ref HEAD)"
HEAD_SHA="$(git rev-parse --short HEAD)"
ok "branch=$CURRENT_BRANCH head=$HEAD_SHA"

# Ordit-specific: never push to main/master/UAT directly from preflight.
case "$CURRENT_BRANCH" in
  main|master|develop|UAT|uat|production)
    die "refusing to preflight on protected branch '$CURRENT_BRANCH' - work on a feature branch" $GATE_WORKTREE_DIRTY
    ;;
esac

# ---- Gate 1: tsconfig.json ignoreDeprecations must be "5.0" or absent ----
# TS 5.9.2 only accepts "5.0". Eugene's own commit 0b633e4 set "6.0" and broke CI.
# Note: tsconfig.json is JSONC (has // comments) so we grep rather than require().
say "Gate 1: tsconfig ignoreDeprecations value"
TSCONFIG_LINE="$(grep -oE '"ignoreDeprecations"[[:space:]]*:[[:space:]]*"[^"]*"' tsconfig.json || true)"
if [[ -z "$TSCONFIG_LINE" ]]; then
  ok "ignoreDeprecations absent (fine)"
else
  TSCONFIG_VAL="$(echo "$TSCONFIG_LINE" | grep -oE '"[^"]*"$' | tr -d '"')"
  if [[ "$TSCONFIG_VAL" == "5.0" ]]; then
    ok "ignoreDeprecations=5.0"
  else
    die "tsconfig.json ignoreDeprecations='$TSCONFIG_VAL' - TS 5.9 only accepts \"5.0\"" $GATE_TSCONFIG_DEPRECATIONS
  fi
fi

# ---- Gate 2: yarn build (nest build) must pass ----
say "Gate 2: yarn build"
if ! yarn build 2>&1 | tail -40; then
  die "yarn build failed - fix TypeScript errors before pushing" $GATE_BUILD
fi
ok "build clean"

# ---- Gate 3: eslint check (no --fix, just report) ----
if [[ "${SKIP_LINT:-0}" != "1" ]]; then
  say "Gate 3: yarn lint:check"
  if ! yarn lint:check 2>&1 | tail -60; then
    die "eslint errors - run 'yarn lint' to auto-fix, then re-run preflight" $GATE_LINT
  fi
  ok "lint clean"
else
  warn "lint skipped (SKIP_LINT=1)"
fi

# ---- Gate 4: unit tests ----
say "Gate 4: yarn test"
if ! yarn test --bail --passWithNoTests 2>&1 | tail -60; then
  die "unit tests failed" $GATE_UNIT_TESTS
fi
ok "unit tests pass"

# ---- Gate 5: prisma schema validate ----
# Use a dummy DATABASE_URL so validate tests schema structure, not env config.
# Real connection is not needed at preflight time - that's UAT's job.
say "Gate 5: prisma validate (schema structure only)"
if ! DATABASE_URL="mysql://preflight:preflight@localhost:3306/preflight" npx --no-install prisma validate 2>&1 | tail -20; then
  die "prisma schema invalid" $GATE_PRISMA_VALIDATE
fi
ok "prisma schema valid"

# ---- Gate 6: grep guardrails - Ordit-specific AI/drift tells ----
say "Gate 6: code guardrails"

# 6a. no em-dashes (U+2014) in src/ or test/ - brand rule, also an AI-output tell
# Unicode escape to avoid literal char in script source.
EMDASH=$(printf '\u2014')
if grep -rn "$EMDASH" src test 2>/dev/null; then
  die "em-dash(es) found in src/ or test/ - replace with hyphen or restructure" $GATE_AI_TELL_EMDASH
fi
ok "no em-dashes"

# 6b. no bare 'COGNITO' string literal comparisons in auth paths - must use AuthSource.COGNITO enum.
# Eugene explicitly flagged this in PR 212 review.
if grep -rn "=== *['\"]COGNITO['\"]\|['\"]COGNITO['\"] *===\|!== *['\"]COGNITO['\"]\|['\"]COGNITO['\"] *!==" src 2>/dev/null; then
  die "bare 'COGNITO' string comparison found - use AuthSource.COGNITO enum" $GATE_STRING_LITERAL_ENUM
fi
ok "no string-literal COGNITO comparisons"

# 6c. no 'useCognito' field in any DTO. Server-decided, not client-set.
# Word-boundary match so legitimate server-side vars like 'useCognitoAuthSource' do not trip it.
if grep -rnE "\buseCognito\b" src test 2>/dev/null; then
  die "'useCognito' field found - this is a server-decided flag, not a DTO field" $GATE_DEAD_DTO_FIELD
fi
ok "no 'useCognito' DTO leakage"

# 6d. cognito.service.ts: no crypto.randomUUID as Cognito Username.
# adminCreateUser should use email as Username so adminDeleteUser can find it later.
if grep -rn "crypto\.randomUUID" src/auth 2>/dev/null; then
  die "crypto.randomUUID in src/auth - Cognito Username should be email (see PR 212 fix 2)" $GATE_COGNITO_USERNAME
fi
ok "no random-UUID Cognito usernames"

# ---- Gate 6e: scope-check - diff stays inside the declared ticket scope ----
# Requires SCOPE_FILE env pointing to a scope manifest (see ~/ecodiaos/tools/scope-check.js).
# Unset SCOPE_FILE = warn only (can't enforce what we haven't declared). Set = hard fail on drift.
SCOPE_CHECK_TOOL="/home/tate/ecodiaos/tools/scope-check.js"
if [[ -n "${SCOPE_FILE:-}" ]]; then
  say "Gate 6e: scope-check against $SCOPE_FILE"
  if [[ ! -f "$SCOPE_FILE" ]]; then
    die "SCOPE_FILE set but '$SCOPE_FILE' does not exist" $GATE_SCOPE_CHECK
  fi
  if [[ ! -f "$SCOPE_CHECK_TOOL" ]]; then
    die "scope-check tool missing at $SCOPE_CHECK_TOOL" $GATE_SCOPE_CHECK
  fi
  if ! node "$SCOPE_CHECK_TOOL" --scope-file "$SCOPE_FILE" --base "$BASE_BRANCH" --head HEAD 2>&1; then
    die "scope-check failed - files outside declared ticket scope (see client-code-scope-discipline.md)" $GATE_SCOPE_CHECK
  fi
  ok "diff stays inside declared scope"
else
  warn "SCOPE_FILE unset - scope-check skipped (set SCOPE_FILE=path to enforce)"
fi

# ---- Gate 6f: semgrep - Ordit rulepack (scoped to changed files only) ----
# Rulepack lives at ~/ecodiaos/.semgrep/ordit/ruleset.yml (9 rules codifying PR 212 learnings).
# Scoped to diff vs base branch so pre-existing violations in untouched files do NOT fail the gate.
# This matches client-code-scope-discipline: "do not fix pre-existing casts you did not touch".
SEMGREP_RULESET="/home/tate/ecodiaos/.semgrep/ordit/ruleset.yml"
SEMGREP_BIN="$(command -v semgrep || echo /home/tate/.local/bin/semgrep)"
if [[ -x "$SEMGREP_BIN" || -f "$SEMGREP_BIN" ]]; then
  if [[ -f "$SEMGREP_RULESET" ]]; then
    if [[ -n "$DIFF_TARGET" ]]; then
      # List .ts files changed vs base, filter to src/ and test/, filter to those still present on disk.
      CHANGED_TS=$(git diff --name-only --diff-filter=AMR "$DIFF_TARGET" 2>/dev/null \
        | grep -E '^(src|test)/.*\.ts$' \
        | while read -r f; do [[ -f "$f" ]] && echo "$f"; done)
      if [[ -n "$CHANGED_TS" ]]; then
        say "Gate 6f: semgrep on $(echo "$CHANGED_TS" | wc -l) changed .ts files"
        if ! echo "$CHANGED_TS" | xargs "$SEMGREP_BIN" --config "$SEMGREP_RULESET" --error --quiet --metrics off 2>&1; then
          die "semgrep found rule violations in changed files (pre-existing violations are ignored by scope)" $GATE_SEMGREP
        fi
        ok "semgrep clean on changed files"
      else
        ok "semgrep skipped (no .ts changes in src/ or test/)"
      fi
    else
      warn "semgrep skipped (no base branch to diff against)"
    fi
  else
    warn "semgrep ruleset missing at $SEMGREP_RULESET - gate skipped"
  fi
else
  warn "semgrep not installed - install with 'pipx install semgrep' to enable gate"
fi

# ---- Gate 7: no secrets / credentials in staged diff ----
say "Gate 7: secret scan"
if [[ -n "$DIFF_TARGET" ]]; then
  SECRET_HITS=$(git diff "$DIFF_TARGET" -- 'src/**/*.ts' 'test/**/*.ts' 'prisma/**/*' '*.env*' 2>/dev/null \
    | grep -E '^\+' \
    | grep -E 'AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z\-_]{35}|-----BEGIN (RSA |EC )?PRIVATE KEY-----|eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.' \
    || true)
  if [[ -n "$SECRET_HITS" ]]; then
    echo "$SECRET_HITS" | head -5
    die "possible secret(s) in diff - investigate" $GATE_SECRETS
  fi
  ok "no secret patterns in diff"
else
  warn "no base branch to diff against - skipping secret scan"
fi

# ---- Gate 8: oversized diff warning ----
if [[ -n "$DIFF_TARGET" ]]; then
  CHANGED_LINES=$(git diff --shortstat "$DIFF_TARGET" 2>/dev/null | grep -oE '[0-9]+ insertion' | grep -oE '[0-9]+' || echo 0)
  CHANGED_FILES=$(git diff --name-only "$DIFF_TARGET" 2>/dev/null | wc -l)
  if [[ "$CHANGED_LINES" -gt 2000 ]]; then
    warn "LARGE diff: $CHANGED_LINES insertions across $CHANGED_FILES files - review twice before pushing"
  else
    ok "diff size: $CHANGED_LINES insertions across $CHANGED_FILES files"
  fi
fi

# ---- Gate 9: e2e (optional, DB-dependent) ----
if [[ "${STRICT_E2E:-0}" == "1" ]]; then
  say "Gate 9: yarn test:e2e (STRICT_E2E=1)"
  if ! yarn test:e2e 2>&1 | tail -80; then
    die "e2e tests failed" $GATE_E2E
  fi
  ok "e2e tests pass"
elif [[ "${SKIP_E2E:-0}" != "1" ]]; then
  warn "e2e not run - set STRICT_E2E=1 to require, SKIP_E2E=1 to silence"
fi

# ----
say "PREFLIGHT PASSED"
echo "  branch:  $CURRENT_BRANCH"
echo "  head:    $HEAD_SHA"
echo "  base:    $BASE_BRANCH"
echo ""
echo "safe to push."
exit 0
