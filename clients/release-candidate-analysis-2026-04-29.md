# Release Candidate Analysis - 2026-04-29

Recon by fork `fork_mojgg3ol_e13e6a` against the brief: "identify the FIRST Ecodia app I can ship to a real release lane (TestFlight or Play Internal) end-to-end." Companion docs: `app-release-flow-ios.md`, `app-release-flow-android.md`, `app-release-flow-new-app.md`.

Constraint: no actual ship today. Recon + recommendation only.

> **AMENDMENT 2026-04-29 15:25 AEST (fork_mojmpn4g_ca6af8):** the iOS upload step has been redesigned to use a GUI-macro path (Xcode Organizer or Transporter on SY094, driven by the laptop-agent macro layer) rather than `xcrun altool --apiKey/--apiIssuer`. Triggered by Tate verbatim: "why do we need this asc key bro.... just use the gui and it will work, i always redeploy roam via the gui working fine." Doctrine: `~/ecodiaos/patterns/gui-macro-uses-logged-in-session-not-generated-api-key.md`. Strategic_Direction node: "GUI macros replace API keys for autonomous releases - use logged-in user sessions over generated programmatic credentials when both work." The "ASC API key not in kv_store" blocker (item 1 below) is **demoted to fallback-only.** The primary path now requires only (a) Tate's existing Xcode Apple ID login on SY094 (one-time, already done if Roam has shipped before), (b) the macro handlers `xcode-organizer-upload` and `transporter-upload` per `~/ecodiaos/drafts/macro-architecture-roadmap-2026-04-29.md`. release.sh defaults to `IOS_UPLOAD_PATH=macro`; the altool path is opt-in via `IOS_UPLOAD_PATH=altool` or `IOS_UPLOAD_FALLBACK_TO_ALTOOL=1`. The blockers below are kept as-is for historical record but the prioritisation has shifted: macro handler authoring is now the leading dependency, not ASC API key generation.

---

## TL;DR

**First app to ship: Co-Exist iOS to TestFlight.**

Why: most mature codebase, store records likely exist already, has real web users who would benefit from the queued fixes (Samsung bugs, modal keyboard inset). The ONLY net-new blocker that is not already a tracked status_board P1/P2 row is "verify ASC record + TestFlight tester group exist before kicking the build." Everything else is already on the board.

**Top 3 blockers** (in order of leverage, AS REVISED 15:25 AEST 29 APR 2026):

1. **iOS upload macros not yet authored** (replaces "ASC API key not in kv_store"). Author `xcode-organizer-upload` + `transporter-upload` per `~/ecodiaos/drafts/macro-architecture-roadmap-2026-04-29.md` Phase 1 priority section. Activation requires (a) base macro fork mojldsgx merged, (b) Xcode signed in to Tate's Apple ID on SY094 (one-time, likely already done), (c) ~3-4h fork session to ship handlers + tests.
2. **Co-Exist Android keystore password not in kv_store** (status_board P2, owner=tate). The `.jks` file is on disk; the password is in Tate's 1Password. Without it, the Gradle release build fails with "Keystore was tampered with, or password was incorrect."
3. **Apple team_id not in kv_store** (status_board P3, owner=tate). Required for `DEVELOPMENT_TEAM` in xcodebuild even on the macro path (the team-id selects which signing identity Xcode uses; the macro doesn't bypass this). Cheap to fetch by Tate at developer.apple.com > Membership.

**Demoted (no longer blocking, but kept as fallback):**

- **ASC API key not in kv_store** (was P1). Now P3, fallback-only. Engaged automatically if `IOS_UPLOAD_PATH=altool` is set OR `IOS_UPLOAD_FALLBACK_TO_ALTOOL=1` AND the macro path fails. Most pipelines should never need it.

**If Tate generates the ASC API key when he's back, the 6-command sequence to ship Co-Exist iOS to TestFlight tonight is:**

```bash
# 1. Stage the .p8 on SY094 from kv_store (Step 1 of ios.md)
PW=$(... creds.macincloud) && SSH="sshpass -p $PW ssh ..." && \
  $SSH "mkdir -p ~/.appstoreconnect/private_keys && cat > ~/.appstoreconnect/private_keys/AuthKey_${ASC_KEY_ID}.p8 <<<\"$P8\" && chmod 600 ~/.appstoreconnect/private_keys/AuthKey_${ASC_KEY_ID}.p8"

# 2. Verify the key works
$SSH "xcrun altool --list-providers --apiKey $ASC_KEY_ID --apiIssuer $ASC_ISSUER"

# 3. Pull + build web + cap sync
$SSH "cd ~/projects/coexist && git fetch && git checkout main && git pull && npm install && npm run build && npx cap sync ios"

# 4. Bump iOS build number
$SSH "cd ~/projects/coexist/ios/App && agvtool new-version -all <NEXT_BUILD_NUM>"

# 5. Archive (with provisioning auto-update via API key)
$SSH "cd ~/projects/coexist/ios/App && xcodebuild -workspace App.xcworkspace -scheme App -configuration Release -archivePath build/coexist.xcarchive -destination 'generic/platform=iOS' -allowProvisioningUpdates -authenticationKeyPath ~/.appstoreconnect/private_keys/AuthKey_${ASC_KEY_ID}.p8 -authenticationKeyID $ASC_KEY_ID -authenticationKeyIssuerID $ASC_ISSUER DEVELOPMENT_TEAM=$APPLE_TEAM archive"

# 6. Export IPA + upload to App Store Connect
$SSH "cd ~/projects/coexist/ios/App && xcodebuild -exportArchive -archivePath build/coexist.xcarchive -exportOptionsPlist ExportOptions.plist -exportPath build/export -allowProvisioningUpdates -authenticationKeyPath ~/.appstoreconnect/private_keys/AuthKey_${ASC_KEY_ID}.p8 -authenticationKeyID $ASC_KEY_ID -authenticationKeyIssuerID $ASC_ISSUER && xcrun altool --upload-app --type ios --file build/export/App.ipa --apiKey $ASC_KEY_ID --apiIssuer $ASC_ISSUER"
```

(Pre-step: commit a default `ExportOptions.plist` to `~/workspaces/coexist/ios/App/ExportOptions.plist`. Currently missing - fork can author this safely, it is repo-template work, not creds-blocked.)

---

## Per-app inventory

### 1. Co-Exist (`org.coexistaus.app`)

| Dimension | State |
|-----------|-------|
| Bundle ID | `org.coexistaus.app` (client-IP convention - Co-Exist brand) |
| Capacitor scaffold | Mature. webDir `dist/`. `capacitor.config.ts` has push, social-login, navigation allowlist. |
| iOS project | `ios/App/App.xcworkspace` exists. Bundle ID set in `project.pbxproj`. |
| Android project | `android/app/build.gradle` has correct `signingConfigs.release` block; reads `COEXIST_KEYSTORE_PASSWORD` and `COEXIST_KEY_PASSWORD` env vars. |
| Keystore | `android/app/coexist-release.jks` present on VPS. NOT in kv_store. |
| versionCode / versionName | 6 / "1.6" (already-shipped multiple times) |
| ASC record state | "App record likely exists; TestFlight state needs verification" per `app-release-flow-ios.md`. Push entitlement and Universal Links for `coexistaus.org` are wired. Probable yes - has shipped before. |
| Play Console state | "App entry exists, internal testing track active" per `app-release-flow-android.md`. |
| ExportOptions.plist | MISSING. Need to author and commit before iOS export. |
| Last commit | `8e045b5` 29 Apr - Samsung keyboard inset modal fix on `fix/leader-tasks-samsung-bugs-2026-04-29` (not main). |
| Real users? | Yes, web prod live. Conservation app, multi-tenant. |
| Open PRs | PR #1 (shop loading + event-create nav, status_board P2 awaiting Tate review). |

**What's missing per platform:**

| Need | iOS | Android |
|------|-----|---------|
| ASC API key (creds.asc_api_key_p8 + id + issuer) | YES (Tate) | n/a |
| Apple team ID (creds.apple.team_id) | YES (Tate) | n/a |
| Keystore password (creds.android.coexist) | n/a | YES (Tate, in 1Password) |
| Repo template fix | ExportOptions.plist (ecodiaos) | none |
| Store-side state | Verify ASC record + TestFlight tester group | Verify internal-track tester list, data safety form, content rating |
| Build infra | `npm install` on SY094 first run | npm install + Gradle sdk on Corazon (already set up) |

---

### 2. Roam (`au.ecodia.roam`)

| Dimension | State |
|-----------|-------|
| Bundle ID | `au.ecodia.roam` (Ecodia-IP convention) |
| Capacitor scaffold | Mature. webDir `out/` (Next static export). |
| iOS project | `ios/App/App.xcodeproj` exists. Bundle ID set. |
| Android project | `android/app/build.gradle` has NO signingConfigs block. Default unsigned-release output. |
| Keystore | `roam-release.keystore` at repo root (not at `android/app/`). Not gitignored at standard path - needs verification. |
| versionCode / versionName | 1 / "1.0" - never shipped |
| ASC record state | "App record state needs verification" - probably yes per status_board (Apple Sign-In audit references both apps). |
| Play Console state | "App entry exists" per doctrine doc. Production blocked on GST registration for IAP, but IAP is now UNBLOCKED (status_board: GST verified registered 3 Feb 2026). |
| Open PRs | PR #1 /account unauth guard, PR #2 Apple Sign-In Android wiring - both awaiting Tate review. |

**What's missing per platform:**

| Need | iOS | Android |
|------|-----|---------|
| ASC API key | YES (Tate) | n/a |
| Apple team ID | YES (Tate) | n/a |
| Repo template fix | ExportOptions.plist | Add full `signingConfigs.release` block referencing `roam-release.keystore` + alias + ROAM_KEYSTORE_PASSWORD env var |
| Keystore password | n/a | YES (Tate) |
| First-time setup | Screenshots, App Store metadata, ASC record verification | Same plus content rating + data safety form |
| Other | None for TestFlight. IAP submission needs RevenueCat setup but TestFlight without IAP works. | Same. |

Note: the open Apple Sign-In Android PR (#2) means a fresh build is queued anyway. Roam is a real candidate but second-place behind Co-Exist on maturity.

---

### 3. Chambers (`au.ecodia.chambers`)

| Dimension | State |
|-----------|-------|
| Bundle ID | `au.ecodia.chambers` (Ecodia-IP convention) |
| Capacitor scaffold | Inherited from Co-Exist fork. webDir `dist/`. |
| iOS project | Exists, bundle ID set. iOS Capacitor wrap is on `feat/capacitor-ios-wrap-2026-04-29` branch (not main). Diff vs main is mostly a DELETE pass (Groups, GroupDetail, focus_groups migration removed - simplification). |
| Android project | `android/app/build.gradle` STILL references `coexist-release.jks` and alias `coexist` (leftover from Co-Exist fork). versionCode/versionName 6/"1.6" - copied from Co-Exist, would conflict with itself if pushed against the (non-existent) chambers Play app. |
| Keystore | NONE generated for Chambers. The `.jks` referenced in build.gradle is the Co-Exist one, which would not work for `au.ecodia.chambers` even if present (different upload identity per app under Play App Signing). |
| versionCode / versionName | 6 / "1.6" (inherited, wrong for a fresh app) |
| ASC record state | NOT YET CREATED (status_board explicit). |
| Play Console state | NOT YET CREATED (status_board explicit). |
| Live state | Phase 1 web shipped to prod today. Email to Matt drafted, awaiting Tate go-ahead + custom domain. |

**What's missing per platform:**

| Need | iOS | Android |
|------|-----|---------|
| App ID registration (developer.apple.com) | YES (Tate, GUI) | n/a |
| ASC record creation | YES (Tate, GUI) | n/a |
| Play Console app entry creation | n/a | YES (Tate, GUI) |
| Generate chambers keystore | n/a | YES (ecodiaos, then Tate provides passwords) |
| Fix build.gradle to reference chambers keystore + alias | n/a | YES (ecodiaos) |
| Reset versionCode to 1, versionName to "1.0" | n/a | YES (ecodiaos) |
| Decide IP-assignment for store ownership | YES | YES |
| Privacy policy + support page | YES | YES |
| ASC API key | YES (Tate) | n/a |
| Apple team ID | YES (Tate) | n/a |
| Branding assets (icon, splash, screenshots, feature graphic) | YES | YES |

Chambers is a NEW APP - the full Step-1-through-7 in `app-release-flow-new-app.md`. Wall-clock estimate: 8-12 hours of focused work over 1-3 days, gated on Tate-GUI steps. Not a "ship tonight" candidate.

---

### 4. Sidequests (`au.ecodia.sidequests`)

| Dimension | State |
|-----------|-------|
| Bundle ID | `au.ecodia.sidequests` |
| Capacitor scaffold | Exists. webDir `out/`. |
| iOS project | Exists, bundle ID set. |
| Android project | Exists. No keystore present. No signing config in build.gradle (verified). |
| Last commits | `45f4306` Factory check, `965ce34` "fjudfh", `34e425e` "fdhufhu" - these are placeholder commits, not real work. |
| Live state | Status unclear. Not in active dev rotation. |
| Real users? | No |

**Verdict: DROP from candidate list.** Codebase is not in shippable state. Re-evaluate when there is a real product reason to push.

---

## What's missing per app, who's blocked

| App | Lane | Missing creds (tate-blocked) | Repo gaps (ecodiaos-blocked) | Store-side gaps |
|-----|------|------------------------------|------------------------------|-----------------|
| Co-Exist | iOS TestFlight | ASC API key, team_id | ExportOptions.plist | Verify ASC record + TF group |
| Co-Exist | Play Internal | Keystore password | None | Verify internal track tester list |
| Roam | iOS TestFlight | ASC API key, team_id | ExportOptions.plist | Verify ASC record + first-time TF setup |
| Roam | Play Internal | Keystore password | Add signingConfigs to build.gradle | Verify internal track |
| Chambers | iOS TestFlight | ASC API key, team_id | ExportOptions.plist; merge `feat/capacitor-ios-wrap-2026-04-29` | App ID + ASC record (Tate GUI) |
| Chambers | Play Internal | Generate + record keystore password | Generate keystore; fix build.gradle (currently broken-inherited from Co-Exist); reset versionCode | Play Console app entry (Tate GUI) |
| Sidequests | either | n/a | Codebase not real | n/a |

**Pattern:** every shippable candidate has the SAME P1/P2 tate-blockers. Once those are unblocked, Co-Exist ships fastest because it has the most mature repo + existing store records.

---

## Recommendation: Co-Exist iOS to TestFlight first

**Why iOS not Android:** the Android lane needs ONE password (1Password lookup) to unblock, whereas iOS needs the ASC API key generation flow which is a one-time setup that unblocks ALL future iOS releases across ALL Ecodia apps. Unblocking iOS has higher leverage. Android is the second priority once the .jks password is provided - probably the same evening.

**Why Co-Exist not Roam or Chambers:**

- Co-Exist has the most mature codebase, recent active dev (today), and has already-shipped to both stores. Smallest unknowns.
- Roam is also viable but versionCode 1 / never-shipped means more uncertainty in TestFlight setup. Add to queue immediately after.
- Chambers is a brand-new app submission - 8-12 hours of focused new-app-flow work, all the GUI steps, and we want Matt's email + custom domain decision settled first.
- Sidequests is not real code yet.

**Concrete step-by-step (assumes ASC API key + creds in kv_store, and Co-Exist keystore password provided by Tate):**

### Pre-work (ecodiaos can do today, no creds needed)

1. Author `~/workspaces/coexist/ios/App/ExportOptions.plist` per the doctrine template (substitute `$APPLE_TEAM` placeholder; do not commit live team ID until kv_store has it). Fork-it work.
2. Verify the macincloud agent / SSH path is clean: `sshpass -p $PW ssh user276189@SY094.macincloud.com 'xcodebuild -version'` should print Xcode 26.3.
3. Confirm `~/projects/coexist` exists on SY094 (clone if not): `git clone https://github.com/EcodiaTate/coexist.git`.
4. Verify the open PRs that should ship in this build: PR #1 (shop loading + event-create nav). Decide with Tate whether to merge first or ship current main as-is.

### Tate-only steps (one-time, ~15 min)

1. Sign in at `https://appstoreconnect.apple.com` (Apple ID `apple@ecodia.au`).
2. Users and Access > Integrations > Keys > + > Generate API Key. Name "ecodia-ci". Access "Developer" or "App Manager". Generate.
3. Download the `.p8` file (one-time only opportunity).
4. Note the Key ID (10 chars) and Issuer ID (UUID) shown next to the key.
5. Membership > note the Team ID (10 chars).
6. Send the four values to ecodiaos for kv_store storage:
   ```
   creds.asc_api_key_p8       = <full .p8 file contents, BEGIN/END lines included>
   creds.asc_api_key_id       = <10 chars>
   creds.asc_api_issuer_id    = <UUID>
   creds.apple.team_id        = <10 chars>
   ```

### Tate-only Android side (~2 min, parallel)

1. Open 1Password, locate `coexist-release.jks` keystore password.
2. Send to ecodiaos:
   ```
   creds.android.coexist      = { keystore_password, key_password, key_alias=coexist }
   ```
   (ecodiaos will add `keystore_b64` from the file already on VPS.)

### ecodiaos run (~45-60 min wall clock, mostly waiting on builds)

iOS:

1. Pull creds, stage `.p8` on SY094, run `xcrun altool --list-providers` to verify (Steps 0-1 of `app-release-flow-ios.md`).
2. SSH-driven `cd ~/projects/coexist && git pull && npm install && npm run build && npx cap sync ios` (Step 2).
3. Bump iOS build number: `agvtool new-version -all 7` (or whatever the next free build is).
4. `xcodebuild archive` with API-key-driven provisioning auto-update (Step 4).
5. `xcodebuild -exportArchive` against ExportOptions.plist (Step 5).
6. `xcrun altool --upload-app` (Step 6).
7. Wait 10-30 min for Apple to process. Add to TestFlight Internal Testing group.
8. Tate gets push notification on phone, smoke-tests.

Android (in parallel after step 2):

1. Restore keystore + export password env vars from kv_store.
2. Bump versionCode (7) and versionName ("1.7") in `android/app/build.gradle`.
3. `cd android && ./gradlew clean bundleRelease`.
4. Verify the AAB with `bundletool dump manifest`.
5. Upload to Play Console Internal track via Corazon Chrome (web UI, since Play Developer service account is still P3).
6. Promote to internal track, opt-in link sent to Tate.

Total wall time: ~45-60 min if creds arrive together, ~30 min for iOS alone.

---

## Risk callouts

1. **ASC record state for Co-Exist is "likely" not "verified".** The doctrine doc says the record probably exists; status_board does not have an explicit confirmation. If the record was never created, the first build upload will hit "No suitable application records found" and we'll need Tate to do the App Store Connect new-app GUI flow first. Mitigation: have Tate confirm at `https://appstoreconnect.apple.com/apps` when he generates the API key (same browser session).

2. **TestFlight Internal Testing group must already have at least one tester.** If Tate's Apple ID is not in the group, the build will appear in App Store Connect but no one can install it. 30-second fix in the GUI but it must happen.

3. **Build number conflict on first upload.** If a previous archive was uploaded with `CFBundleVersion=6` and we send 6 again, Apple rejects. We bump unconditionally to be safe.

4. **MacInCloud session may be frozen.** Doctrine: reconnect SSH; check if Mac console is logged in. If frozen, Tate must reconnect via the MacInCloud web GUI before the SSH dispatch. Verify SSH connectivity BEFORE kicking the 20-min archive build.

5. **Capacitor plugin SPM cache** can be stale on a fresh Mac clone. First-time builds may need `pod repo update && rm -rf ios/App/Pods ios/App/build && pod install --project-directory=ios/App`. Add a 10-min buffer for first-time setup.

6. **Apple Developer Program License Agreement** may have a new version. Apple periodically pushes updates and submissions silently fail until accepted. If `xcrun altool --upload-app` returns a cryptic 4xx, this is the first thing to check (Tate at appstoreconnect.apple.com > Agreements). Surface as a status_board task if hit.

7. **Roam Android signing config absent.** If we pivot to Roam Android, we have to author the `signingConfigs.release` block in `android/app/build.gradle` AND pick keystore filename + alias. Fork-it work but adds 30 min.

8. **Chambers Android build.gradle is broken-inherited.** Trying to ship Chambers Android today would fail because the keystore file referenced (`coexist-release.jks` with alias `coexist`) is not present in chambers/fe AND would not be valid for `au.ecodia.chambers` upload identity even if it were. This is a status_board P3 candidate: "Chambers Android build.gradle still references Co-Exist keystore - block on first chambers Android upload."

9. **CDP attach to Tate's Chrome on Corazon is currently broken.** Even after kill+SingletonLock-clear (per doctrine), the agent reports "CDP probe at /json/version did not respond within 10s." This is a recon-side limitation only; it does not block any of the recommended ship steps. But: any GUI verification of Apple/Google console state via my browser tools is unavailable until CDP is fixed - Tate verifies state himself when he generates the API key.

---

## What I authored

- This file: `/home/tate/ecodiaos/clients/release-candidate-analysis-2026-04-29.md`

## What ecodiaos can do without waiting on Tate

These are repo-side fixes that don't need creds and remove obstacles before the ship moment arrives:

1. Author `~/workspaces/coexist/ios/App/ExportOptions.plist` with the standard app-store-connect template, `$APPLE_TEAM` left as a substitution token (not a real value).
2. Author `~/workspaces/roam-frontend/ios/App/ExportOptions.plist` similarly.
3. Add `signingConfigs.release` block to `~/workspaces/roam-frontend/android/app/build.gradle` referencing `roam-release.keystore` + alias `roam` + `ROAM_KEYSTORE_PASSWORD` env var.
4. Surface the Chambers Android build.gradle inheritance issue as a status_board P4 (not urgent, blocks first Chambers Android ship which is days away anyway).

These four are all Factory-dispatchable as small repo-template work. None are creds-dependent.

---

## Origin

Authored 2026-04-29 by fork `fork_mojgg3ol_e13e6a` against the brief: "identify the FIRST Ecodia app I can ship to a real release lane end-to-end." Recon used: local repo state for coexist/roam-frontend/chambers/sidequests, kv_store creds inventory (18 keys, none of the Apple/Android ones present), status_board (32 active rows touching mobile/release/creds), and the just-authored doctrine triplet (ios/android/new-app). Browser CDP recon was attempted but failed; recommendation derives from local state + status_board + doctrine, not live Apple/Google console reads.

---

## Live SY094 verification (added 2026-04-29 13:00 AEST, post-fork)

I SSH'd into SY094 to verify the recipe before proposing it as Tate-blocked. Findings:

### What works
- `xcodebuild -version` returns Xcode 26.3 build 17C529. Build environment is healthy.
- `xcrun altool --version` returns 26.10.1 (171001). Upload tooling ready.

### What does NOT work as the doctrine assumed

1. **`App.xcworkspace` does NOT exist.** Co-Exist iOS uses `App.xcodeproj` (Capacitor 5+ uses Swift Package Manager, not CocoaPods). The 6-step recipe must use `-project App.xcodeproj` not `-workspace App.xcworkspace`.

2. **Co-Exist not pre-cloned.** `~/projects/` had only `wattleos` before this audit. NOW CLONED to `~/projects/coexist/` (HTTPS clone via git).

3. **Node not installed on SY094.** Status_board already has a row for "install Node 22 on SY094 (Tate via MacInCloud GUI)." This means `npm install` cannot run on SY094, which means `node_modules/` is empty after clone, which means `xcodebuild` cannot resolve the local-path SPM packages declared in `ios/App/CapApp-SPM/Package.swift` (they reference `../../../node_modules/@capacitor/*` and `@capgo/capacitor-social-login`).

4. **Workaround verified live:** rsync the relevant subset of node_modules from VPS to SY094. Only `@capacitor/*` and `@capgo/*` are needed by SPM, total ~8MB.
   ```bash
   rsync -az -e "ssh -o PubkeyAuthentication=no" \
     ~/workspaces/coexist/node_modules/@capacitor \
     ~/workspaces/coexist/node_modules/@capgo \
     user276189@SY094.macincloud.com:~/projects/coexist/node_modules/
   ```
   After this, `xcodebuild -list -project App.xcodeproj` resolves all SPM deps (cached fetches from github + creates working copies) and lists the schemes successfully. Primary scheme: `App`. Build configs: Debug, Release.

### Updated 6-step recipe (corrected)

Replace step 3 in the original TL;DR with:

```bash
# 3a. On VPS: ensure node_modules is up to date (Capacitor SPM deps + dist)
cd ~/workspaces/coexist
git fetch && git checkout main && git pull
npm install
npm run build
npx cap sync ios

# 3b. On VPS: rsync node_modules + ios/ to SY094
sshpass -p "$PW" rsync -az -e "ssh -o PubkeyAuthentication=no" \
  ./node_modules/@capacitor ./node_modules/@capgo \
  user276189@SY094.macincloud.com:~/projects/coexist/node_modules/

# 3c. On SY094: pull main (gets ExportOptions.plist + ios/ folder updates)
$SSH "cd ~/projects/coexist && git fetch && git checkout main && git pull"
```

Replace step 5 in the original TL;DR with `-project App.xcodeproj` instead of `-workspace App.xcworkspace`.

### New status_board surface (added 2026-04-29 13:00 AEST)

Existing P1/P2/P3 are unchanged. NEW: the SY094 Node-install row was already on the board (predates today). The node_modules-rsync workflow is now documented here, no new row needed. The .xcodeproj-not-.xcworkspace correction is doctrine-only.

### What is NOT blocked anymore

- SY094 build environment health (verified)
- Co-Exist iOS source on Mac (cloned)
- SPM dependency resolution (works after rsync)
- Schemes / build configs visible (App, Debug+Release)

### What IS still blocked (unchanged)

- ASC API key: P1, owner=tate
- Apple team ID: P3, owner=tate
- Co-Exist Android keystore password: P2, owner=tate (independent of iOS path; tracked separately)
- ExportOptions.plist: in flight via fork mojgrmwg as of 2026-04-29 13:00 AEST. Will be on main shortly.

When all four unblockers land, the autonomous Co-Exist iOS TestFlight ship is ONE driver-script run away.
