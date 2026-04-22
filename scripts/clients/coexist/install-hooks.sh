#!/usr/bin/env bash
# ============================================================================
# Installs the Coexist preflight as a local git pre-push hook.
#
# This is LOCAL ONLY - the hook is written to .git/hooks/pre-push inside the
# Coexist worktree on this VPS. It is NOT committed to EcodiaTate/coexist.
# Runs whenever `git push` is invoked against that worktree.
#
# Re-run this after any `git clone` / worktree reset / hook cleanup.
#
# Usage: ~/ecodiaos/scripts/clients/coexist/install-hooks.sh
# ============================================================================

set -euo pipefail

COEXIST_DIR="/home/tate/workspaces/coexist"
PREFLIGHT="/home/tate/ecodiaos/scripts/clients/coexist/preflight.sh"
HOOK_PATH="$COEXIST_DIR/.git/hooks/pre-push"

if [[ ! -d "$COEXIST_DIR/.git" ]]; then
  echo "ERROR: $COEXIST_DIR is not a git repo" >&2
  exit 1
fi

if [[ ! -x "$PREFLIGHT" ]]; then
  chmod +x "$PREFLIGHT"
fi

cat > "$HOOK_PATH" <<'HOOK'
#!/usr/bin/env bash
# Installed by ~/ecodiaos/scripts/clients/coexist/install-hooks.sh
# Runs the EcodiaOS Coexist preflight gate before every push.
# To bypass in an emergency: SKIP_COEXIST_PREFLIGHT=1 git push ...
# Bypasses should be logged in ~/ecodiaos/clients/coexist.md with a reason.

if [[ "${SKIP_COEXIST_PREFLIGHT:-0}" == "1" ]]; then
  echo "[coexist pre-push] SKIP_COEXIST_PREFLIGHT=1 - bypassing preflight (log why in coexist.md)"
  exit 0
fi

exec /home/tate/ecodiaos/scripts/clients/coexist/preflight.sh
HOOK

chmod +x "$HOOK_PATH"
echo "[coexist] installed pre-push hook at $HOOK_PATH"
