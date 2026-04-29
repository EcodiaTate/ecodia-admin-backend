---
triggers: xcodebuild, app-store-connect, asc-api-key, testflight, sy094, capacitor-ios-release, .ipa, .xcarchive, allowprovisioningupdates, exportarchive, xcrun-altool, agvtool, ios-release-flow, coexist-ios-release, roam-ios-release, AuthKey_.p8, --apiKey, --apiIssuer
---

# iOS App Release Flow - Doctrine

End-to-end flow for shipping an Ecodia (or client) iOS app to Apple's App Store via TestFlight, run from the VPS using SSH into SY094 (MacInCloud Mac). Capacitor-wrapped webview is the default Ecodia stack.

Read this BEFORE any iOS release work. Companion docs:
- `app-release-flow-android.md` - Play Console counterpart
- `app-release-flow-new-app.md` - first-time app creation across both stores
- `~/ecodiaos/clients/macincloud-access.md` - the SY094 access pattern (READ FIRST)
- `~/ecodiaos/patterns/ios-signing-credential-paths.md` - the three signing-credential paths, ranked

---

## Overview

The iOS release path has five phases:

1. **Build** - Capacitor sync runs on the Mac via SSH; `xcodebuild` produces a `.xcarchive`.
2. **Sign** - `xcodebuild -allowProvisioningUpdates` + ASC API key at canonical `.p8` location handles signing autonomously.
3. **Export** - `xcodebuild -exportArchive` produces a `.ipa` ready for upload.
4. **Upload** - `xcrun altool --upload-app` (or `xcrun notarytool` for macOS apps; not relevant here) pushes the `.ipa` to App Store Connect.
5. **TestFlight + Submit** - Internal testers > External testers > App Store submission.

Total wall time for a routine update: 30-60 minutes. First production submission for a new app: 1-3 days for review.

---

## Prerequisites

### Account state (one-time, already done for Ecodia)
- Apple Developer Program: $149/yr, paid. Tate is the team admin under Apple ID `code@ecodia.au`.
- Apple ID has Developer team membership and accepts the latest Apple Developer Program License Agreement (refuses to issue certificates if not).
- App Store Connect: Tate has admin access. Other Ecodia accounts can be added as Developer or App Manager.

### Per-app state (verify before first build)
- App ID (bundle identifier) registered at developer.apple.com > Certificates, IDs and Profiles > Identifiers. Convention: `au.ecodia.{slug}` for our IP, `org.{client}.{app}` when the client owns the IP (e.g. `org.coexistaus.app`).
- App record created in App Store Connect with the same bundle ID.
- TestFlight set up with at least one internal tester group (Tate's Apple ID).
- Distribution Provisioning Profile - either auto-managed by Xcode (preferred) or explicitly downloaded.
- Privacy policy URL reachable (App Store Connect requires this before submission).
- Encryption export compliance answered ("uses standard encryption only" for our apps).

### Tooling on SY094
| Tool | State | How to verify |
|------|-------|---------------|
| Xcode 26.3 | Installed | `xcodebuild -version` |
| Command line tools | Installed | `xcode-select -p` returns `/Applications/Xcode.app/Contents/Developer` |
| `xcrun altool` | Available | `xcrun altool --version` |
| `xcrun notarytool` | Available (Xcode 13+) | not used for iOS apps |
| CocoaPods | Installed | `pod --version` (only relevant if a Capacitor plugin needs CocoaPods, mostly handled by `npx cap sync ios`) |
| Node 20+ | Verify | `node --version` (used by `npx cap sync ios`) |

### Credentials (canonical kv_store paths)

**Currently stored:** none of the Apple signing/upload credentials are in kv_store yet. Surface this as a status_board P1: this is the actual blocker for autonomous iOS pipelines, and the doctrine in `~/ecodiaos/patterns/ios-signing-credential-paths.md` already names ASC API key as path 1.

Target kv_store layout once populated:
```
creds.asc_api_key_p8         # full .p8 file contents (BEGIN/END lines included)
creds.asc_api_key_id         # 10-char Key ID
creds.asc_api_issuer_id      # UUID Issuer ID
creds.apple.team_id          # 10-char team ID (DEVELOPMENT_TEAM in xcodebuild)
creds.apple.app_specific_password  # only if using path 2 (Xcode-login fallback)
```

The ASC API key is generated once at App Store Connect > Users and Access > Keys. Scope `Developer` is sufficient. `App Manager` is overkill but safe. The `.p8` file is downloadable ONCE - if you lose it, revoke and regenerate.

---

## Workspace convention

VPS working copies clone to `~/workspaces/{slug}/fe/`. The Capacitor iOS project lives at `ios/App/App.xcworkspace`.

**Key principle:** the VPS is the single source of truth for the codebase. SY094 is a build environment. Every release run pulls fresh from git on the Mac:

```bash
PW=$(mcp_db_query_value 'creds.macincloud' 'password')
SSH="sshpass -p '$PW' ssh -o PubkeyAuthentication=no user276189@SY094.macincloud.com"

$SSH "cd ~/projects/$SLUG && git fetch && git checkout main && git pull"
```

The `~/projects/` directory on the Mac mirrors `~/workspaces/` on the VPS but is named for clarity. If a project doesn't exist on the Mac yet, clone it:
```bash
$SSH "mkdir -p ~/projects && cd ~/projects && git clone https://github.com/EcodiaTate/{slug}.git $SLUG"
```

For client repos on Bitbucket, use the API-key auth pattern from `~/ecodiaos/CLAUDE.md` Credentials section.

---

## Build flow - copy-pasteable, CLI-first

All commands run from the VPS, dispatched via SSH to SY094. `mcp_db_query_value` is shorthand for "fetch a single JSON field from kv_store"; in practice you'll inline these via the `mcp__supabase__db_query` tool.

### Step 0: Set up shell helpers
```bash
SLUG=coexist
APPLE_TEAM=$(mcp_db_query_value 'creds.apple' 'team_id')
ASC_KEY_ID=$(mcp_db_query_value 'creds.asc_api_key_id' 'value')
ASC_ISSUER=$(mcp_db_query_value 'creds.asc_api_issuer_id' 'value')
PW=$(mcp_db_query_value 'creds.macincloud' 'password')
SSH="sshpass -p '$PW' ssh -o PubkeyAuthentication=no user276189@SY094.macincloud.com"
```

### Step 1: Stage the ASC API key on the Mac (one-time per Mac, idempotent)
```bash
P8=$(mcp_db_query_value 'creds.asc_api_key_p8' 'value')
$SSH "mkdir -p ~/.appstoreconnect/private_keys && \
      cat > ~/.appstoreconnect/private_keys/AuthKey_${ASC_KEY_ID}.p8 <<'EOF'
$P8
EOF
chmod 600 ~/.appstoreconnect/private_keys/AuthKey_${ASC_KEY_ID}.p8"

# Verify the key works (read-only API call) before kicking a 20-min build
$SSH "xcrun altool --list-providers --apiKey $ASC_KEY_ID --apiIssuer $ASC_ISSUER"
# Expected: a JSON list with at least one provider (your Apple Developer team)
```

If `--list-providers` 401s, the key is wrong, the issuer ID is wrong, or the key was revoked. Fix before continuing.

### Step 2: Pull and build web assets on the Mac
```bash
$SSH "cd ~/projects/$SLUG && \
      git fetch && git checkout main && git pull && \
      npm install && \
      npm run build && \
      npx cap sync ios"
```

`npx cap sync ios` copies `dist/` (or `out/` for Roam) into `ios/App/App/public/` AND runs `pod install` if there's a `Podfile`.

### Step 3: Bump iOS version + build numbers
The iOS version + build number live in `ios/App/App.xcodeproj/project.pbxproj`. Easier path: use `xcrun agvtool` from the iOS folder.

```bash
$SSH "cd ~/projects/$SLUG/ios/App && \
      agvtool new-marketing-version 1.4.0 && \
      agvtool new-version -all 25"
```

`new-marketing-version` sets `CFBundleShortVersionString` (the human "1.4.0"). `new-version` sets `CFBundleVersion` (the build number, must increase per upload to App Store Connect, even if the marketing version stays the same).

### Step 4: Archive
```bash
$SSH "cd ~/projects/$SLUG/ios/App && \
      xcodebuild \
        -workspace App.xcworkspace \
        -scheme App \
        -configuration Release \
        -archivePath build/$SLUG.xcarchive \
        -destination 'generic/platform=iOS' \
        -allowProvisioningUpdates \
        -authenticationKeyPath ~/.appstoreconnect/private_keys/AuthKey_${ASC_KEY_ID}.p8 \
        -authenticationKeyID $ASC_KEY_ID \
        -authenticationKeyIssuerID $ASC_ISSUER \
        DEVELOPMENT_TEAM=$APPLE_TEAM \
        archive"
```

This is the slow step. Expect 5-15 minutes depending on app size and Mac load. Watch logs by tailing the SSH output; failures usually surface in the last 50 lines.

### Step 5: Export the IPA

Create an `ExportOptions.plist` in the repo (commit it). Default content for App Store distribution:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>method</key>
    <string>app-store-connect</string>
    <key>teamID</key>
    <string>$APPLE_TEAM</string>
    <key>uploadBitcode</key>
    <false/>
    <key>uploadSymbols</key>
    <true/>
    <key>signingStyle</key>
    <string>automatic</string>
</dict>
</plist>
```

Then export:
```bash
$SSH "cd ~/projects/$SLUG/ios/App && \
      xcodebuild -exportArchive \
        -archivePath build/$SLUG.xcarchive \
        -exportOptionsPlist ExportOptions.plist \
        -exportPath build/export \
        -allowProvisioningUpdates \
        -authenticationKeyPath ~/.appstoreconnect/private_keys/AuthKey_${ASC_KEY_ID}.p8 \
        -authenticationKeyID $ASC_KEY_ID \
        -authenticationKeyIssuerID $ASC_ISSUER"
```

Output: `~/projects/$SLUG/ios/App/build/export/App.ipa` (the filename is `App.ipa` because the scheme is `App`; rename if preferred).

### Step 6: Upload to App Store Connect
```bash
$SSH "xcrun altool --upload-app \
        --type ios \
        --file ~/projects/$SLUG/ios/App/build/export/App.ipa \
        --apiKey $ASC_KEY_ID \
        --apiIssuer $ASC_ISSUER"
```

Or use the newer `xcrun altool --validate-app` first to catch metadata issues without consuming an upload slot. `notarytool` is not for iOS apps - that's macOS notarisation.

Upload takes 2-10 minutes depending on Mac upload speed. Apple processes the build for another 5-30 minutes after upload before it appears in App Store Connect TestFlight.

### Step 7: TestFlight smoke-test
- App Store Connect > My Apps > {App} > TestFlight - the new build will appear under "iOS" once Apple finishes processing.
- Add it to the Internal Testing group (Tate is in there).
- Tate gets a TestFlight push notification on his phone, installs the build, smoke-tests.
- For external testing (broader audience), you need a one-time Beta App Review (~24h).

### Step 8: Submit for App Store review
- Once TestFlight smoke is clean, App Store Connect > My Apps > {App} > App Store > [+ Version] > fill version metadata (what's new, screenshots, description).
- Pick the build from TestFlight.
- Answer export compliance ("standard encryption only").
- Submit for Review.
- Apple review: typically 24-48h, sometimes faster.

The metadata + screenshot management is GUI-only. There is no clean CLI for App Store metadata short of fastlane's `deliver` (covered below).

---

## Path to fully autonomous releases - fastlane

Goal: replace the GUI metadata steps too, so the entire pipeline runs from the VPS without human touch.

**fastlane on the Mac (one-time setup):**
```bash
$SSH "sudo gem install fastlane -NV"
# or via Homebrew if installed: brew install fastlane
```

**Per-project Fastfile** at `ios/fastlane/Fastfile`:
```ruby
default_platform(:ios)

platform :ios do
  desc "Push a build to TestFlight"
  lane :beta do
    api_key = app_store_connect_api_key(
      key_id: ENV["ASC_KEY_ID"],
      issuer_id: ENV["ASC_ISSUER"],
      key_filepath: ENV["ASC_KEY_PATH"],
      duration: 1200
    )
    build_app(
      workspace: "App.xcworkspace",
      scheme: "App",
      export_method: "app-store-connect"
    )
    upload_to_testflight(
      api_key: api_key,
      skip_waiting_for_build_processing: true
    )
  end

  desc "Submit current TestFlight build for App Store review"
  lane :release do
    api_key = app_store_connect_api_key(
      key_id: ENV["ASC_KEY_ID"],
      issuer_id: ENV["ASC_ISSUER"],
      key_filepath: ENV["ASC_KEY_PATH"]
    )
    deliver(
      api_key: api_key,
      skip_screenshots: true,
      skip_metadata: true,   # set false once you commit metadata to fastlane/metadata/
      submit_for_review: true,
      automatic_release: true,
      force: true
    )
  end
end
```

**Run a release from the VPS:**
```bash
$SSH "cd ~/projects/$SLUG/ios/App && \
      ASC_KEY_ID=$ASC_KEY_ID \
      ASC_ISSUER=$ASC_ISSUER \
      ASC_KEY_PATH=~/.appstoreconnect/private_keys/AuthKey_${ASC_KEY_ID}.p8 \
      fastlane beta"
```

`fastlane deliver init` (run once on the Mac) bootstraps `fastlane/metadata/` with all the App Store Connect text fields and `fastlane/screenshots/` for screenshots. Both can be committed to the repo (gitignore is the default for screenshots, override).

---

## Common failure modes + fixes

| Symptom | Cause | Fix |
|---------|-------|-----|
| `No Accounts` / `No profiles for 'org.coexistaus.app' were found` | No Apple ID logged in to Xcode AND no ASC API key on disk | Stage the `.p8` per Step 1, OR have Tate VNC in and log into Xcode (path 2 in `ios-signing-credential-paths.md`) |
| `error: exportArchive: No applicable devices found` | Wrong destination during `archive` | Use `-destination 'generic/platform=iOS'` |
| `xcodebuild: error: Could not resolve package dependencies` | Capacitor plugin SPM cache stale | `$SSH "cd ~/projects/$SLUG && rm -rf ios/App/Pods ios/App/build && pod install --project-directory=ios/App"` |
| `altool: error: Authentication failed (-22938)` | API key wrong, expired, or revoked | Regenerate at App Store Connect > Users and Access > Keys; update kv_store; re-stage on Mac |
| Build uploads but doesn't appear in TestFlight | Apple processing | Wait 5-30 min. If not visible after 1h, check ASC > Activity. Common cause: missing `ITSAppUsesNonExemptEncryption` in Info.plist - add and rebuild. |
| `Code signing error: ... is not a valid identity` | Provisioning profile mismatched to certificate | Delete `~/Library/MobileDevice/Provisioning Profiles/*.mobileprovision`; let `-allowProvisioningUpdates` re-fetch |
| `CFBundleVersion already exists for this train` | Build number not bumped | `agvtool new-version -all <higher>` and rebuild |
| MacInCloud SSH `Permission denied` | Password rotated | Update `kv_store.creds.macincloud.password` from MacInCloud control panel |
| MacInCloud session looks "frozen" mid-build | MacInCloud kicked the rental session | Reconnect SSH; check if the Mac console is still logged in. The build may have completed - check `build/` dir. |
| `pod install` hits SSL errors | CocoaPods spec repo stale or network blip | `$SSH "pod repo update"`, retry |
| `No suitable application records found` (altool) | Bundle ID not registered in App Store Connect | Create the App Store Connect record first - see `app-release-flow-new-app.md` |

---

## Time-box estimates

| Step | First-app time | Routine update time |
|------|----------------|---------------------|
| Stage ASC API key | 5 min | 0 (idempotent) |
| Git pull + npm install + npm run build | 5-10 min | 2-3 min |
| `npx cap sync ios` + `pod install` | 3-5 min | 1-2 min |
| Version bump | 1 min | 1 min |
| `xcodebuild archive` | 10-20 min | 5-15 min |
| `xcodebuild -exportArchive` | 1-2 min | 1-2 min |
| `xcrun altool --upload-app` | 5-10 min | 3-7 min |
| Apple processing wait (background) | 10-30 min | 5-15 min |
| TestFlight smoke-test | 10-15 min | 5 min |
| App Store metadata + submission | 30-60 min (first time only) | 10 min |
| Apple review wait | 24-48h | 12-24h |

**Total wall time to TestFlight (excluding wait):** ~45 min routine, ~75 min first time.

---

## Things Tate physically must do

These cannot be automated from the VPS and require Tate at a Mac (either his own machine, or VNC into SY094, or the MacInCloud web GUI):

1. **First-time Apple Developer Program enrolment + Apple ID 2FA setup** - already done.
2. **Generate the ASC API key for the first time** - GUI-only (Users and Access > Keys > +). Once it's in kv_store, automation takes over.
3. **Resolve a 2FA prompt during a manual Xcode login** - only relevant if we fall back to path 2 of `ios-signing-credential-paths.md`. Path 1 (ASC API key) avoids this.
4. **App Store Connect agreements** - new Paid Apps Agreement, new Developer Program License Agreement, new tax forms. Apple periodically pushes new versions; submissions block until accepted.
5. **App Store metadata for first submission** - screenshots, description, keywords, category, age rating. Fastlane `deliver` automates these on subsequent updates if metadata is committed; the first round usually has a human pass.
6. **Resolve a rejected review** - sometimes Apple's reviewer asks for clarification or screenshots. Reply via App Store Connect Resolution Center; this is GUI-only.

When any of these come up, insert a `status_board` row with `entity_type='task'`, `next_action_by='tate'`, and a one-line description of exactly what to click.

---

## Real apps + state (snapshot 2026-04-29)

| App | Bundle ID | App Store Connect state | Notes |
|-----|-----------|-------------------------|-------|
| Co-Exist | `org.coexistaus.app` | App record likely exists; TestFlight state needs verification. iOS folder has push entitlement and Universal Links for coexistaus.org. | Apple Developer team is `code@ecodia.au`. ASC API key NOT yet generated/stored. |
| Roam | `au.ecodia.roam` | Production blocked on GST registration for IAP. App record state needs verification. | Static export build (`out/`), not Vite default `dist/`. |
| Chambers | `au.ecodia.chambers` | NOT YET CREATED in App Store Connect. Capacitor wrap on `feat/capacitor-ios-wrap-2026-04-29`. | Bundle ID convention `au.ecodia.{slug}` confirmed. |
| Sidequests | `au.ecodia.sidequests` | NOT YET CREATED. | |

---

## Critical gaps (status_board candidates)

1. **ASC API key not yet generated.** This is the actual P1 blocker for any autonomous iOS release pipeline. Per `~/ecodiaos/patterns/ios-signing-credential-paths.md`, path 1 (ASC API key) is the preferred unblock path. Surface as P1: "Tate to generate ASC API key at appstoreconnect.apple.com > Users and Access > Keys, store .p8 + Key ID + Issuer ID in kv_store."

2. **Apple team ID not in kv_store.** Required for `DEVELOPMENT_TEAM` in xcodebuild and for `teamID` in ExportOptions.plist. Cheap to fetch (`xcodebuild -showBuildSettings | grep DEVELOPMENT_TEAM` on any Mac with the project open). Surface as P3.

3. **fastlane not installed on SY094.** Trade-off: do we want the metadata/screenshot autonomy or is the Step 1-6 CLI flow enough? Suggest: defer until we have a real reason (3+ apps in flight, or one app shipping more than monthly).

4. **No commitment on which Apple Developer team owns Ecodia client work.** Currently `code@ecodia.au` (Tate's team). For Co-Exist specifically, the IP-retention model says Ecodia Pty Ltd holds the IP, so Apple team should be Ecodia's. For pure-client-IP engagements, the client should have their own Apple Developer enrolment and we publish under their team. Surface as a doctrine question for Tate when next client iOS engagement comes in.

---

## Origin

Authored 2026-04-29 by fork `fork_mojfz9q6_61253f` against the brief: "figure out the end to end flow for android and apple app releases via macincloud." Codifies the CLI-first SSH-into-SY094 approach. Companion doctrine: `~/ecodiaos/patterns/ios-signing-credential-paths.md` (the three credential paths, ranked) and `~/ecodiaos/clients/macincloud-access.md` (the access pattern).
