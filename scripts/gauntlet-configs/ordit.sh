# Gauntlet config - Ordit backend (fireauditors1/be)
#
# Sourced by scripts/client-push-gauntlet.sh. Must export the config contract
# variables. Keep this file additive - do not add commands without ensuring
# Ordit's Bitbucket CI (bitbucket-pipelines.yml :: build-and-test) also runs
# them, unless they are clearly marked as EXTRA_STEPS that exceed CI.
#
# Last verified against HEAD 24ab453 on feat/cognito-be-integration,
# Apr 23 2026 15:09 AEST. If the project's CI config changes, update this
# file and re-verify.

export WORKDIR="$HOME/workspaces/ordit/be"
export BASE_BRANCH="uat"

# NODE_ENV trap - VPS default is production which skips devDeps.
# Leave empty to accept the gauntlet default (development).
export NODE_ENV_OVERRIDE="development"
export NODE_OPTIONS="--max-old-space-size=4096"

# --- CI-parity commands (mirror bitbucket-pipelines.yml build-and-test) ---
# yarn install --frozen-lockfile enforces zero drift on yarn.lock.
export INSTALL_CMD='yarn install --frozen-lockfile'

# prisma generate is required because TS compilation depends on the generated
# @prisma/client types. Without it, tsc fails with missing-module errors.
export PRE_BUILD_CMD='npx prisma generate'

# yarn format runs prettier via their script. Must leave git status clean
# (the gauntlet checks this as a separate step).
export FORMAT_CMD='yarn format'

# tsc --noEmit catches type errors that nest build sometimes swallows.
# This is an EXTRA check beyond Ordit CI. nest build does compile but
# --noEmit is stricter about unused locals etc.
export TYPECHECK_CMD='node_modules/.bin/tsc --noEmit'

export LINT_CMD='yarn lint'
export TEST_CMD='yarn test'
export BUILD_CMD='yarn build'

# --- Ordit-specific extras beyond CI parity ---
# Format: "name|cmd||name2|cmd2"   (double-pipe separates steps)
#
# 1. AuthSource-string-literal regression check. Eugene flagged string-
#    literal 'COGNITO' comparisons in his Apr 19 review (comment 785398791).
#    App-code comparisons MUST use AuthSource.COGNITO. HTTP-boundary test
#    assertions like toHaveProperty('authSource', 'COGNITO') are allowed.
#
# 2. Cognito integration sanity - ensure AuthSource enum + authSource column
#    are still present in schema.prisma (i.e. the feature wasn't accidentally
#    reverted).
export EXTRA_STEPS='authsource-string-literal-regression|bash -c "hits=\$(grep -rnE \"=== *[\x27\\x22]COGNITO[\x27\\x22]|[\x27\\x22]COGNITO[\x27\\x22] *===\" src/ 2>/dev/null | grep -v test/ | grep -v spec.ts || true); if [ -n \"\$hits\" ]; then echo \"string-literal COGNITO found in src/ (Eugene nit 785398791):\"; echo \"\$hits\"; exit 1; fi"||authsource-enum-still-in-schema|bash -c "grep -q \"enum AuthSource\" prisma/schema.prisma && grep -q \"authSource *AuthSource\" prisma/schema.prisma"'
