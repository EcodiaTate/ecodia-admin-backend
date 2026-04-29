---
triggers: android, keystore, jks, play console, fastlane, android-signing, coexist-android, roam-android, android-release, aab, bundletool, upload-key, .jks, keystore_b64, keystore_password
class: programmatic-required
owner: tate
---

# creds.android.{slug} - PENDING

**Status: PENDING. Rows do NOT exist in kv_store.** Required for Android release pipeline (`scripts/release.sh` Android branch). On Tate's punch list to back up upload keystores from his 1Password into kv_store.

## Expected schema (per slug)

```
creds.android.coexist = {
  keystore_b64,         # base64-encoded .jks file contents
  keystore_password,    # store password
  key_alias,            # e.g. 'coexist'
  key_password,         # key password (often == store password)
  created_at
}
```

Same schema for `creds.android.roam`, `creds.android.{future_slug}`.

## Source

- Existing keystores live on:
  - `~/workspaces/coexist/android/app/coexist-release.jks` (or wherever Tate has it)
  - `~/workspaces/roam-frontend/roam-release.keystore`
- Passwords are in Tate's 1Password vault.

## Used by (will be, once provisioned)

- `~/ecodiaos/scripts/release.sh:605-615` (Android signing branch)
- `~/ecodiaos/clients/app-release-flow-android.md:51-55, 115-120`
- `~/ecodiaos/clients/app-release-flow-new-app.md:183`
- `~/ecodiaos/clients/release-candidate-analysis-2026-04-29.md:79, 221`

## Replaceable by macro?

The signing step itself is NOT macro-replaceable - `gradle signingConfigs` and `apksigner` need the keystore file present at build time. So programmatic credentials are required for unattended Android builds.

The PLAY CONSOLE UPLOAD step IS macro-replaceable (drag-drop in the dashboard via Tate's Chrome on Corazon), so `creds.google_play_service_account_json` is demoted to fallback per the GUI-macro doctrine. But the keystore itself must be present locally during the build.

## Rotation

Android upload keys do NOT auto-rotate. They live for the lifetime of the app on Play Store. If lost, recovery is via Play App Signing's key upgrade flow (slow, requires Play support intervention).

## Restoration if lost

This is the row's reason for existing. The .jks file itself is the source of truth; if the file is lost, the upload key is unrecoverable except via Play App Signing key upgrade.

## Provisioning steps (for Tate to run when populating)

```bash
# On the machine that has the .jks file
SLUG=coexist
KEYSTORE_FILE="$HOME/workspaces/$SLUG/android/app/$SLUG-release.jks"
KEYSTORE_B64=$(base64 -w0 "$KEYSTORE_FILE")
# Get keystore_password, key_alias, key_password from 1Password

# Then UPSERT (Tate runs this; agent does not have authority to mutate kv_store on its own):
INSERT INTO kv_store (key, value)
VALUES (
  'creds.android.coexist',
  jsonb_build_object(
    'keystore_b64', '<KEYSTORE_B64>',
    'keystore_password', '<from 1Password>',
    'key_alias', 'coexist',
    'key_password', '<from 1Password>',
    'created_at', NOW()
  )
)
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value;
```

Repeat for `creds.android.roam`.

## Failure mode while pending

`scripts/release.sh` Android branch errors at preflight:
```
require_cred 'creds.android.$SLUG.keystore_b64' "Tate must back up the upload keystore for $SLUG to kv_store as base64..."
```

iOS branch unaffected.
