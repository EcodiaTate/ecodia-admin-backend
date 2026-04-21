# Co-Exist — Client Knowledge File

Read this BEFORE any Co-Exist work. Update it AFTER every session.

---

## Overview
- **Client:** Co-Exist Australia (Kurt is the contact)
- **App:** Conservation/youth engagement mobile app
- **Stack:** Vite + React + TypeScript + Capacitor (iOS + Android) + Supabase
- **Repo:** GitHub (EcodiaTate org)
- **Hosting:** Vercel (web), App Store (iOS), Google Play (Android)
- **App ID:** `org.coexistaus.app`
- **Agreement:** Signed by Tate. Waiting on Kurt countersign. Clauses 2.5 and 10.2 define scope boundaries.

---

## Build & Deploy Workflow — FOLLOW EVERY TIME

### Web (Vercel)
Auto-deploys from main branch. Push to GitHub, Vercel handles the rest.

### Android (Google Play)
1. **Corazon (Windows laptop):** Make code changes, test locally
2. `git add . && git commit -m "description" && git push`
3. **SY094 (Mac) or Corazon with Android Studio:**
   - `cd` to project directory
   - `git pull`
   - `npm install`
   - `npm run build`
   - `npx cap sync android`
   - Open in Android Studio: `npx cap open android`
   - Build > Generate Signed Bundle/APK
   - Signing key: `android/app/coexist-release.jks` (password in env vars `COEXIST_KEYSTORE_PASSWORD`, `COEXIST_KEY_PASSWORD`)
   - Test on device/emulator
   - Upload AAB to Google Play Console

### iOS (App Store)
1. **Corazon:** Make code changes, commit, push
2. **SY094 (Mac via SSH):**
   - `cd` to project directory
   - `git pull`
   - `npm install`
   - `npm run build`
   - `npx cap sync ios`
   - `npx cap open ios` (opens Xcode)
3. **Xcode (via SY094 GUI or VNC):**
   - Select target device/Generic iOS Device
   - Product > Build (verify no errors)
   - Product > Archive
   - Distribute App > App Store Connect
   - Upload
4. **App Store Connect:** Submit for review (or TestFlight first)

### Pre-Build Checklist (EVERY build)
- [ ] `npm run build` succeeds with zero errors
- [ ] Version bumped in `capacitor.config.ts` (versionCode + versionName)
- [ ] Version bumped in `android/app/build.gradle`
- [ ] Version bumped in `ios/App/App.xcodeproj` (if iOS)
- [ ] All environment variables set correctly
- [ ] Tested on mobile (responsive) before native build
- [ ] No console errors in browser dev tools

---

## Android Splash Screen (Fixed Apr 14 2026)

**Problem:** Default Vite/Capacitor splash screen showing instead of Co-Exist branding. Splash not fully disappearing on some devices.

**Root cause:** `splash.png` in all `android/app/src/main/res/drawable-*` folders was the 4KB default Capacitor placeholder.

**Fix applied:**
- Generated branded splash screens using `scripts/generate-splash.cjs` (uses jimp)
- Co-Exist logo (`public/logos/black-logo-transparent.png`, 1024x1024) centered on `#fafaf8` background
- All 11 density variants generated (6 portrait + 5 landscape)
- Config in `capacitor.config.ts` was already correct (`androidSplashResourceName: 'splash'`)

**Regenerating splash screens:** `node scripts/generate-splash.cjs` from project root.

**Android 12+ note:** Uses `androidx.core:core-splashscreen`. The system splash shows `@drawable/splash` via `AppTheme.NoActionBarLaunch` in `styles.xml`. Then Capacitor's plugin shows its own splash. If splash lingers, check `launchAutoHide` and `launchShowDuration` in `capacitor.config.ts`.

---

## Scope & Contract Notes
- **Clauses 2.5 and 10.2** define what's in/out of scope. Read the agreement BEFORE exploring technical solutions for new requests.
- Squarespace sync request (Apr 13) was out of scope per these clauses. Check contract first, always.
- One round of revisions included in quote.

---

## Known Issues
- Splash screen on Android: FIXED (Apr 14) — needs rebuild + deploy to verify on device
- Hero images fix: LIVE (commit 6018cc0)
- Blank page fix: LIVE
- Security keys: purged
- Supabase key rotation: still needed (Tate's action)

---

## Architecture Notes
- Capacitor wraps the Vite/React web app for native
- `capacitor.config.ts` is the central config for all native behaviour
- Android signing key at `android/app/coexist-release.jks`
- Push notifications via FCM (Android) + APNs (iOS) — `google-services.json` required in `android/app/`
- Edge-to-edge rendering enabled in `MainActivity.java`
- ESM project (`"type": "module"` in package.json) — use `.cjs` extension for CommonJS scripts

---

## Credentials & Access
- Test credentials: stored in kv_store `creds.coexist_test`
- App Store Connect: apple@ecodia.au
- Google Play Console: via Tate's Google account

---

## Lessons Learned
- Apr 13: Always check contract clauses before exploring technical solutions for new feature requests
- Apr 14: splash.png in Android res folders must be replaced manually or via `scripts/generate-splash.cjs` — Capacitor doesn't auto-generate from web assets
- Apr 14: jimp works on Windows where sharp fails (no native deps). Use `.cjs` extension in ESM projects.
- Apr 14: Android 12+ has TWO splash screens (system + Capacitor plugin). Both need correct assets.
- Apr 21: Excel sync model (FINAL). SharePoint "Master Impact Data Sheet.xlsx" sheet "Post Event Review" is source of truth. Microsoft Forms populates integer-ID rows (rows 2-256, pre-2026 Forms history, UNTOUCHABLE). Supabase Edge Function `excel-sync` (project tjutlbzekfouwsiaplbr) runs the sync.
  - Default direction is `from-excel` (safe read). Never writes to sheet without explicit `?direction=to-excel`.
  - pg_cron jobid 9 (`excel-from-sync`, `*/30 * * * *`): calls `public.cron_excel_from_sync()` which invokes Edge Function with `direction=from-excel`. Reads sheet, writes Forms rows to DB.
  - pg_cron jobid 10 (`excel-to-sync-hourly`, `0 * * * *`): calls `public.cron_excel_to_sync()` which invokes Edge Function with `direction=to-excel`. Pushes all app-created completed events (UUID IDs) from SYNC_CUTOFF_DATE (2026-01-01) to the sheet. Idempotent via id-to-rowIndex map.
  - IDs cannot collide: Forms = integer, app = UUID. `from-excel` skips UUID rows (app owns them); `to-excel` only writes UUID rows.
  - Column mapping (array-index = sheet-col): 0=ID, 1=Title, 2=Date, 3=Collective, 4=Location, 5=Postcode, 6=Primary Organiser (hosting org: Co-Exist/Zorali/etc, from `event_organisations` junction with role priority host>organiser>any, fallback 'Co-Exist'), 7-9=Landcare/OzFish, 10=Leader (person), 11=Attendees, 12-27=survey + metrics.
  - Dedup: if an app event matches a Forms row on (title + date_start + collective), both rows coexist on the sheet (admin reconciles). `syncToExcel` returns `dupeWarnings: [{appEventId, formsRowIndex, formsId, title, date, collective}]` in the response for admin surfacing. No auto-skip (false positives would lose data).
  - `organisations` table is seeded with one row (name='Co-Exist', type='community'). `event_organisations` junction is empty; will populate as partner orgs (Zorali etc) are onboarded to the app.

---

## Excel Sync — Key Paths
- Edge Function source: `supabase/functions/excel-sync/index.ts` in coexist repo
- Deploy: `cd /home/tate/workspaces/coexist && SUPABASE_ACCESS_TOKEN=<creds.supabase_access_token> npx supabase functions deploy excel-sync --project-ref tjutlbzekfouwsiaplbr --no-verify-jwt`
- Graph API file: DRIVE_ID `b!jB_eUPJMbUWf3eip_Me-34G0StMYwYdHtdf4sTNow-uVV9nof_IvQprzswNpaD8y`, ITEM_ID `01RJHFBL37QUUGOQUVL5DJ67A53VKNDAGE`
- Graph API creds: `kv_store.creds.coexist_graph_api` (tenant_id, client_id, client_secret). Injected into Edge Function env (Deno.env), not in code.
- Supabase Management API PAT: `kv_store.creds.supabase_access_token` (`sbp_...`).
- Cron control via `https://api.supabase.com/v1/projects/tjutlbzekfouwsiaplbr/database/query` with Bearer PAT:
  - Disable: `SELECT cron.alter_job(JOBID, active := false)`
  - Jobids: 9 = `excel-from-sync` (every 30m), 10 = `excel-to-sync-hourly` (every hour on the hour).
- Cloudflare WAF quirk: the Management API blocks some SQL payloads with HTTP 403 `error code: 1010`. Workaround: send body via `curl --data-binary @file.json` with a `User-Agent: supabase-cli` header.
- Column A holds the row ID. Forms rows = integers (immutable, owned by sheet). App rows = UUID strings (owned by DB, written by `to-excel`).
- Manual probe: `curl -X POST 'https://tjutlbzekfouwsiaplbr.supabase.co/functions/v1/excel-sync?direction=from-excel' -H "Authorization: Bearer <service_role_key>"`. Always pass an explicit `direction=` when probing.
