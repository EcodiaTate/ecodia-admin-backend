#!/usr/bin/env bash
set -euo pipefail

# Determine repo root from script location
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd -- "$SCRIPT_DIR/.." && pwd)"

USAGE="Usage: tools/ordit-prepush.sh <scope-file> <ordit-repo-path>

Runs the Ordit pre-push gate: scope-check + semgrep against the Ordit repo.
Exits non-zero on any failure. Prints 'PRE-PUSH CHECKS PASSED' on success.

Arguments:
  <scope-file>       Path to a scope file listing allowed changed files/globs
  <ordit-repo-path>  Absolute or relative path to the Ordit git repository

Example:
  tools/ordit-prepush.sh clients/ordit/scope.txt ~/workspaces/ordit/be

Exit codes:
  0  All checks passed
  1  A check failed (scope violation or semgrep findings)
  2  Invalid arguments or missing prerequisites"

# --help / -h flag
if [[ "${1:-}" == "--help" || "${1:-}" == "-h" ]]; then
  echo "$USAGE"
  exit 0
fi

# Validate positional args are present
if [[ $# -lt 2 ]]; then
  echo "Error: missing required arguments." >&2
  echo "" >&2
  echo "$USAGE" >&2
  exit 2
fi

SCOPE_FILE="$1"
ORDIT_REPO_RAW="$2"

# Validate scope file exists and is readable
if [[ ! -f "$SCOPE_FILE" || ! -r "$SCOPE_FILE" ]]; then
  echo "Error: scope file '$SCOPE_FILE' does not exist or is not readable." >&2
  exit 2
fi

# Validate ordit repo path is a directory with .git
if [[ ! -d "$ORDIT_REPO_RAW" ]]; then
  echo "Error: ordit repo path '$ORDIT_REPO_RAW' is not a directory." >&2
  exit 2
fi
if [[ ! -d "$ORDIT_REPO_RAW/.git" ]]; then
  echo "Error: '$ORDIT_REPO_RAW' does not appear to be a git repository (no .git subdirectory)." >&2
  exit 2
fi

# Resolve to absolute path
ORDIT_REPO="$(cd "$ORDIT_REPO_RAW" && pwd)"

echo "==> Ordit pre-push checks: $SCOPE_FILE against $ORDIT_REPO"

# Step 1: fetch origin/uat in the Ordit repo
echo ""
echo "--- Step 1: git fetch origin uat ---"
git -C "$ORDIT_REPO" fetch origin uat

# Step 2: scope check
echo ""
echo "--- Step 2: scope check ---"
cd "$REPO_ROOT"
node tools/scope-check.js --scope-file "$SCOPE_FILE" --cwd "$ORDIT_REPO" --base origin/uat --head HEAD

# Step 3: semgrep
echo ""
echo "--- Step 3: semgrep ---"
cd "$REPO_ROOT"
if command -v semgrep >/dev/null 2>&1; then
  semgrep --config .semgrep/ordit/ruleset.yml --error --severity ERROR "$ORDIT_REPO/src"
else
  echo "WARNING: semgrep not installed; skipping semgrep stage. Install with: pip install semgrep" >&2
fi

echo ""
echo "PRE-PUSH CHECKS PASSED"
exit 0
