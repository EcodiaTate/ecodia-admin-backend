#!/usr/bin/env bash
# ============================================================================
# Coexist PR preflight gate.
#
# Runs gates against the Coexist worktree before any push to
# github.com/EcodiaTate/coexist. Adapted from the Ordit preflight for a
# Vite + React + Supabase + Capacitor monorepo (no split be/fe).
#
# Usage (manual):   ~/ecodiaos/scripts/clients/coexist/preflight.sh
# Usage (pre-push): installed by install-hooks.sh at .git/hooks/pre-push
#
# Environment flags:
#   SKIP_TESTS=1      skip vitest run
#   SKIP_LINT=1       skip eslint (use only if lint was clean on base branch)
#   BASE_BRANCH=...   ref to diff against (default: origin/main)
#   VERBOSE=1         echo every command
#
# Exit codes:
#   0    all gates passed
#   1-N  the specific gate that failed
# ============================================================================

set -uo pipefail
[[ "${VERBOSE:-0}" == "1" ]] && set -x

COEXIST_DIR="/home/tate/workspaces/coexist"
BASE_BRANCH="${BASE_BRANCH:-origin/main}"

GATE_WORKTREE_DIRTY=10
GATE_PROTECTED_BRANCH=11
GATE_BUILD=20
GATE_LINT=30
GATE_UNIT_TESTS=40
GATE_AI_TELL_EMDASH=70
GATE_SECRETS=90
GATE_OVERSIZED_DIFF=100

say()  { printf "\n\033[1;36m[coexist preflight]\033[0m %s\n" "$*"; }
ok()   { printf "\033[1;32m  ok\033[0m  %s\n" "$*"; }
warn() { printf "\033[1;33mwarn\033[0m  %s\n" "$*"; }
fail() { printf "\033[1;31mFAIL\033[0m  %s\n" "$*"; }
die()  { fail "$1"; exit "$2"; }

cd "$COEXIST_DIR" || { fail "cannot cd to $COEXIST_DIR"; exit 2; }

# ---- Gate 0: worktree sanity ----
say "Gate 0: worktree sanity"
if [[ -n "$(git status --porcelain)" ]]; then
  git status --short
  die "worktree is dirty - stash/commit before preflight" $GATE_WORKTREE_DIRTY
fi
CURRENT_BRANCH="$(git rev-parse --abbrev-ref HEAD)"
HEAD_SHA="$(git rev-parse --short HEAD)"
ok "branch=$CURRENT_BRANCH head=$HEAD_SHA"

# refuse direct push to protected branches unless the user has opted in
case "$CURRENT_BRANCH" in
  main|master|production|release)
    if [[ "${ALLOW_PROTECTED_PUSH:-0}" != "1" ]]; then
      die "refusing to preflight on protected branch '$CURRENT_BRANCH' - set ALLOW_PROTECTED_PUSH=1 if intentional" $GATE_PROTECTED_BRANCH
    fi
    warn "ALLOW_PROTECTED_PUSH=1 - proceeding on '$CURRENT_BRANCH'"
    ;;
esac

# diff vs base for secrets / emdash / size gates
if git rev-parse --verify "$BASE_BRANCH" >/dev/null 2>&1; then
  DIFF_RANGE="$BASE_BRANCH...HEAD"
else
  warn "base ref $BASE_BRANCH not found - falling back to HEAD~1...HEAD"
  DIFF_RANGE="HEAD~1...HEAD"
fi

# ---- Gate 1: emdash detection in diff ----
say "Gate 1: emdash detection (AI tell)"
EMDASH_HITS="$(git diff "$DIFF_RANGE" -- '*.ts' '*.tsx' '*.js' '*.jsx' '*.md' '*.html' '*.css' 2>/dev/null | grep -n '^+' | grep -P '\x{2014}' || true)"
if [[ -n "$EMDASH_HITS" ]]; then
  fail "emdash (U+2014) detected in added lines:"
  echo "$EMDASH_HITS" | head -20
  exit $GATE_AI_TELL_EMDASH
fi
ok "no emdashes in diff"

# ---- Gate 2: secrets scan ----
say "Gate 2: secrets scan"
SECRET_HITS="$(git diff "$DIFF_RANGE" 2>/dev/null | grep -n '^+' | grep -iE '(AKIA[0-9A-Z]{16}|ATATT[0-9a-zA-Z_\-]{40,}|sk_live_[0-9a-zA-Z]{24,}|xoxb-[0-9a-zA-Z\-]{40,}|SUPABASE_SERVICE_ROLE_KEY\s*=\s*eyJ|-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY-----)' || true)"
if [[ -n "$SECRET_HITS" ]]; then
  fail "possible secret in diff:"
  echo "$SECRET_HITS" | head -10
  exit $GATE_SECRETS
fi
ok "no obvious secrets"

# ---- Gate 3: oversized diff ----
say "Gate 3: diff size"
ADDED="$(git diff --numstat "$DIFF_RANGE" 2>/dev/null | awk '{s+=$1} END {print s+0}')"
if [[ "$ADDED" -gt 3000 ]]; then
  warn "diff adds $ADDED lines - consider splitting the PR"
fi
ok "added=$ADDED"

# ---- Gate 4: build ----
say "Gate 4: build (tsc + vite build)"
if ! npm run build --silent; then
  die "build failed" $GATE_BUILD
fi
ok "build green"

# ---- Gate 5: lint ----
if [[ "${SKIP_LINT:-0}" != "1" ]]; then
  say "Gate 5: lint"
  if ! npm run lint --silent; then
    die "lint failed" $GATE_LINT
  fi
  ok "lint green"
else
  warn "SKIP_LINT=1 - skipped lint"
fi

# ---- Gate 6: unit tests ----
if [[ "${SKIP_TESTS:-0}" != "1" ]]; then
  say "Gate 6: vitest"
  if ! npm run test --silent; then
    die "unit tests failed" $GATE_UNIT_TESTS
  fi
  ok "tests green"
else
  warn "SKIP_TESTS=1 - skipped vitest"
fi

echo
printf "\033[1;32m[coexist preflight]\033[0m all gates passed - branch=%s head=%s\n" "$CURRENT_BRANCH" "$HEAD_SHA"
exit 0
