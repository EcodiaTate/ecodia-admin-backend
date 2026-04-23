#!/usr/bin/env bash
# Ordit-specific regression check: app-code must use AuthSource.COGNITO enum,
# never the string literal 'COGNITO' or "COGNITO" in === comparisons.
#
# Context: Eugene flagged this in PR 212 review, comment 785397910 (Apr 19).
# Five sites in src/ were using string-literal comparisons; we fixed them to
# enum comparisons. This check guards against regression.
#
# Allowed exceptions: assertions under any test/ directory or in *.spec.ts
# files can legitimately use string literals for HTTP-boundary assertions
# like expect(body).toHaveProperty('authSource', 'COGNITO').
#
# Expected CWD: the Ordit backend checkout (e.g. ~/workspaces/ordit/be).
# Exit 0 on pass, 1 on regression detected.

set -u

# Match === 'COGNITO'  or  'COGNITO' ===   (single or double quotes).
# Use two passes - one per quote style - to keep each regex simple.
hits_single=$(grep -rnE "=== *'COGNITO'|'COGNITO' *===" src/ 2>/dev/null \
  | grep -v '/test/' \
  | grep -v '\.spec\.ts' \
  || true)

hits_double=$(grep -rnE '=== *"COGNITO"|"COGNITO" *===' src/ 2>/dev/null \
  | grep -v '/test/' \
  | grep -v '\.spec\.ts' \
  || true)

if [ -n "$hits_single" ] || [ -n "$hits_double" ]; then
  echo "REGRESSION: string-literal 'COGNITO' comparisons found in src/"
  echo "(Eugene review nit 785397910 - use AuthSource.COGNITO enum instead)"
  echo ""
  [ -n "$hits_single" ] && echo "$hits_single"
  [ -n "$hits_double" ] && echo "$hits_double"
  exit 1
fi

exit 0
