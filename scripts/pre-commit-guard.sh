#!/usr/bin/env bash
# pre-commit-guard.sh — refuse to commit files that contain git merge conflict markers.
#
# Why this exists:
#   Twice in one day (2026-04-23) a conflict-marked file got committed to HEAD
#   and crashed ecodia-api on boot:
#     - src/services/osSessionService.js (during audit work)
#     - src/middleware/errorHandler.js (during Factory sync)
#   In both cases Node's parser choked on `<<<<<<< HEAD` and the whole process
#   died in a crash loop until the file was hand-patched.
#
# What this does:
#   Scans every staged file's ADDED lines for conflict markers. If any match,
#   print a clear error and exit non-zero so git aborts the commit.
#
# What it deliberately does NOT do:
#   - Run full lint/typecheck (too slow for a pre-commit).
#   - Touch unstaged files (scope = what you're about to commit).
#   - Modify files (human resolves conflicts, the hook only blocks).
#
# Install via: bash backend/scripts/install-git-hooks.sh

set -uo pipefail

# Must run inside a git repo.
if ! git rev-parse --git-dir >/dev/null 2>&1; then
  echo "✖ pre-commit-guard: not inside a git repository"
  exit 1
fi

# Only inspect lines being ADDED to the index (not the full diff context), so
# conflict markers already existing in a file won't re-trigger — but we will
# catch any new addition, which is the actual bug we saw.
# set +e around the grep because grep exits 1 when no matches found, which is
# the SUCCESS case for this guard — we only fail when there ARE matches.
conflict_lines=$(git diff --cached --unified=0 2>/dev/null | grep -En '^\+(<{7} |={7}$|>{7} )') || true

if [ -n "${conflict_lines:-}" ]; then
  echo ""
  echo "✖ pre-commit-guard: refusing to commit — staged files contain merge conflict markers"
  echo ""
  echo "Offending lines (in the staged diff):"
  echo "$conflict_lines" | sed 's/^/  /'
  echo ""
  echo "Resolve the conflict first, then re-stage and commit."
  echo "If you're absolutely sure this is a false positive:"
  echo "  git commit --no-verify   # NOT RECOMMENDED"
  echo ""
  exit 1
fi

exit 0
