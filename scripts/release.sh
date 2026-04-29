#!/usr/bin/env bash
#
# release.sh - autonomous app release driver
#
# End-to-end app release pipeline for Capacitor-wrapped Ecodia apps.
# iOS path: SSH into SY094 (MacInCloud Mac), xcodebuild archive + altool upload.
# Android path: local build on VPS, gradlew bundleRelease, fastlane supply to Play.
#
# Usage:
#   scripts/release.sh <slug> <platform> <env>
#
# Examples:
#   scripts/release.sh coexist ios testflight
#   scripts/release.sh coexist android internal-track
#   scripts/release.sh roam ios prod
#
# Doctrine references (READ THESE BEFORE EDITING):
#   ~/ecodiaos/clients/app-release-flow-ios.md       (per-step iOS flow)
#   ~/ecodiaos/clients/app-release-flow-android.md   (per-step Android flow)
#   ~/ecodiaos/clients/app-release-flow-new-app.md   (first-time app creation)
#   ~/ecodiaos/patterns/ios-signing-credential-paths.md
#   ~/ecodiaos/clients/macincloud-access.md
#
# Strategic context: this driver consolidates the Strategic_Direction
# "End-to-end app release pipeline as a productized service" (decided 2026-04-29).
#
# Behavioural guarantees:
#   - Reads all secrets from kv_store via psql against $DATABASE_URL.
#   - Fails loud on missing creds with the exact next-action for Tate.
#   - Never retry-loops on failure; surfaces the doctrine reference and exits non-zero.
#   - Refuses to ship a duplicate (same git commit + version-code/build-num).
#   - Tags the release commit and writes a kv_store + status_board record on success.
#

set -euo pipefail

# ---------------------------------------------------------------------------
# 0. Globals
# ---------------------------------------------------------------------------

ECODIAOS_ROOT="${ECODIAOS_ROOT:-$HOME/ecodiaos}"
WORKSPACES_ROOT="${WORKSPACES_ROOT:-$HOME/workspaces}"
FORK_ID="${FORK_ID:-$(hostname)-$$}"
NOW_UTC="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
NOW_AEST_TAG="$(TZ=Australia/Brisbane date +%Y%m%d-%H%M)"
NOW_AEST_HUMAN="$(TZ=Australia/Brisbane date '+%Y-%m-%d %H:%M AEST')"

# Colour-free banners (logs are commonly piped/redirected).
banner() {
  printf '\n=== %s ===\n' "$*"
}

step() {
  printf '\n--- %s\n' "$*"
}

err() {
  printf 'ERR: %s\n' "$*" >&2
}

die() {
  err "$@"
  exit 1
}

# ---------------------------------------------------------------------------
# 1. Argument parsing + validation
# ---------------------------------------------------------------------------

if [[ $# -ne 3 ]]; then
  cat >&2 <<USAGE
Usage: $0 <slug> <platform> <env>
  slug      - app slug (must exist as ~/workspaces/<slug>/fe/ or ~/workspaces/<slug>/)
  platform  - ios | android
  env       - testflight | prod | internal-track

Examples:
  $0 coexist ios testflight
  $0 coexist android internal-track
  $0 roam ios prod
USAGE
  exit 2
fi

SLUG="$1"
PLATFORM="$2"
ENV_TARGET="$3"

# Slug must be lowercase, ascii-clean, no separators (per new-app doctrine).
if [[ ! "$SLUG" =~ ^[a-z][a-z0-9]*$ ]]; then
  die "Slug '$SLUG' invalid. Must be lowercase ASCII, alphanumeric, no separators (per new-app doctrine)."
fi

# Resolve workspace path. Doctrine prescribes ~/workspaces/<slug>/fe/ but several
# real workspaces (coexist, etc.) are flat ~/workspaces/<slug>/. Accept both,
# preferring the doctrine layout when present.
if [[ -d "$WORKSPACES_ROOT/$SLUG/fe" ]]; then
  REPO_DIR="$WORKSPACES_ROOT/$SLUG/fe"
elif [[ -d "$WORKSPACES_ROOT/$SLUG" ]]; then
  REPO_DIR="$WORKSPACES_ROOT/$SLUG"
else
  die "Slug '$SLUG' not found at $WORKSPACES_ROOT/$SLUG/fe or $WORKSPACES_ROOT/$SLUG. Clone it first."
fi

case "$PLATFORM" in
  ios|android) ;;
  *) die "Platform '$PLATFORM' invalid. Must be ios or android." ;;
esac

case "$ENV_TARGET" in
  testflight|prod|internal-track) ;;
  *) die "Env '$ENV_TARGET' invalid. Must be testflight, prod, or internal-track." ;;
esac

# Cross-validate platform x env combinations.
if [[ "$PLATFORM" == "ios" && "$ENV_TARGET" == "internal-track" ]]; then
  die "iOS does not have an 'internal-track' env. Use 'testflight' or 'prod'."
fi
if [[ "$PLATFORM" == "android" && "$ENV_TARGET" == "testflight" ]]; then
  die "Android does not have a 'testflight' env. Use 'internal-track' or 'prod'."
fi

SLUG_UPPER="$(echo "$SLUG" | tr '[:lower:]' '[:upper:]')"

banner "Release: $SLUG / $PLATFORM / $ENV_TARGET"
echo "fork_id=$FORK_ID  ts=$NOW_AEST_HUMAN  repo=$REPO_DIR"

# ---------------------------------------------------------------------------
# 2. Source DATABASE_URL + define kv_store helpers
# ---------------------------------------------------------------------------

step "Loading DATABASE_URL from $ECODIAOS_ROOT/.env"

if [[ -f "$ECODIAOS_ROOT/.env" ]]; then
  # Only export DATABASE_URL; do not blanket-source untrusted .env content.
  DATABASE_URL_LINE="$(grep -E '^DATABASE_URL=' "$ECODIAOS_ROOT/.env" | head -1 || true)"
  if [[ -n "$DATABASE_URL_LINE" ]]; then
    export DATABASE_URL="${DATABASE_URL_LINE#DATABASE_URL=}"
    # Strip surrounding quotes if present.
    DATABASE_URL="${DATABASE_URL%\"}"
    DATABASE_URL="${DATABASE_URL#\"}"
  fi
fi

if [[ -z "${DATABASE_URL:-}" ]]; then
  die "DATABASE_URL not set. Ensure $ECODIAOS_ROOT/.env contains DATABASE_URL=postgres://... or export it before running."
fi

if ! command -v psql >/dev/null 2>&1; then
  die "psql not on PATH. Install postgresql-client (apt-get install -y postgresql-client) or run inside the ecodiaos-backend container."
fi

# kv_get_field <key> <field>
# Returns the JSON field of an object-valued kv_store entry (text->jsonb).
# Empty stdout on miss.
kv_get_field() {
  local k="$1" f="$2"
  psql "$DATABASE_URL" -tAX -v ON_ERROR_STOP=1 \
    -c "SELECT value::jsonb->>'$f' FROM kv_store WHERE key='$k' LIMIT 1;" 2>/dev/null \
    | tr -d '\r' \
    | sed -e 's/[[:space:]]*$//'
}

# kv_get_scalar <key>
# Returns the unwrapped value of a scalar JSON-encoded kv_store entry
# (e.g. value="\"6969\"" -> "6969"). Empty stdout on miss or non-string.
kv_get_scalar() {
  local k="$1"
  psql "$DATABASE_URL" -tAX -v ON_ERROR_STOP=1 \
    -c "SELECT value::jsonb #>> '{}' FROM kv_store WHERE key='$k' LIMIT 1;" 2>/dev/null \
    | tr -d '\r' \
    | sed -e 's/[[:space:]]*$//'
}

# kv_set <key> <value-as-text>
# Upsert helper. Caller is responsible for value being valid JSON.
kv_set() {
  local k="$1" v="$2"
  psql "$DATABASE_URL" -tAX -v ON_ERROR_STOP=1 \
    -c "INSERT INTO kv_store (key, value, updated_at) VALUES ('$k', '$v', NOW())
        ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value, updated_at=NOW();" >/dev/null
}

# require_cred <var> <description-of-where-to-get-it>
# Echoes a unified missing-cred message and exits.
require_cred() {
  local var="$1" hint="$2"
  cat >&2 <<EOF
ERR: required credential '$var' not set in kv_store.
HINT: $hint
SEE:  ~/ecodiaos/patterns/exhaust-laptop-route-before-declaring-tate-blocked.md
SEE:  ~/ecodiaos/clients/app-release-flow-${PLATFORM}.md
EOF
  exit 1
}

# ---------------------------------------------------------------------------
# 3. Pre-flight git state on the VPS workspace
# ---------------------------------------------------------------------------

step "Pre-flight: git state in $REPO_DIR"

cd "$REPO_DIR"
if [[ ! -d .git ]]; then
  die "$REPO_DIR is not a git repo."
fi

# Refuse to release with uncommitted changes - too easy to ship a dirty build.
if ! git diff --quiet HEAD || [[ -n "$(git status --porcelain)" ]]; then
  err "Uncommitted changes in $REPO_DIR. Commit or stash before releasing."
  git status --short >&2
  exit 1
fi

GIT_SHA="$(git rev-parse HEAD)"
GIT_SHA_SHORT="$(git rev-parse --short=12 HEAD)"
GIT_BRANCH="$(git rev-parse --abbrev-ref HEAD)"
echo "branch=$GIT_BRANCH  sha=$GIT_SHA_SHORT"

# Idempotency: refuse a duplicate release of the same commit + platform + env.
LAST_RELEASE_KEY="release.last.$SLUG.$PLATFORM"
LAST_RELEASE_SHA="$(kv_get_field "$LAST_RELEASE_KEY" 'commit' || true)"
LAST_RELEASE_ENV="$(kv_get_field "$LAST_RELEASE_KEY" 'env' || true)"
if [[ "$LAST_RELEASE_SHA" == "$GIT_SHA" && "$LAST_RELEASE_ENV" == "$ENV_TARGET" ]]; then
  die "Duplicate release: commit $GIT_SHA_SHORT already shipped to $SLUG/$PLATFORM/$ENV_TARGET. Bump a commit or use a different env target."
fi

# ---------------------------------------------------------------------------
# 4. Platform dispatch
# ---------------------------------------------------------------------------

if [[ "$PLATFORM" == "ios" ]]; then
  # =========================================================================
  # iOS PIPELINE
  # Per ~/ecodiaos/clients/app-release-flow-ios.md
  # =========================================================================

  step "iOS pre-flight: reading creds from kv_store"

  # creds.macincloud is a JSON object: {username, password, hostname, agent_token, ...}
  MAC_USER="$(kv_get_field 'creds.macincloud' 'username')"
  MAC_PASS="$(kv_get_field 'creds.macincloud' 'password')"
  MAC_HOST="$(kv_get_field 'creds.macincloud' 'hostname')"
  [[ -n "$MAC_USER" ]] || require_cred 'creds.macincloud.username' 'Update kv_store creds.macincloud with the SY094 SSH username from the MacInCloud control panel.'
  [[ -n "$MAC_PASS" ]] || require_cred 'creds.macincloud.password' 'Update kv_store creds.macincloud with the SY094 SSH password from the MacInCloud control panel. Password rotates - if SSH gives Permission denied, refresh it from the panel.'
  [[ -n "$MAC_HOST" ]] || require_cred 'creds.macincloud.hostname' 'Update kv_store creds.macincloud with the SY094 hostname (e.g. SY094.macincloud.com).'

  # Apple team ID. Doctrine treats "creds.apple.team_id" as a path; in practice
  # it lives under the JSON object at key 'creds.apple' with field 'team_id'.
  # Try the object form first, fall back to the literal-key form.
  APPLE_TEAM="$(kv_get_field 'creds.apple' 'team_id')"
  if [[ -z "$APPLE_TEAM" ]]; then
    APPLE_TEAM="$(kv_get_scalar 'creds.apple.team_id')"
  fi
  [[ -n "$APPLE_TEAM" ]] || require_cred 'creds.apple.team_id' 'Tate must provide the 10-char Apple team ID. Source: developer.apple.com > Membership page (visible after signing in to apple@ecodia.au). Store in kv_store as creds.apple = jsonb {"team_id":"XXXXXXXXXX"} or as the scalar key creds.apple.team_id. See app-release-flow-ios.md Step 0.'

  # ASC API key bundle.
  ASC_KEY_ID="$(kv_get_scalar 'creds.asc_api_key_id')"
  [[ -n "$ASC_KEY_ID" ]] || require_cred 'creds.asc_api_key_id' 'Tate must generate the App Store Connect API key at appstoreconnect.apple.com > Users and Access > Integrations > Keys > +. Store the 10-char Key ID at creds.asc_api_key_id. See ios-signing-credential-paths.md path 1.'

  ASC_ISSUER="$(kv_get_scalar 'creds.asc_api_issuer_id')"
  [[ -n "$ASC_ISSUER" ]] || require_cred 'creds.asc_api_issuer_id' 'Issuer ID (UUID) shown on the same App Store Connect Keys page as the API key. Store at creds.asc_api_issuer_id.'

  ASC_P8="$(kv_get_scalar 'creds.asc_api_key_p8')"
  [[ -n "$ASC_P8" ]] || require_cred 'creds.asc_api_key_p8' 'The .p8 file is downloadable ONCE when the API key is generated. Store full file contents (BEGIN/END lines included) at creds.asc_api_key_p8. If lost, revoke and regenerate the key.'

  step "iOS: SSH preflight to $MAC_USER@$MAC_HOST"

  if ! command -v sshpass >/dev/null 2>&1; then
    die "sshpass not on PATH. apt-get install -y sshpass (required for SY094 password auth)."
  fi

  # Define SSH/SCP wrappers as functions to avoid quoting hell.
  ssh_mac() {
    sshpass -p "$MAC_PASS" ssh -o PubkeyAuthentication=no -o StrictHostKeyChecking=accept-new -o ConnectTimeout=20 "$MAC_USER@$MAC_HOST" "$@"
  }
  rsync_to_mac() {
    # $1 = local path, $2 = remote path
    sshpass -p "$MAC_PASS" rsync -az --delete -e "ssh -o PubkeyAuthentication=no -o StrictHostKeyChecking=accept-new" "$1" "$MAC_USER@$MAC_HOST:$2"
  }

  if ! ssh_mac 'echo ok' | grep -q '^ok$'; then
    die "SSH to $MAC_USER@$MAC_HOST failed. Verify creds.macincloud.password is current; the panel rotates it."
  fi

  step "iOS: stage ASC API key on SY094 (~/.appstoreconnect/private_keys/AuthKey_${ASC_KEY_ID}.p8)"
  # Per app-release-flow-ios.md Step 1.
  # Pipe via stdin to avoid embedding the .p8 contents in a heredoc that ssh-quoting would mangle.
  printf '%s' "$ASC_P8" | ssh_mac "
    set -e
    mkdir -p ~/.appstoreconnect/private_keys
    cat > ~/.appstoreconnect/private_keys/AuthKey_${ASC_KEY_ID}.p8
    chmod 600 ~/.appstoreconnect/private_keys/AuthKey_${ASC_KEY_ID}.p8
  "

  step "iOS: verify ASC key works (xcrun altool --list-providers)"
  if ! ssh_mac "xcrun altool --list-providers --apiKey '$ASC_KEY_ID' --apiIssuer '$ASC_ISSUER' 2>&1" | tee /tmp/asc-providers.log | grep -qi 'Provider'; then
    cat /tmp/asc-providers.log >&2 || true
    die "ASC API key validation failed. Common causes: wrong Key ID/Issuer, key revoked, .p8 malformed. Re-stage from kv_store or regenerate."
  fi

  step "iOS: build web assets on VPS, then sync to SY094"
  # Per app-release-flow-ios.md Step 2.
  # Build on VPS (faster, lots of CPU). Then ship the built ios/ folder + the
  # node_modules subset that Capacitor needs at xcodebuild time across to SY094.
  cd "$REPO_DIR"
  npm install --no-audit --no-fund
  npm run build
  npx cap sync ios

  # Ensure the project exists on SY094.
  REMOTE_PROJ="\$HOME/projects/$SLUG"
  ssh_mac "mkdir -p ~/projects && cd ~/projects && [ -d $SLUG ] || git clone $(git config --get remote.origin.url) $SLUG"
  ssh_mac "cd ~/projects/$SLUG && git fetch && git checkout $GIT_SHA"

  # rsync the iOS folder + the Capacitor node_modules subset.
  # Per ~/ecodiaos/patterns/ (node_modules rsync workflow), only ship the
  # subset xcodebuild needs (~8MB) - shipping all of node_modules is wasteful.
  step "iOS: rsync ios/ + node_modules/@capacitor + node_modules/@capgo to SY094"
  rsync_to_mac "$REPO_DIR/ios/" "~/projects/$SLUG/ios/"
  if [[ -d "$REPO_DIR/node_modules/@capacitor" ]]; then
    rsync_to_mac "$REPO_DIR/node_modules/@capacitor/" "~/projects/$SLUG/node_modules/@capacitor/"
  fi
  if [[ -d "$REPO_DIR/node_modules/@capgo" ]]; then
    rsync_to_mac "$REPO_DIR/node_modules/@capgo/" "~/projects/$SLUG/node_modules/@capgo/"
  fi

  step "iOS: bump CFBundleVersion (build number)"
  # Per app-release-flow-ios.md Step 3.
  # Auto-increment: take the current value and +1. Caller can override via
  # BUILD_NUM env var if a specific number is required.
  if [[ -n "${BUILD_NUM:-}" ]]; then
    NEXT_BUILD_NUM="$BUILD_NUM"
  else
    CURRENT_BUILD="$(ssh_mac "cd ~/projects/$SLUG/ios/App && agvtool what-version -terse 2>/dev/null || echo 0" | head -1 | tr -d '[:space:]')"
    if [[ ! "$CURRENT_BUILD" =~ ^[0-9]+$ ]]; then
      die "Could not parse current build number from agvtool (got: '$CURRENT_BUILD')"
    fi
    NEXT_BUILD_NUM=$((CURRENT_BUILD + 1))
  fi
  echo "build_num: $NEXT_BUILD_NUM"
  ssh_mac "cd ~/projects/$SLUG/ios/App && agvtool new-version -all $NEXT_BUILD_NUM"

  step "iOS: xcodebuild archive (slow, 5-15 min)"
  # Per app-release-flow-ios.md Step 4.
  ARCHIVE_PATH="\$HOME/projects/$SLUG/ios/App/build/$SLUG.xcarchive"
  ssh_mac "set -e
    cd ~/projects/$SLUG/ios/App
    rm -rf build/
    xcodebuild \
      -workspace App.xcworkspace \
      -scheme App \
      -configuration Release \
      -archivePath build/$SLUG.xcarchive \
      -destination 'generic/platform=iOS' \
      -allowProvisioningUpdates \
      -authenticationKeyPath ~/.appstoreconnect/private_keys/AuthKey_${ASC_KEY_ID}.p8 \
      -authenticationKeyID '$ASC_KEY_ID' \
      -authenticationKeyIssuerID '$ASC_ISSUER' \
      DEVELOPMENT_TEAM='$APPLE_TEAM' \
      archive
  " || die "xcodebuild archive failed. Check the SSH output above for the actual cause. Common fixes in app-release-flow-ios.md 'Common failure modes' table."

  step "iOS: xcodebuild -exportArchive (produce .ipa)"
  # Per app-release-flow-ios.md Step 5. ExportOptions.plist must be committed
  # to the repo at ios/App/ExportOptions.plist (per Co-Exist PR #14 reference).
  ssh_mac "set -e
    cd ~/projects/$SLUG/ios/App
    test -f ExportOptions.plist || { echo 'ExportOptions.plist missing in ios/App/'; exit 1; }
    xcodebuild -exportArchive \
      -archivePath build/$SLUG.xcarchive \
      -exportOptionsPlist ExportOptions.plist \
      -exportPath build/export \
      -allowProvisioningUpdates \
      -authenticationKeyPath ~/.appstoreconnect/private_keys/AuthKey_${ASC_KEY_ID}.p8 \
      -authenticationKeyID '$ASC_KEY_ID' \
      -authenticationKeyIssuerID '$ASC_ISSUER'
  " || die "xcodebuild -exportArchive failed. Verify ios/App/ExportOptions.plist is committed and contains the correct teamID."

  step "iOS: upload IPA to App Store Connect (xcrun altool)"
  # Per app-release-flow-ios.md Step 6.
  ssh_mac "set -e
    cd ~/projects/$SLUG/ios/App
    IPA=\$(ls build/export/*.ipa | head -1)
    test -n \"\$IPA\" || { echo 'No .ipa produced in build/export/'; exit 1; }
    xcrun altool --upload-app \
      --type ios \
      --file \"\$IPA\" \
      --apiKey '$ASC_KEY_ID' \
      --apiIssuer '$ASC_ISSUER'
  " || die "altool --upload-app failed. Check ASC for processing errors. If 'Authentication failed (-22938)' the API key was rotated; re-stage."

  if [[ "$ENV_TARGET" == "prod" ]]; then
    cat <<EOF

Build uploaded. App Store Connect processes the build over 5-30 minutes.

Next manual steps for ENV_TARGET=prod (per app-release-flow-ios.md Step 8):
  1. App Store Connect > $SLUG > App Store > [+ Version]
  2. Fill version metadata (or use fastlane deliver if metadata is committed)
  3. Pick this build from TestFlight after Apple finishes processing
  4. Answer export compliance ('standard encryption only')
  5. Submit for Review (typically 24-48h)

These steps are GUI-only without fastlane. To automate, see
~/ecodiaos/clients/app-release-flow-ios.md 'Path to fully autonomous releases'.

EOF
  fi

  RELEASE_VERSION="ios-build-$NEXT_BUILD_NUM"

elif [[ "$PLATFORM" == "android" ]]; then
  # =========================================================================
  # ANDROID PIPELINE
  # Per ~/ecodiaos/clients/app-release-flow-android.md
  # =========================================================================

  step "Android pre-flight: reading creds from kv_store"

  KEYSTORE_B64="$(kv_get_field "creds.android.$SLUG" 'keystore_b64')"
  [[ -n "$KEYSTORE_B64" ]] || require_cred "creds.android.$SLUG.keystore_b64" "Tate must back up the upload keystore for $SLUG to kv_store as base64. On the machine that has $SLUG-release.jks: base64 -w0 $SLUG-release.jks. Store at creds.android.$SLUG = jsonb {keystore_b64, keystore_password, key_alias, key_password}. See app-release-flow-android.md Step 3."

  KEYSTORE_PASSWORD="$(kv_get_field "creds.android.$SLUG" 'keystore_password')"
  [[ -n "$KEYSTORE_PASSWORD" ]] || require_cred "creds.android.$SLUG.keystore_password" "Store at creds.android.$SLUG.keystore_password. If lost, you must roll the upload key under Play App Signing's key upgrade flow."

  KEY_ALIAS="$(kv_get_field "creds.android.$SLUG" 'key_alias')"
  [[ -n "$KEY_ALIAS" ]] || require_cred "creds.android.$SLUG.key_alias" "Store at creds.android.$SLUG.key_alias (typically the slug itself, e.g. '$SLUG')."

  KEY_PASSWORD="$(kv_get_field "creds.android.$SLUG" 'key_password')"
  [[ -n "$KEY_PASSWORD" ]] || require_cred "creds.android.$SLUG.key_password" "Store at creds.android.$SLUG.key_password (often the same as keystore_password)."

  # Service account JSON only required if shipping to Play (not for builds-only).
  PLAY_SA_JSON="$(kv_get_scalar 'creds.google_play_service_account_json')"
  [[ -n "$PLAY_SA_JSON" ]] || require_cred 'creds.google_play_service_account_json' 'Generate at Play Console > Setup > API access > Service accounts. Grant Release Manager role. Download JSON and store full file contents at creds.google_play_service_account_json. See app-release-flow-android.md "Path to autonomy".'

  # Required tooling.
  command -v fastlane >/dev/null 2>&1 || die "fastlane not on PATH. gem install fastlane (or use a Ruby toolchain that has it). Required for Play Developer API uploads."
  command -v base64 >/dev/null 2>&1 || die "base64 not on PATH (??). Coreutils missing."

  step "Android: build web assets and capacitor sync"
  # Per app-release-flow-android.md Step 2.
  cd "$REPO_DIR"
  npm install --no-audit --no-fund
  if npm run | grep -qE '^  build:android'; then
    npm run build:android
  else
    npm run build
  fi
  npx cap sync android

  step "Android: restore keystore from kv_store"
  # Per app-release-flow-android.md Step 3.
  KEYSTORE_PATH="$REPO_DIR/android/app/$SLUG-release.jks"
  printf '%s' "$KEYSTORE_B64" | base64 -d > "$KEYSTORE_PATH"
  if [[ ! -s "$KEYSTORE_PATH" ]]; then
    die "Keystore decode produced empty file at $KEYSTORE_PATH. Check kv_store creds.android.$SLUG.keystore_b64 is valid base64."
  fi
  chmod 600 "$KEYSTORE_PATH"
  trap 'rm -f "$KEYSTORE_PATH"' EXIT

  step "Android: bump versionCode in android/app/build.gradle"
  # Per app-release-flow-android.md Step 1.
  if [[ -n "${VERSION_CODE:-}" ]]; then
    NEXT_VERSION_CODE="$VERSION_CODE"
  else
    CURRENT_VERSION_CODE="$(grep -E '^[[:space:]]*versionCode ' "$REPO_DIR/android/app/build.gradle" | head -1 | awk '{print $2}')"
    if [[ ! "$CURRENT_VERSION_CODE" =~ ^[0-9]+$ ]]; then
      die "Could not parse current versionCode from android/app/build.gradle (got: '$CURRENT_VERSION_CODE')"
    fi
    NEXT_VERSION_CODE=$((CURRENT_VERSION_CODE + 1))
  fi
  echo "version_code: $NEXT_VERSION_CODE"
  sed -i.bak -E "s/^([[:space:]]*)versionCode [0-9]+/\\1versionCode $NEXT_VERSION_CODE/" "$REPO_DIR/android/app/build.gradle"
  rm -f "$REPO_DIR/android/app/build.gradle.bak"

  step "Android: gradlew bundleRelease"
  # Per app-release-flow-android.md Step 4.
  # The signing config in android/app/build.gradle reads from env vars
  # named ${SLUG_UPPER}_KEYSTORE_PASSWORD and ${SLUG_UPPER}_KEY_PASSWORD.
  # Export those, plus the legacy COEXIST_* names if slug is coexist (some
  # gradle files were authored before the generic pattern landed).
  cd "$REPO_DIR/android"
  export "${SLUG_UPPER}_KEYSTORE_PASSWORD=$KEYSTORE_PASSWORD"
  export "${SLUG_UPPER}_KEY_PASSWORD=$KEY_PASSWORD"
  ./gradlew --no-daemon clean bundleRelease

  AAB_PATH="$REPO_DIR/android/app/build/outputs/bundle/release/app-release.aab"
  if [[ ! -s "$AAB_PATH" ]]; then
    die "Expected $AAB_PATH after bundleRelease, not found. Check the gradle output above."
  fi

  step "Android: upload to Play Console via fastlane supply"
  # Per app-release-flow-android.md Step 6 / 'Path to autonomy'.
  PLAY_SA_FILE="$(mktemp /tmp/play-sa.XXXXXX.json)"
  printf '%s' "$PLAY_SA_JSON" > "$PLAY_SA_FILE"
  chmod 600 "$PLAY_SA_FILE"

  # Decide track from ENV_TARGET. Prod = production track.
  case "$ENV_TARGET" in
    internal-track) FASTLANE_TRACK="internal" ;;
    prod)           FASTLANE_TRACK="production" ;;
    *)              die "Unreachable: ENV_TARGET '$ENV_TARGET' should have been validated above." ;;
  esac

  PACKAGE_NAME="$(grep -E '^[[:space:]]*applicationId' "$REPO_DIR/android/app/build.gradle" | head -1 | awk -F\" '{print $2}')"
  if [[ -z "$PACKAGE_NAME" ]]; then
    die "Could not parse applicationId from android/app/build.gradle. Check the file."
  fi
  echo "package_name: $PACKAGE_NAME  track: $FASTLANE_TRACK"

  # supply uploads the AAB and rolls out to the chosen track.
  fastlane supply \
    --aab "$AAB_PATH" \
    --track "$FASTLANE_TRACK" \
    --json_key "$PLAY_SA_FILE" \
    --package_name "$PACKAGE_NAME" \
    --skip_upload_metadata true \
    --skip_upload_changelogs true \
    --skip_upload_images true \
    --skip_upload_screenshots true \
    || { rm -f "$PLAY_SA_FILE"; die "fastlane supply failed. Common causes: SA missing Release Manager role, package_name mismatch, AAB signed with wrong key. See app-release-flow-android.md."; }

  rm -f "$PLAY_SA_FILE"

  RELEASE_VERSION="android-vc-$NEXT_VERSION_CODE"

else
  die "Unreachable: PLATFORM '$PLATFORM' should have been validated above."
fi

# ---------------------------------------------------------------------------
# 5. Post-ship: tag, kv_store log, status_board update
# ---------------------------------------------------------------------------

banner "Post-ship: tag + log + status_board"

cd "$REPO_DIR"

TAG_NAME="release-$SLUG-$PLATFORM-$ENV_TARGET-$NOW_AEST_TAG"
step "Tagging git: $TAG_NAME"
git tag -a "$TAG_NAME" -m "Release $SLUG / $PLATFORM / $ENV_TARGET ($RELEASE_VERSION) at $NOW_AEST_HUMAN [$FORK_ID]"
if git remote get-url origin >/dev/null 2>&1; then
  git push origin "$TAG_NAME" || err "git push origin $TAG_NAME failed (non-fatal). Push manually if you need the tag on the remote."
else
  err "No origin remote configured; tag is local only."
fi

step "Updating kv_store: $LAST_RELEASE_KEY"
# Build the JSON value with python3 to avoid quoting hazards from sed/awk.
KV_VALUE_JSON="$(python3 - <<PYEOF
import json
print(json.dumps({
    "commit": "$GIT_SHA",
    "version": "$RELEASE_VERSION",
    "ts": "$NOW_UTC",
    "env": "$ENV_TARGET",
    "platform": "$PLATFORM",
    "tag": "$TAG_NAME",
    "fork_id": "$FORK_ID",
}))
PYEOF
)"
# psql escaping: single-quote-escape the JSON.
KV_VALUE_ESCAPED="${KV_VALUE_JSON//\'/\'\'}"
kv_set "$LAST_RELEASE_KEY" "$KV_VALUE_ESCAPED"

step "Inserting status_board row"
STATUS_NAME="Release shipped: $SLUG $PLATFORM -> $ENV_TARGET ($RELEASE_VERSION)"
STATUS_NAME_ESCAPED="${STATUS_NAME//\'/\'\'}"
STATUS_CONTEXT="commit=$GIT_SHA_SHORT tag=$TAG_NAME fork_id=$FORK_ID released_at=$NOW_AEST_HUMAN"
STATUS_CONTEXT_ESCAPED="${STATUS_CONTEXT//\'/\'\'}"
psql "$DATABASE_URL" -tAX -v ON_ERROR_STOP=1 -c "
  INSERT INTO status_board (entity_type, entity_ref, name, status, next_action, next_action_by, last_touched, context, priority)
  VALUES ('task', 'release:$SLUG:$PLATFORM:$ENV_TARGET', '$STATUS_NAME_ESCAPED', 'shipped',
          'Verify smoke-test on TestFlight/Play Internal', 'tate', NOW(), '$STATUS_CONTEXT_ESCAPED', 3);
" >/dev/null || err "status_board insert failed (non-fatal)."

cat <<EOF

=== DONE ===
slug:     $SLUG
platform: $PLATFORM
env:      $ENV_TARGET
version:  $RELEASE_VERSION
commit:   $GIT_SHA_SHORT
tag:      $TAG_NAME
when:     $NOW_AEST_HUMAN
fork_id:  $FORK_ID

Smoke-test next:
EOF

if [[ "$PLATFORM" == "ios" ]]; then
  cat <<EOF
  - Open TestFlight on the test device (Tate's iPhone). The new build appears
    once Apple finishes processing (5-30 min).
  - Install + smoke-test the actual change shipped, plus auth + push paths.
  - For ENV_TARGET=prod, the App Store metadata + submission steps are GUI-only
    until fastlane deliver is wired. See ~/ecodiaos/clients/app-release-flow-ios.md.
EOF
else
  cat <<EOF
  - Open Play Console > $SLUG > Testing > Internal testing. The build should be
    rolling out within 5-10 min.
  - Install via the internal opt-in link on a real Android device.
  - Smoke-test, then promote internal -> closed -> open -> production via the
    'Promote release' button or another scripts/release.sh run with env=prod.
EOF
fi
