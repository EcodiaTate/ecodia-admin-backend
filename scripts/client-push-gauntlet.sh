#!/usr/bin/env bash
# client-push-gauntlet.sh
#
# The runnable pre-push validation pipeline for client codebases.
# Reproduces the client's CI gauntlet locally, plus extra checks their CI
# does not catch (em-dash sweep, merge-conflict probe, hostile-reviewer diff).
#
# Usage:  scripts/client-push-gauntlet.sh <client-slug> [base-branch-override]
# Example: scripts/client-push-gauntlet.sh ordit
# Example: scripts/client-push-gauntlet.sh ordit main
#
# Loads per-client config from scripts/gauntlet-configs/<slug>.sh which must
# export WORKDIR, BASE_BRANCH, and the *_CMD variables consumed below. The
# config file sources this script's environment so it can set NODE_ENV etc.
#
# Exit codes:
#   0 - all steps passed, branch is push-ready
#   1 - at least one step failed, do NOT push
#   2 - usage / config error
#
# Written by EcodiaOS Apr 23 2026 in response to Ordit PR 212 fallout.
# Doctrine: patterns/client-push-pre-submission-pipeline.md

set -u
slug="${1:-}"
base_override="${2:-}"

if [ -z "$slug" ]; then
  echo "usage: $0 <client-slug> [base-branch-override]"
  echo "example: $0 ordit"
  echo ""
  echo "available configs:"
  ls "$(dirname "$0")/gauntlet-configs/" 2>/dev/null | sed 's/\.sh$//' | sed 's/^/  /'
  exit 2
fi

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
config="$script_dir/gauntlet-configs/${slug}.sh"

if [ ! -f "$config" ]; then
  echo "ERROR: missing config $config"
  echo "create one modeled on scripts/gauntlet-configs/ordit.sh"
  exit 2
fi

# Shellcheck source=/dev/null
source "$config"

# Config contract - every *_CMD is optional EXCEPT install/lint/test/build/typecheck.
: "${WORKDIR:?config must set WORKDIR}"
: "${BASE_BRANCH:?config must set BASE_BRANCH}"
: "${INSTALL_CMD:?config must set INSTALL_CMD}"
: "${LINT_CMD:?config must set LINT_CMD}"
: "${TEST_CMD:?config must set TEST_CMD}"
: "${BUILD_CMD:?config must set BUILD_CMD}"
: "${TYPECHECK_CMD:?config must set TYPECHECK_CMD}"

# Allow runtime override of BASE_BRANCH (e.g. to target main instead of uat)
if [ -n "$base_override" ]; then
  BASE_BRANCH="$base_override"
fi

# Defensive NODE_ENV handling. VPS defaults to production which silently skips
# devDeps (eslint, jest, nest CLI). Config can opt-out via NO_NODE_ENV_OVERRIDE=1.
if [ -z "${NO_NODE_ENV_OVERRIDE:-}" ]; then
  export NODE_ENV="${NODE_ENV_OVERRIDE:-development}"
fi
export NODE_OPTIONS="${NODE_OPTIONS:-"--max-old-space-size=4096"}"

cd "$WORKDIR" || { echo "ERROR: cannot cd to $WORKDIR"; exit 2; }

# ---------- step runner ----------
declare -a results
declare -A logs

run_step() {
  local name="$1"; shift
  local slug_name="${name// /-}"
  local logfile="/tmp/gauntlet-${slug}-${slug_name}.log"
  logs["$name"]="$logfile"

  printf '%-30s ... ' "$name"
  if "$@" > "$logfile" 2>&1; then
    results+=("PASS|$name|-")
    echo "PASS"
  else
    local code=$?
    results+=("FAIL|$name|exit $code, log $logfile")
    echo "FAIL (exit $code)"
    echo "  --- tail of $logfile ---"
    tail -10 "$logfile" | sed 's/^/  /'
    echo "  ----------------------"
  fi
}

# ---------- preamble ----------
echo ""
echo "=================================================="
echo " CLIENT-PUSH GAUNTLET: $slug"
echo " workdir:     $WORKDIR"
echo " base branch: origin/$BASE_BRANCH"
echo " node:        $(node --version 2>/dev/null || echo 'MISSING')"
echo " yarn:        $(yarn --version 2>/dev/null || echo 'MISSING')"
echo " NODE_ENV:    $NODE_ENV"
echo " HEAD:        $(git log --oneline -1 2>/dev/null || echo 'not a git repo')"
echo "=================================================="
echo ""

# ---------- step 1: fetch base branch ----------
run_step "fetch origin/$BASE_BRANCH" git fetch origin "$BASE_BRANCH"

# ---------- step 2: merge conflict probe ----------
# git merge-tree emits conflict markers in-line; grep for them.
run_step "merge conflict probe" bash -c '
  out=$(git merge-tree "origin/'"$BASE_BRANCH"'" HEAD 2>&1)
  count=$(echo "$out" | grep -cE "^(<<<<<<<|=======|>>>>>>>) " || true)
  if [ "$count" -gt 0 ]; then
    echo "found $count conflict markers merging HEAD into '"$BASE_BRANCH"'"
    echo "$out" | grep -B2 -A2 -E "^<<<<<<< " | head -30
    exit 1
  fi
'

# ---------- step 3: em-dash sweep on diff ----------
run_step "em-dash sweep" bash -c '
  count=$(git diff "origin/'"$BASE_BRANCH"'"..HEAD 2>/dev/null | grep -c "—" || true)
  if [ "$count" -gt 0 ]; then
    echo "found $count em-dash occurrences in diff vs origin/'"$BASE_BRANCH"'"
    git diff "origin/'"$BASE_BRANCH"'"..HEAD | grep -n "—" | head -20
    exit 1
  fi
'

# ---------- step 4: diff scope report (informational) ----------
echo ""
echo "=== diff scope vs origin/$BASE_BRANCH ==="
git diff --stat "origin/$BASE_BRANCH..HEAD" | head -50
echo ""

# ---------- step 5: suspect-file flag (informational + warning) ----------
# Flag any pipeline/migration/infra file in the diff. Does not fail the
# gauntlet by itself - the gauntlet cannot know what is in scope of the
# stated ticket - but prints a bright warning so the operator (me) has to
# re-justify before pushing.
suspect_files=$(git diff --name-only "origin/$BASE_BRANCH..HEAD" 2>/dev/null | grep -E '(bitbucket-pipelines\.yml|\.github/workflows/|Dockerfile|docker-compose|prisma/migrations/|terraform/|\.gitlab-ci\.yml|infra/|deploy/)' || true)
if [ -n "$suspect_files" ]; then
  echo "!!! SUSPECT-FILE WARNING !!!"
  echo "The following files are pipeline/infra/migration and MAY need to carve off to a separate PR:"
  echo "$suspect_files" | sed 's/^/  /'
  echo "Re-justify each one against the stated ticket before pushing."
  echo "Doctrine: patterns/client-push-pre-submission-pipeline.md"
  echo ""
fi

# ---------- step 6: install ----------
run_step "install" bash -c "$INSTALL_CMD"

# ---------- step 7: pre-build / codegen (prisma generate etc) ----------
if [ -n "${PRE_BUILD_CMD:-}" ]; then
  run_step "pre-build (codegen)" bash -c "$PRE_BUILD_CMD"
fi

# ---------- step 8: format ----------
if [ -n "${FORMAT_CMD:-}" ]; then
  run_step "format" bash -c "$FORMAT_CMD"
  # format must leave git status clean
  run_step "format-left-status-clean" bash -c '
    changes=$(git status --short | wc -l)
    if [ "$changes" -gt 0 ]; then
      echo "format pass left unstaged changes:"
      git status --short | head -20
      exit 1
    fi
  '
fi

# ---------- step 9: typecheck ----------
run_step "typecheck" bash -c "$TYPECHECK_CMD"

# ---------- step 10: lint ----------
run_step "lint" bash -c "$LINT_CMD"

# ---------- step 11: test ----------
run_step "test" bash -c "$TEST_CMD"

# ---------- step 12: build ----------
run_step "build" bash -c "$BUILD_CMD"

# ---------- step 13: optional extras defined by config ----------
if [ -n "${EXTRA_STEPS:-}" ]; then
  # EXTRA_STEPS is a pipe-delimited list: "name1|cmd1||name2|cmd2"
  # Using double-pipe as separator because pipes appear in commands.
  IFS='/' read -ra extras <<< "${EXTRA_STEPS//||//}"
  for extra in "${extras[@]}"; do
    name="${extra%%|*}"
    cmd="${extra#*|}"
    [ -n "$name" ] && [ -n "$cmd" ] && run_step "extra: $name" bash -c "$cmd"
  done
fi

# ---------- result board ----------
echo ""
echo "=================================================="
echo " RESULT BOARD"
echo "=================================================="
pass_count=0
fail_count=0
for r in "${results[@]}"; do
  IFS='|' read -r status name detail <<< "$r"
  if [ "$status" = "PASS" ]; then
    printf '  \033[32mPASS\033[0m  %s\n' "$name"
    pass_count=$((pass_count + 1))
  else
    printf '  \033[31mFAIL\033[0m  %s  (%s)\n' "$name" "$detail"
    fail_count=$((fail_count + 1))
  fi
done
echo ""
echo "  total: $((pass_count + fail_count))   pass: $pass_count   fail: $fail_count"
echo ""

if [ "$fail_count" -gt 0 ]; then
  echo "GAUNTLET FAILED. Do NOT push. Fix the failing steps first."
  exit 1
fi

if [ -n "$suspect_files" ]; then
  echo "GAUNTLET PASSED but SUSPECT-FILE WARNING was raised above."
  echo "Confirm each suspect file is in scope of the stated ticket before pushing."
fi

echo "GAUNTLET PASSED. Branch $slug @ $(git log --oneline -1 | cut -d' ' -f1) is push-ready."
echo "After push: watch PR activity and update status_board."
exit 0
