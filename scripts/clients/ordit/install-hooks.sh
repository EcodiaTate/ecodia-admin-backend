#!/usr/bin/env bash
# ============================================================================
# Installs the Ordit preflight as a local git pre-push hook.
#
# This is LOCAL ONLY - the hook is written to .git/hooks/pre-push inside the
# Ordit worktree on this VPS. It is NOT committed to fireauditors1/be.
# Runs whenever `git push` is invoked against that worktree.
#
# Re-run this after any `git clone` / worktree reset / hook cleanup.
#
# Usage: ~/ecodiaos/scripts/clients/ordit/install-hooks.sh
# ============================================================================

set -euo pipefail

ORDIT_DIR="/home/tate/workspaces/ordit/be"
PREFLIGHT="/home/tate/ecodiaos/scripts/clients/ordit/preflight.sh"
HOOK_PATH="$ORDIT_DIR/.git/hooks/pre-push"

if [[ ! -d "$ORDIT_DIR/.git" ]]; then
  echo "ERROR: $ORDIT_DIR is not a git repo" >&2
  exit 1
fi

if [[ ! -x "$PREFLIGHT" ]]; then
  chmod +x "$PREFLIGHT"
fi

cat > "$HOOK_PATH" <<'HOOK'
#!/usr/bin/env bash
# Installed by ~/ecodiaos/scripts/clients/ordit/install-hooks.sh
# Runs the EcodiaOS Ordit preflight gate before every push.
# To bypass in an emergency: SKIP_ORDIT_PREFLIGHT=1 git push ...
# Bypasses should be logged in ~/ecodiaos/clients/ordit.md with a reason.

if [[ "${SKIP_ORDIT_PREFLIGHT:-0}" == "1" ]]; then
  echo "[ordit pre-push] SKIP_ORDIT_PREFLIGHT=1 - bypassing preflight (log why in ordit.md)"
  exit 0
fi

exec /home/tate/ecodiaos/scripts/clients/ordit/preflight.sh
HOOK

chmod +x "$HOOK_PATH"

echo "installed: $HOOK_PATH"
echo "        -> /home/tate/ecodiaos/scripts/clients/ordit/preflight.sh"
echo ""
echo "verify with: ls -la $HOOK_PATH"
echo "test run:    $PREFLIGHT"
echo "bypass:      SKIP_ORDIT_PREFLIGHT=1 git push ...  (log the bypass)"
