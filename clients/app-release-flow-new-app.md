---
triggers: capacitor-init, cap-add-ios, cap-add-android, new-app-creation, bundle-id-decision, asc-app-record-create, play-console-app-create, first-release-flow, au.ecodia.{slug}, store-listing-screenshots, feature-graphic, privacy-policy-url, npx-cap-add, ios-app-id-register, content-rating-iarc
---

# New App Creation Flow - Doctrine

End-to-end flow for taking an Ecodia (or client) app from "we have a web codebase" to "shippable to both stores under TestFlight + Play Internal". Capacitor-wrapped Vite/React/Next webview is the default Ecodia stack.

Read this BEFORE creating a new app. Companion docs:
- `app-release-flow-android.md` - per-release Android flow once the app exists
- `app-release-flow-ios.md` - per-release iOS flow once the app exists
- `~/ecodiaos/clients/macincloud-access.md` - SY094 access pattern
- `~/ecodiaos/patterns/ios-signing-credential-paths.md` - iOS signing credentials

---

## Overview

Creating a new app means lining up SEVEN things in order:

1. **Bundle ID decision + naming** - settle the convention before any console click.
2. **Capacitor scaffold** in the existing web repo - `npx cap add ios`/`android`.
3. **Apple side** - register App ID, create App Store Connect record, set up TestFlight.
4. **Google side** - create Play Console app entry, generate signing keystore, opt in to Play App Signing.
5. **Branding assets** - icons, splash screens, store screenshots, feature graphic.
6. **Marketing/legal pages** - privacy policy, support page, terms.
7. **First TestFlight + Play Internal builds** - prove the pipeline end-to-end before promising production.

Total wall time: 6-12 hours of focused work, spread across 1-3 days for review windows. Many sub-steps can be parallelised.

---

## Bundle ID + naming convention

**Ecodia-owned IP** (we retain ownership under the IP-retention model):
- Bundle ID: `au.ecodia.{slug}`
- App Name: human-readable, e.g. "Roam", "Chambers", "Sidequests"
- Slug: lowercase, ASCII, no separators (`coexist` not `co-exist` or `co_exist`)

**Client-owned IP** (rare; full assignment with rate-card-or-above pricing):
- Bundle ID: `org.{client-domain-tld-reversed}.{app}` or `com.{client}.{app}` per client preference
- Example: `org.coexistaus.app` (Co-Exist's brand owns the app, even though we operate it under licence)

**Apple is permissive** - any reverse-domain you control. **Google is also permissive** but the bundle ID is permanent on a Play Console listing - changing it means a brand-new listing with zero install history.

**Decision rule:** if the IP-retention contract is in play (default for our discounted builds), use `au.ecodia.{slug}`. The client's brand is the marketing name; the bundle ID is plumbing. If the contract is full-IP-assignment, use the client's reverse domain.

---

## Step 1: Capacitor scaffold

Assumes the web codebase is already deployed to Vercel and `webDir` is `dist/` (Vite/React) or `out/` (Next static export).

```bash
SLUG=newapp
APP_ID=au.ecodia.$SLUG
APP_NAME="My App"

cd ~/workspaces/$SLUG/fe

# Install Capacitor core + CLI + native platforms
npm install --save @capacitor/core @capacitor/cli
npm install --save @capacitor/android @capacitor/ios

# Initialise Capacitor (creates capacitor.config.ts)
npx cap init "$APP_NAME" "$APP_ID" --web-dir=dist

# Add native platforms
npm run build           # produces dist/
npx cap add android
npx cap add ios
```

Add the standard plugin set we use:
```bash
npm install --save \
  @capacitor/app \
  @capacitor/preferences \
  @capacitor/keyboard \
  @capacitor/status-bar \
  @capacitor/splash-screen \
  @capacitor/network \
  @capacitor/haptics
```

Add per-app plugins as needed: `@capacitor/camera`, `@capacitor/geolocation`, `@capacitor/push-notifications`, etc.

`npx cap sync` to copy web assets and install native plugin code into `android/` and `ios/`.

Pattern reference: copy a known-good `capacitor.config.ts` from `~/workspaces/coexist/capacitor.config.ts` or `~/workspaces/chambers/fe/capacitor.config.ts` and edit `appId`, `appName`, plugin config. Standard config includes splash screen behaviour, status bar style, keyboard handling.

Add `.gitignore` entries (these are auto-generated but verify):
```
android/.idea
android/.gradle
android/app/build/
android/app/release/
android/local.properties
android/app/google-services.json    # IF this contains real Firebase keys
ios/App/Pods/
ios/App/build/
ios/App/App.xcodeproj/project.xcworkspace/xcuserdata/
ios/App/App.xcodeproj/xcuserdata/
ios/App/App.xcworkspace/xcuserdata/
*.mobileprovision
*.p12
*.p8
*.jks
*.keystore
```

---

## Step 2: Apple side - register App ID + create ASC record

### 2a: Register the App ID
GUI-only at developer.apple.com. The first time per app:

1. `~/ecodiaos/scripts/laptop nav https://developer.apple.com/account/resources/identifiers/list` (Tate must be signed in to his Apple ID on the relevant Chrome profile, otherwise use SY094 GUI via the MacInCloud web console).
2. Identifiers > + > App IDs > App > Continue.
3. Description: "{App Name}". Bundle ID: explicit, `au.ecodia.{slug}`.
4. Capabilities to enable upfront for our standard apps:
   - Push Notifications
   - Associated Domains (for Universal Links)
   - Sign in with Apple (only if app uses Apple SSO)
   - In-App Purchase (Roam pattern)
5. Continue > Register.

This is one of the GUI-only steps. There IS an App Store Connect API endpoint for App ID registration, but it's behind enterprise enrolment and rarely worth the setup overhead for the volume of apps we ship. Path of least resistance: 5 minutes of GUI on first creation, then never again.

### 2b: Create the App Store Connect record
1. `~/ecodiaos/scripts/laptop nav https://appstoreconnect.apple.com/apps`
2. + > New App.
3. Platform: iOS. Name: marketing name (this is shown on the App Store). Primary Language: English (Australia). Bundle ID: pick the one you just registered. SKU: `{slug}-2026` (any unique string for your reference). User Access: Full Access.
4. Create.

You now have a live ASC record. It cannot be submitted yet because there's no build, no metadata, no screenshots.

### 2c: Configure TestFlight
1. App Store Connect > {App} > TestFlight.
2. Internal Testing > + > add Tate's Apple ID, name the group "Ecodia Internal".
3. (Later) External Testing > + > add real users; this requires Beta App Review (~24h first time).

### 2d: ASC API key (if not already done globally)
Per `~/ecodiaos/patterns/ios-signing-credential-paths.md` path 1. One key per Apple Developer team is enough; reuse across all apps.

1. App Store Connect > Users and Access > Integrations > Keys > + > Generate API Key.
2. Name: "ecodia-ci". Access: Developer (or App Manager if Developer is too narrow for some operations).
3. Generate. **Download the `.p8` IMMEDIATELY** - you only get one chance.
4. Note the Key ID (10-char) and Issuer ID (UUID).
5. Store in kv_store:
   ```
   creds.asc_api_key_p8       = <full .p8 contents>
   creds.asc_api_key_id       = <10-char>
   creds.asc_api_issuer_id    = <UUID>
   creds.apple.team_id        = <10-char team ID, find at developer.apple.com > Membership>
   ```

---

## Step 3: Google side - create Play Console app + generate keystore

### 3a: Generate the upload keystore
This is the keystore Gradle uses to sign the AAB before upload. Google re-signs with the actual app signing key under Play App Signing. Generate ONCE per app, store forever (loss = forced key rotation).

```bash
SLUG=newapp
cd ~/workspaces/$SLUG/fe/android/app

keytool -genkey -v \
  -keystore $SLUG-release.jks \
  -alias $SLUG \
  -keyalg RSA -keysize 2048 -validity 25000 \
  -storepass "$KEYSTORE_PASSWORD" -keypass "$KEY_PASSWORD" \
  -dname "CN=Ecodia, OU=Engineering, O=Ecodia Pty Ltd, L=Sunshine Coast, ST=QLD, C=AU"
```

Pick strong, unique passwords for `KEYSTORE_PASSWORD` and `KEY_PASSWORD` (often the same value is fine, but record them clearly). Validity 25000 days = 68 years; outlives every concern.

**Backup immediately:**
```bash
# Encode for kv_store
base64 -w0 $SLUG-release.jks | head -c 50; echo "..."  # sanity check

# Store in kv_store (atomic upsert)
mcp__supabase__db_execute "INSERT INTO kv_store (key, value) VALUES (
  'creds.android.$SLUG',
  jsonb_build_object(
    'keystore_b64', '$(base64 -w0 $SLUG-release.jks)',
    'keystore_password', '$KEYSTORE_PASSWORD',
    'key_alias', '$SLUG',
    'key_password', '$KEY_PASSWORD',
    'created_at', NOW()::text
  )
) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()"
```

### 3b: Wire signing config in `android/app/build.gradle`
```gradle
android {
    signingConfigs {
        release {
            storeFile file('newapp-release.jks')
            storePassword System.getenv('NEWAPP_KEYSTORE_PASSWORD') ?: project.findProperty('NEWAPP_KEYSTORE_PASSWORD') ?: ''
            keyAlias 'newapp'
            keyPassword System.getenv('NEWAPP_KEY_PASSWORD') ?: project.findProperty('NEWAPP_KEY_PASSWORD') ?: ''
        }
    }
    buildTypes {
        release {
            signingConfig signingConfigs.release
            minifyEnabled false
            proguardFiles getDefaultProguardFile('proguard-android.txt'), 'proguard-rules.pro'
        }
    }
}
```

Gitignore the `.jks`. Restore from kv_store at build time.

### 3c: Create the Play Console app entry
GUI-only.
1. `~/ecodiaos/scripts/laptop nav https://play.google.com/console`
2. Create app.
3. App name (marketing). Default language: English (Australia). App or game. Free or paid.
4. Declarations: declare developer program policies + US export laws.
5. Create app.

### 3d: Wire app signing
1. Play Console > {App} > Setup > App signing.
2. **Use Play App Signing.** Upload the upload key certificate (export from your `.jks`):
   ```bash
   keytool -export -rfc -keystore newapp-release.jks -alias newapp -file upload_certificate.pem
   ```
   Drag `upload_certificate.pem` into Play Console.
3. Play generates the actual app signing key on Google's side. You only ever ship with the upload key.

### 3e: Set up internal testing track
1. Play Console > {App} > Testing > Internal testing.
2. Testers > Create email list > add Tate's Gmail.
3. Save.

The internal track has zero review delay - upload an AAB and it's testable on devices in 5-10 minutes.

### 3f: Play Developer API service account (optional, for autonomy)
Skip if you're fine with web-UI uploads. Set up if planning frequent releases.

1. Play Console > Setup > API access > Choose project (or create one if first time).
2. Service accounts > Create new service account > follow link to Google Cloud Console.
3. In GCP: + Create Service Account > name "ecodia-play-publisher" > Role: skip (Play Console grants its own role) > Done.
4. Keys > Add Key > JSON > Create. Download the JSON.
5. Back in Play Console > API access > Grant access to the new service account > Account permissions: "Release manager" or "Admin". Apply.
6. Store in kv_store: `creds.google_play_service_account_json` (raw JSON content, not file path).

This SA can publish to ALL apps under this Play Console developer account, so it's a one-time global setup.

---

## Step 4: Branding assets

### App icons
Required sizes:
- iOS: 1024x1024 (App Store) + a generated set for device sizes. Capacitor + `@capacitor/assets` can generate the set from a single 1024x1024 master.
- Android: 512x512 (Play Store) + `mipmap-*` densities. Same `@capacitor/assets` flow, or use Android Studio's Asset Studio.

Tooling:
```bash
npm install --save-dev @capacitor/assets

# Place a 1024x1024 PNG at resources/icon.png
# Place a 2732x2732 PNG at resources/splash.png (and resources/splash-dark.png if you have one)

npx capacitor-assets generate
```

This populates `ios/App/App/Assets.xcassets/AppIcon.appiconset/` and `android/app/src/main/res/mipmap-*/`.

### Splash screens
Either rely on `@capacitor/assets` (simpler) OR generate manually for Android using a script (Co-Exist pattern at `scripts/generate-splash.cjs` using jimp). The `@capacitor/assets` approach is the default for new apps.

Branding rule: Capacitor's default placeholder splash is a dead giveaway and Tate will reject any release that ships with it. Always generate branded splash before any TestFlight or Internal track upload.

### Store assets

**App Store (iOS):**
- App icon 1024x1024 (no transparency, no rounded corners - Apple does that)
- 6.5" iPhone screenshots (1284x2778), at least 3, max 10
- 5.5" iPhone screenshots (1242x2208), optional but recommended
- 12.9" iPad Pro screenshots (2048x2732), only if iPad-supported
- App preview video (optional)
- Description, promotional text, keywords, support URL, marketing URL, privacy policy URL

**Google Play:**
- App icon 512x512 PNG
- Feature graphic 1024x500 PNG (mandatory, shows at top of Play listing)
- Phone screenshots (min 320px, max 3840px on long edge), at least 2, max 8
- 7-inch tablet screenshots (optional)
- 10-inch tablet screenshots (optional)
- Short description (80 char max), full description (4000 char max)

Generate screenshots from a real build running on a real device (or simulator). Always run the actual app, not Figma mockups - reviewers reject "design mockup" screenshots that don't match the live app.

---

## Step 5: Marketing/legal pages

Required URLs that must be publicly reachable BEFORE any submission:

| URL | Required by |
|-----|-------------|
| Privacy policy | Both stores |
| Support / contact URL | Both stores |
| Marketing URL | App Store (optional) / Play (under "App information") |
| Terms of service | Both stores if app has user accounts |

**Convention for Ecodia-owned IP:**
- Privacy: `https://ecodia.au/legal/{slug}/privacy`
- Support: `https://ecodia.au/support/{slug}` or single page `https://ecodia.au/support`
- Terms: `https://ecodia.au/legal/{slug}/terms`

**Convention for client-owned IP:**
- Use the client's own domain. They host the privacy policy. We provide a template.

Privacy policy must specifically declare:
- What data is collected (email, location, photos, etc.)
- Why it's collected
- Third-party data sharing (Supabase, Sentry, FCM/APNs, payment processors)
- Data retention + deletion process
- Contact for data subject requests

Both stores' Data Safety / App Privacy forms force you to enumerate this anyway, so the privacy policy and the form must agree. Cross-reference before publishing.

---

## Step 6: First builds end-to-end

Once everything above is in place, run the per-platform release flows:

1. iOS: follow `app-release-flow-ios.md` Steps 0-7 to land a build in TestFlight.
2. Android: follow `app-release-flow-android.md` Steps 1-7 to land a build in Internal track.

The first build is always the slowest because every credential surface is being exercised for the first time. Expect to debug.

**Smoke-test checklist:**
- App launches on a real device (not just simulator/emulator).
- All declared permissions prompt correctly (camera, location, push, etc.).
- Auth flow works on the real bundle ID (OAuth redirect URIs need to include the native app schemes).
- Deep links work: `{slug}://...` and `https://{domain}/...` (Universal Links iOS, App Links Android).
- Push notifications deliver to the device (test from Firebase console or backend).

---

## Time-box estimates

| Step | Time |
|------|------|
| Bundle ID decision + Capacitor scaffold | 30 min |
| Apple App ID + ASC record + TestFlight setup | 30-45 min |
| ASC API key generation + kv_store storage | 10 min (only if first time globally) |
| Android keystore generation + kv_store backup | 15 min |
| Play Console app entry + signing setup + internal track | 30-45 min |
| Play Developer service account (optional) | 15 min |
| Icon + splash generation | 30-60 min |
| Store screenshots (per platform) | 1-2h each (the slowest part for new apps) |
| Privacy policy + support page authoring | 1-3h depending on novelty |
| First TestFlight build | 60-90 min |
| First Play Internal build | 30-45 min |
| Beta App Review (external testing on iOS, first time only) | 24h wait |
| Smoke test + iteration | 2-4h |

**Total to "shippable to internal/TestFlight":** ~8-12 hours of focused work over 1-3 days.

**Total to "live on production stores":** add 1-3 days for first review (production review on both platforms).

---

## Common failure modes + fixes

| Symptom | Cause | Fix |
|---------|-------|-----|
| `Bundle ID is not available` (Apple) | Already registered under another team or by a previous attempt | Pick a different ID. Apple is strict on uniqueness across the ecosystem. |
| Play Console: "Package name already exists" | Same; pick a different one or contact support if you legitimately own it | Same fix |
| Capacitor `cap add ios` fails | macOS only; cannot run on VPS or Corazon | SSH to SY094 and run there: `$SSH "cd ~/projects/$SLUG && npx cap add ios"` |
| `pod install` fails on first iOS scaffold | Stale CocoaPods specs | `pod repo update` then retry |
| Default Capacitor icons shipped | `@capacitor/assets` not run, or run before `resources/icon.png` was placed | Generate branded icon, place at `resources/icon.png`, run `npx capacitor-assets generate` |
| Privacy policy URL returns 404 | Page not deployed or wrong route | Verify with `curl -sI {url}` returns 200 BEFORE submitting to Apple/Google. Reviewers check this first. |
| Play Console: data safety form blocks rollout | Form not completed | Setup > Data safety; declare all data types collected. Cross-reference with privacy policy. |
| App Store Review rejection: "missing privacy policy URL" | URL field empty or returns 404 | Fix the URL; resubmit (no penalty for resubmission) |
| App Store Review rejection: "uses public APIs in non-public way" | Capacitor or a plugin used a private framework | Identify which plugin from the rejection email; usually fixed by updating to latest plugin version |
| Play Console: "App bundle is not signed with your upload key" | First upload after generating keystore went to a track Google still sees as "unconfigured" | One-off; happens if you uploaded before completing app signing setup. Re-do app signing setup, then re-upload. |
| "Invalid Provisioning Profile" on first iOS build | App ID capabilities don't match the entitlements file | In Xcode, sync capabilities (Signing and Capabilities tab > automatic). Or manually update on developer.apple.com. |

---

## Things Tate physically must do (per new-app)

These are GUI-only at one of Apple/Google's consoles. Insert a `status_board` row with `entity_type='task'`, `next_action_by='tate'` for each:

1. **Apple App ID registration** - one click but the Apple ID 2FA may prompt.
2. **App Store Connect record creation** - GUI form fill.
3. **Beta App Review submission** for external TestFlight (first time only per app).
4. **App Store metadata first pass** - description, keywords, screenshots upload (subsequent updates can use fastlane `deliver`).
5. **Apple Developer Program License Agreement acceptance** if Apple has pushed a new version recently. App Store Connect won't process builds until accepted.
6. **Play Console app entry creation** - GUI form fill.
7. **Play Console app signing wiring** - drag the upload certificate into the GUI.
8. **Play Console: data safety form, content rating questionnaire, target audience declaration** - GUI-only, blocks rollout.
9. **Privacy policy + support page authoring + deployment** - if not yet done for this app.

For Ecodia-owned apps, these all go through the `code@ecodia.au` Apple ID and Tate's Google account. For client-owned apps, the client must do steps 1, 2, 6 themselves under their own developer accounts (or transfer ownership to ours).

---

## Real apps + state (snapshot 2026-04-29)

| App | Bundle ID | Capacitor scaffold | Apple side | Google side | Notes |
|-----|-----------|--------------------|-----------|-----|-------|
| Co-Exist | `org.coexistaus.app` | Done | App ID + ASC record exist | Play Console exists, internal track | Most mature reference. |
| Roam | `au.ecodia.roam` | Done | App ID + ASC record exist | Play Console exists | Production blocked on GST registration. |
| Chambers | `au.ecodia.chambers` | In progress (`feat/capacitor-ios-wrap-2026-04-29`) | NOT YET | NOT YET | Phase 1 web only; mobile Capacitor is the next phase. |
| Sidequests | `au.ecodia.sidequests` | NOT YET | NOT YET | NOT YET | Backlog. |

---

## Critical gaps (status_board candidates)

1. **No template "new app bootstrap" script.** The seven steps above are tribal knowledge. A `~/ecodiaos/scripts/bootstrap-new-app {slug}` script could automate Steps 1, 3a-b, 4 (icon generation) end-to-end. Worth ~2-4h of work, saves ~1h per new app. Surface as P3.

2. **No automated privacy policy template.** Each new app needs a privacy policy that enumerates what it collects. A template at `ecodia.au/legal/_template` parameterised by app slug would cut ~1-2h per new app. Surface as P3.

3. **`@capacitor/assets` not standardised across our existing apps.** Co-Exist uses a custom jimp script; Chambers uses TBD. Settling on `@capacitor/assets` as the new-app default would reduce branding-asset divergence. Surface as P4.

4. **No standard `ExportOptions.plist` committed to the new-app template.** Without it, `xcodebuild -exportArchive` needs custom args. Add a default plist to the standard scaffold. Surface as P4.

---

## Origin

Authored 2026-04-29 by fork `fork_mojfz9q6_61253f` against the brief: "creating new apps." Codifies the seven-phase new-app flow generalised from the Co-Exist, Roam, and Chambers experiences. Companion docs: `app-release-flow-android.md`, `app-release-flow-ios.md`, `~/ecodiaos/clients/macincloud-access.md`, `~/ecodiaos/patterns/ios-signing-credential-paths.md`.
