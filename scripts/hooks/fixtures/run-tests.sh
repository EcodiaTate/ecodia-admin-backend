#!/usr/bin/env bash
# run-tests.sh - smoke tests for brief-consistency-check.sh
#
# For each fixture file, runs the hook with the fixture as stdin and asserts:
#   - pass-*.json fixtures must produce ZERO warnings on stderr.
#   - fail-*.json fixtures must produce AT LEAST ONE warning on stderr.
#
# Also asserts that the entire test pass completes in well under the 200ms
# per-invocation budget (we measure the slowest single invocation).
#
# Exit code: 0 on all green, 1 on any fixture failure or perf regression.

set -u

HOOK="$(cd "$(dirname "$0")/.." && pwd)/brief-consistency-check.sh"
FIXTURES_DIR="$(cd "$(dirname "$0")" && pwd)"

if [ ! -x "$HOOK" ]; then
  echo "FAIL: hook not executable at $HOOK"
  exit 1
fi

pass=0
fail=0
slowest_ms=0
slowest_fixture=""

for f in "$FIXTURES_DIR"/pass-*.json "$FIXTURES_DIR"/fail-*.json; do
  [ -f "$f" ] || continue
  name=$(basename "$f")
  expect="${name%%-*}"  # 'pass' or 'fail'

  start_ns=$(date +%s%N)
  stderr_out=$(cat "$f" | "$HOOK" 2>&1 >/dev/null)
  end_ns=$(date +%s%N)
  elapsed_ms=$(( (end_ns - start_ns) / 1000000 ))

  if [ "$elapsed_ms" -gt "$slowest_ms" ]; then
    slowest_ms="$elapsed_ms"
    slowest_fixture="$name"
  fi

  warning_count=$(echo "$stderr_out" | grep -c '\[BRIEF-CHECK WARN\]' || true)

  if [ "$expect" = "pass" ]; then
    if [ "$warning_count" -eq 0 ]; then
      printf "  [PASS] %-40s (%dms, no warnings)\n" "$name" "$elapsed_ms"
      pass=$((pass + 1))
    else
      printf "  [FAIL] %-40s expected 0 warnings, got %d:\n" "$name" "$warning_count"
      echo "$stderr_out" | sed 's/^/         /'
      fail=$((fail + 1))
    fi
  else
    if [ "$warning_count" -ge 1 ]; then
      printf "  [PASS] %-40s (%dms, %d warning(s) as expected)\n" "$name" "$elapsed_ms" "$warning_count"
      pass=$((pass + 1))
    else
      printf "  [FAIL] %-40s expected >=1 warning, got 0\n" "$name"
      fail=$((fail + 1))
    fi
  fi
done

echo ""
echo "  ${pass} passed, ${fail} failed. slowest: ${slowest_fixture} (${slowest_ms}ms)"

if [ "$slowest_ms" -gt 200 ]; then
  echo "  PERF REGRESSION: slowest invocation ${slowest_ms}ms exceeds 200ms budget"
  exit 1
fi

if [ "$fail" -gt 0 ]; then
  exit 1
fi

exit 0
