---
triggers: play-console, gradle-bundlerelease, .aab, .jks, capacitor-android-release, coexist-android-release, roam-android-release, fastlane-supply, play-developer-api, play-app-signing, versioncode-bump, target-sdk-floor, COEXIST_KEYSTORE_PASSWORD
---

# Android App Release Flow - Doctrine

End-to-end flow for shipping an Ecodia (or client) Android app to Google Play Console. Capacitor-wrapped Vite/React/Next webview is the default Ecodia stack; native-Kotlin is out of scope for this doc.

Read this BEFORE any Android release work. Companion docs: `app-release-flow-new-app.md` (first-time app creation), `app-release-flow-ios.md` (iOS counterpart).

---

## Overview

The Android release path has four phases:

1. **Build** - Capacitor sync + Gradle assemble a signed `.aab` (Android App Bundle).
2. **Sign** - Gradle uses the project keystore + per-app passwords from env vars.
3. **Upload** - `.aab` goes to Play Console either via the web UI (default today) or the Play Developer API (target state for autonomous releases).
4. **Promote** - Internal track > Closed track > Open track > Production, with rollout %.

Total wall time for a routine update: 25-40 minutes from `git pull` to "rolled out to internal track". First production submission for a new app: 1-3 days for review.

---

## Prerequisites

### Account state (one-time, already done for Ecodia)
- Google Play Developer account: $25 USD one-time, paid. Tate is the registered developer (personal Google account, not a workspace account).
- Developer Distribution Agreement signed.

### Per-app state (verify before first build)
- App entry exists in Play Console (`https://play.google.com/console`).
- Internal testing track has at least one tester (Tate's personal Gmail) so you can install the AAB on a real device for smoke-test before promoting.
- Privacy policy URL is reachable on `https://ecodia.au/privacy/{slug}` or the client's own domain (Play rejects builds without one).
- Data safety form filled in Play Console (you cannot promote past Internal without it).
- Content rating completed (IARC questionnaire, takes 5 mins).
- App signing key managed by Google (Play App Signing). Our upload key signs the `.aab`; Google re-signs with the app signing key before delivery to devices. **Always opt in to Play App Signing.**

### Tooling
| Tool | Where it lives | Notes |
|------|----------------|-------|
| Node 20+ + npm | Corazon, SY094, VPS | Capacitor build runs in Node |
| Android SDK Platform 34, Build-Tools 34 | Corazon (`D:\Android\Sdk`) and SY094 | Required for `gradlew bundleRelease` |
| Android Studio | Corazon and SY094 | Optional - only needed for first-time keystore generation, emulator runs, manual signed-bundle wizard |
| `bundletool` (optional) | VPS | Convert `.aab` to `.apks` for local install testing |
| `gcloud` CLI (optional) | VPS | Use this once Play Developer API is wired for autonomous uploads |

### Credentials (canonical kv_store paths)

**Currently stored:** none of the Android signing/upload credentials are in kv_store yet. Surface this as a status_board P2: any keystore lives only on Tate's machines and can be lost. See "Critical gaps" section at the bottom.

Target kv_store layout once populated:
```
creds.android.{slug}.keystore_b64        # base64-encoded .jks file contents
creds.android.{slug}.keystore_password   # store password
creds.android.{slug}.key_alias           # e.g. 'coexist', 'roam'
creds.android.{slug}.key_password        # key password (often == store password)
creds.google_play_service_account_json   # service account JSON for Play Developer API uploads (one per Google Play developer account, shared across apps)
```

The signing config in `android/app/build.gradle` already reads from env vars (`COEXIST_KEYSTORE_PASSWORD`, `COEXIST_KEY_PASSWORD` for Co-Exist; pattern is `{SLUG_UPPER}_KEYSTORE_PASSWORD` and `{SLUG_UPPER}_KEY_PASSWORD`). Build scripts must export these from kv_store.

---

## Workspace convention

VPS working copies:
- `~/workspaces/{slug}/fe/` - frontend repo (Capacitor lives here, in `android/`)
- `~/workspaces/{slug}/be/` - backend if separate

Keystore lives at `android/app/{slug}-release.jks` inside the repo and is **gitignored**. Do not commit the `.jks` file. Do not commit env files containing the password. The `.jks` is restored from kv_store before builds.

Real examples in the wild:
- `~/workspaces/coexist/android/app/coexist-release.jks` (committed locally on Corazon, NOT in kv_store yet - status_board gap)
- `~/workspaces/roam-frontend/roam-release.keystore` (root level, also not in kv_store)

---

## Build flow - copy-pasteable, CLI-first

Run from the frontend repo root. Steps assume you've already done `git pull && npm install`.

### Step 1: Bump versions
```bash
SLUG=coexist
cd ~/workspaces/$SLUG/fe

# Bump versionCode (integer, must increase) and versionName (display string)
# These live in android/app/build.gradle - either hand-edit or use a script.
# Capacitor does NOT auto-propagate version from package.json to build.gradle.

# Quick CLI bump (increment versionCode by 1, set versionName explicitly):
NEW_VERSION_NAME="1.4.0"
NEW_VERSION_CODE=$(grep "versionCode " android/app/build.gradle | head -1 | awk '{print $2 + 1}')
sed -i.bak "s/versionCode .*/versionCode $NEW_VERSION_CODE/" android/app/build.gradle
sed -i.bak "s/versionName .*/versionName \"$NEW_VERSION_NAME\"/" android/app/build.gradle
rm android/app/build.gradle.bak
```

`versionCode` MUST increase on every Play upload. Play rejects same-or-lower codes. `versionName` is the human-visible string and can stay the same across hotfixes.

### Step 2: Build web assets and sync Capacitor
```bash
npm run build           # builds dist/ via vite
npx cap sync android    # copies dist/ into android/app/src/main/assets/public/
```

If the package has a `build:android` script, prefer that (it sets `CAPACITOR_BUILD=true` for env-aware builds).

### Step 3: Restore keystore + passwords from kv_store

Once the kv_store layout is populated:
```bash
SLUG=coexist
SLUG_UPPER=$(echo $SLUG | tr a-z A-Z)

# Pull keystore (base64) and write to disk
mcp_db_query "SELECT value::json->>'keystore_b64' FROM kv_store WHERE key='creds.android.$SLUG'" \
  | base64 -d > android/app/$SLUG-release.jks

# Export passwords
export ${SLUG_UPPER}_KEYSTORE_PASSWORD=$(mcp_db_query "SELECT value::json->>'keystore_password' FROM kv_store WHERE key='creds.android.$SLUG'")
export ${SLUG_UPPER}_KEY_PASSWORD=$(mcp_db_query "SELECT value::json->>'key_password' FROM kv_store WHERE key='creds.android.$SLUG'")
```

Until that's wired, Tate has the passwords in 1Password and you'll need them passed in directly.

### Step 4: Assemble signed AAB
```bash
cd android
./gradlew clean bundleRelease

# Output:
# android/app/build/outputs/bundle/release/app-release.aab
```

This is the artefact you upload to Play Console. Always `.aab`, never `.apk` (Play has required AAB since Aug 2021 for new apps).

For local install testing only, build an APK:
```bash
./gradlew assembleRelease
# android/app/build/outputs/apk/release/app-release.apk
```
Or convert the AAB:
```bash
bundletool build-apks --bundle=app/build/outputs/bundle/release/app-release.aab \
  --output=app-release.apks \
  --ks=app/coexist-release.jks --ks-key-alias=coexist \
  --ks-pass=pass:$COEXIST_KEYSTORE_PASSWORD --key-pass=pass:$COEXIST_KEY_PASSWORD
bundletool install-apks --apks=app-release.apks
```

### Step 5: Verify the AAB before upload
```bash
# Inspect manifest
bundletool dump manifest --bundle=android/app/build/outputs/bundle/release/app-release.aab \
  | grep -E "package|versionCode|versionName|targetSdk"

# Verify signing
jarsigner -verify -verbose -certs android/app/build/outputs/bundle/release/app-release.aab \
  | tail -20
```

Sanity: `package=` matches `appId` in `capacitor.config.ts`, `versionCode` is what you bumped, `targetSdkVersion` is at or above Play's current floor (35 as of late 2025).

### Step 6: Upload to Play Console

**Default today (web UI on Corazon):**
1. `~/ecodiaos/scripts/laptop nav https://play.google.com/console`
2. Pick the app > Testing > Internal testing > Create new release.
3. Drag the `.aab` from `D:\.code\{slug}\android\app\build\outputs\bundle\release\` into the upload zone.
4. Add release notes ("What's new in this version").
5. Save > Review > Roll out to Internal testing.

**Target state (autonomous via Play Developer API):** see "Path to autonomy" below.

### Step 7: Smoke-test on a real device
- Install via the Internal testing opt-in link on a real Android phone (Tate's, or an emulator if no device).
- Test the change you actually shipped + the critical paths (login, primary action, push notifications if relevant).
- Read logs: `adb logcat | grep -i {appname}` if anything looks wrong.

### Step 8: Promote
Each step in Play Console is a "Promote release" button:
- Internal > Closed (alpha) - small invite list
- Closed > Open (beta) - public opt-in
- Open > Production - rolled out to everyone, with optional staged rollout (start at 5-10%, ramp up)

Production submissions go through a Play review (typically a few hours, occasionally 1-3 days for first submission or after a policy flag).

---

## Path to autonomy - Play Developer API

Goal: replace the web-UI upload step with a CLI call so the whole flow runs from the VPS.

**Setup (one-time per Google Play developer account, takes ~15 mins):**

1. Enable Google Play Android Developer API in the Google Cloud project tied to the Play Console (Play Console > Setup > API access).
2. Create a service account in that project.
3. Grant the service account the "Release Manager" role in Play Console > Users and permissions.
4. Generate a JSON key for the service account, store at `creds.google_play_service_account_json` in kv_store.

**Upload via fastlane (recommended):**

```bash
# Install fastlane (one-time)
gem install fastlane

# Set up Fastfile in android/fastlane/Fastfile - see ~/ecodiaos/clients/app-release-flow-new-app.md

# Pull service account JSON to disk at build time
mcp_db_query "SELECT value FROM kv_store WHERE key='creds.google_play_service_account_json'" \
  > /tmp/play-sa.json

# Upload to internal track
cd ~/workspaces/$SLUG/fe/android
fastlane supply \
  --aab app/build/outputs/bundle/release/app-release.aab \
  --track internal \
  --json_key /tmp/play-sa.json \
  --package_name au.ecodia.$SLUG

rm /tmp/play-sa.json
```

**Promote via fastlane:**
```bash
fastlane supply \
  --track_promote_to production \
  --rollout 0.1 \
  --json_key /tmp/play-sa.json \
  --package_name au.ecodia.$SLUG
```

The `gcloud` CLI does not handle Play Console operations. Fastlane's `supply` action is the canonical CLI surface. Alternative: hit the API directly via `curl` against `https://androidpublisher.googleapis.com/androidpublisher/v3/applications/{packageName}/edits`.

---

## Common failure modes + fixes

| Symptom | Cause | Fix |
|---------|-------|-----|
| `Keystore was tampered with, or password was incorrect` | Wrong `KEYSTORE_PASSWORD` env var | Check kv_store, re-export. If the keystore itself is corrupted, you cannot recover; you must release with a NEW signing key under Play App Signing's key upgrade flow. |
| Play Console rejects with `Version code already exists` | `versionCode` not bumped | Increment in `android/app/build.gradle`, rebuild |
| Play Console rejects with `signed with the wrong key` | Built with the wrong keystore (e.g. fresh debug keystore) | Restore the right `.jks` from kv_store, rebuild |
| `Target SDK 33 must be 34 or higher` | `targetSdkVersion` outdated | Update `android/variables.gradle` and `android/app/build.gradle`, then `npx cap sync android` |
| Gradle daemon hangs on Corazon | Memory pressure (8GB RAM) | `cd android && ./gradlew --stop`, then retry. Build on SY094 or VPS instead. |
| `google-services.json not found` | Firebase config missing or placeholder | Pull real file from Firebase console, place at `android/app/google-services.json`, rebuild |
| `Default Capacitor splash screen showing` | `splash.png` in `drawable-*` folders is the placeholder | Run `node scripts/generate-splash.cjs` (Co-Exist pattern) - see `~/ecodiaos/clients/coexist.md` |
| `INSTALL_FAILED_UPDATE_INCOMPATIBLE` on local APK install | Old version of the app installed and signed with debug key | `adb uninstall {package}` first |
| Play upload silently succeeds but version doesn't appear | You uploaded to a track but didn't roll out | Click "Review release" then "Roll out" |
| `Cannot perform an interactive login from a non TTY device` (fastlane) | Service account JSON not provided | Pass `--json_key` explicitly |

---

## Time-box estimates

| Step | First-app time | Routine update time |
|------|----------------|---------------------|
| Version bump + build | 5 min | 2 min |
| Capacitor sync + Gradle bundleRelease | 5-10 min | 3-5 min |
| Sign + verify AAB | 1 min | 1 min |
| Play Console upload (web UI on Corazon) | 5 min | 3 min |
| Real-device smoke test | 10-15 min | 5 min |
| Promote to closed/open | 2 min per hop | 2 min per hop |
| Production review wait | 1-3 days | a few hours |

**Total wall time to internal track:** ~25 min routine, ~45 min first time.

---

## Real apps + state (snapshot 2026-04-29)

| App | Bundle ID | Play Console state | Notes |
|-----|-----------|--------------------|-------|
| Co-Exist | `org.coexistaus.app` | App entry exists, internal testing track active. Latest production track state: needs verification. | Keystore at `android/app/coexist-release.jks` on Corazon. Passwords NOT in kv_store yet (P2 gap). |
| Roam | `au.ecodia.roam` | App entry exists. Production blocked on GST registration for IAP per `project_roam_iap.md`. | Keystore at `roam-release.keystore` (root level). |
| Chambers | `au.ecodia.chambers` | NOT YET CREATED in Play Console. Phase 1 web only; mobile via Capacitor on `feat/capacitor-ios-wrap-2026-04-29` branch. | Bundle ID convention `au.ecodia.{slug}` - ASCII-clean; no special chars. |
| Sidequests | `au.ecodia.sidequests` | NOT YET CREATED. | Capacitor wrap pending. |

---

## Critical gaps (status_board candidates)

1. **Android keystores not in kv_store.** If Tate's machine fails or the keystore file is lost, we cannot ship updates and have to migrate to a new signing key under Play App Signing's upgrade flow (which is recoverable but ugly). Surface as P2: "Backup all per-app Android keystores to kv_store as base64."

2. **Google Play Developer API not wired for autonomous uploads.** Today every Play upload requires a human GUI step. Cost: ~3-5 min per release plus the GUI dependency. Surface as P3: "Generate Play Developer service account JSON, store in kv_store, configure fastlane."

3. **Per-app data safety / content rating forms.** These can only be filled via Play Console GUI, never via API. They block production rollouts. Confirm both are completed for Co-Exist and Roam before next prod release.

---

## Origin

Authored 2026-04-29 by fork `fork_mojfz9q6_61253f` against the brief: "figure out the end to end flow for android and apple app releases." Codifies the Co-Exist Android release pattern, generalised for any Capacitor-wrapped Ecodia app. Cross-references `app-release-flow-ios.md` and `app-release-flow-new-app.md`.
