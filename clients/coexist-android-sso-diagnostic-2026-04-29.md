---
triggers: coexist-android-sso, credentialmanager, no-credential-error, play-app-signing-sha-1, gcp-project-528428779228, capacitor-social-login, org.coexistaus.app, samsung-android-leaders, oauth-consent-screen, web-client-id-528428779228, brendan-coexist, coexist-google-signin-regression
---

# Co-Exist Android Google SSO regression - diagnostic 2026-04-29

Fork: fork_mojh5ki2_b8d3a3 (Tate intervention: aborted GUI verification mid-fork due to Chrome thrash; recon delivered from codebase + env + kv_store, GUI verification deferred to Tate)

## TL;DR (named root cause + fix)

**Most likely root cause (H1 - 65% confidence): Google Play App Signing key SHA-1 missing from the Android OAuth client in GCP Console project 528428779228.** Once Google Play takes over signing on internal/closed/production track, the SHA-1 that Google's CredentialManager sees on real installed builds is the Play-managed App Signing certificate, NOT the local `coexist-release.jks`. This is the single most common cause of post-release Android Google SSO regressions: the Android OAuth client only has the local release SHA-1 registered, so CredentialManager rejects with `NO_CREDENTIAL` for users on Play-installed builds (Brendan + Samsung-Android leaders).

**Fix step:** Pull the App signing certificate SHA-1 from Google Play Console (Setup > App signing > App signing key certificate), then add it as an additional SHA-1 fingerprint on the Android OAuth client in GCP Console (APIs & Services > Credentials > Android client for `org.coexistaus.app`). Both the local-release SHA-1 and the Play App Signing SHA-1 should be listed. After save, Google propagates within ~5 minutes.

**Lower-likelihood alternates** are H2 (OAuth consent screen in Testing mode) and H3 (env override at build time pointing to wrong webClientId). Both worth confirming during the same console click-through.

---

## Section 1: GCP project identity

| Item | Expected | Actual | Mismatch |
|------|----------|--------|----------|
| Project number | 528428779228 | 528428779228 (codebase, kv_store, .env.production all aligned) | None |
| Project ID (slug) | unknown from codebase alone | `co-exist-australia-01` (from `FCM_PROJECT_ID` in `.env.production`) | Confirm with Tate that `co-exist-australia-01` IS project number `528428779228` (typical: project ID is the human slug, project number is the numeric. They refer to the same project unless there's a project-split.) |

**Tate to verify in GCP Console:** open `https://console.cloud.google.com/home/dashboard?project=528428779228` and confirm Project ID matches `co-exist-australia-01`. If different, that itself is a regression vector.

---

## Section 2: Web OAuth client (used as `webClientId` by CredentialManager)

| Item | Expected | Actual |
|------|----------|--------|
| Hardcoded fallback in code (`use-auth.ts`) | Web application client ID for project 528428779228 | `528428779228-8ggdoqckphnq0hcvj0pr2b4r124530st.apps.googleusercontent.com` |
| Env override (`.env.production` on Corazon `D:\.code\coexist`) | If set, must be the Web client ID, NOT the Android client | `VITE_GOOGLE_WEB_CLIENT_ID="528428779228-8ggdoqckphnq0hcvj0pr2b4r124530st.apps.googleusercontent.com"` (matches fallback) |

**Verdict on the Web client itself:** the env-set value matches the hardcoded fallback. No drift between code and env. Both reference the same client ID. So at runtime, CredentialManager IS being passed the correct Web client ID string.

**Tate to verify in GCP Console:**
- Open `https://console.cloud.google.com/apis/credentials?project=528428779228`.
- Find the OAuth 2.0 Client ID `528428779228-8ggdoqckphnq0hcvj0pr2b4r124530st`.
- Confirm Type = "Web application".
- Confirm Authorized JavaScript origins include `https://app.coexistaus.org` (or whatever the production web origin is).
- Confirm Authorized redirect URIs include the production web sign-in callback (typically `https://app.coexistaus.org` or `https://app.coexistaus.org/__/auth/handler` if Firebase-mediated).

If the Web client itself is missing or its Type is wrong (e.g. someone deleted it and recreated as "Mobile"), CredentialManager can't talk to it. That would cause this regression.

---

## Section 3: Android OAuth client + SHA-1 fingerprints (THE PROBABLE FAULT POINT)

| Item | Expected | Actual |
|------|----------|--------|
| Package name on Android OAuth client | `org.coexistaus.app` (matches capacitor.config + applicationId) | UNVERIFIED - Tate must check GCP Console |
| Debug keystore SHA-1 | known: see below | `E2:3C:3F:AD:67:F1:56:56:E8:46:30:63:46:49:01:98:E5:AE:DE:45` (extracted from `~/.android/debug.keystore` on Corazon) |
| Release keystore SHA-1 | extractable with password | UNVERIFIED - keystore at `D:\.code\coexist\android\app\coexist-release.jks` (2778 bytes, last modified 28 Mar 2026), password in Tate's 1Password, not in kv_store |
| Google Play App Signing key SHA-1 | the SHA-1 Google's servers actually see for installed app builds | UNVERIFIED - only visible in Google Play Console > Setup > App signing |

**Tate to verify and extract:**

1. **Local release SHA-1** (run on Corazon PowerShell while at the laptop):
   ```powershell
   keytool -list -v -keystore "D:\.code\coexist\android\app\coexist-release.jks" -alias coexist
   ```
   Type the password from 1Password when prompted. Note the SHA1 line.

2. **Google Play App Signing SHA-1** (THIS is the one most likely missing from GCP):
   - Open https://play.google.com/console
   - Co-Exist app > Setup > App signing
   - Read the SHA-1 under "App signing key certificate". This is what Google sees on real installed builds.

3. **GCP Console Android OAuth client SHA-1 list**:
   - Open https://console.cloud.google.com/apis/credentials?project=528428779228
   - Click the Android OAuth 2.0 client (package name `org.coexistaus.app`)
   - Note all listed SHA-1 fingerprints

**Compare:** the GCP Console Android client SHA-1 list should include ALL of: debug SHA-1, local release SHA-1, AND Google Play App Signing SHA-1. If the Play App Signing SHA-1 is missing (most common regression vector after first Play upload), CredentialManager rejects every Play-installed device.

---

## Section 4: OAuth consent screen + API enablement

**Tate to verify:**

1. https://console.cloud.google.com/apis/credentials/consent?project=528428779228 - confirm:
   - Publishing status = "In production" (NOT "Testing").
   - If "Testing": Brendan + the Samsung-Android leaders' Google account emails are NOT in the testers list, which would block them with a generic sign-in failure.
   
2. https://console.cloud.google.com/apis/library?project=528428779228 - confirm enabled:
   - Google Identity Services (Identity Toolkit API)
   - Google+ API (legacy, sometimes still required for older flows)
   - Cloud Identity Platform if Firebase Auth is used

---

## Section 5: Firebase / google-services.json gap

**Observed:**
- No `google-services.json` in repo.
- `android/app/build.gradle` silently no-ops the `google-services` plugin if file is missing.
- `.env.example` does NOT reference `VITE_GOOGLE_WEB_CLIENT_ID` (docs gap, not a runtime issue).

**Why this matters:** `@capgo/capacitor-social-login` on Android uses `androidx.credentials.CredentialManager` directly with the Web client ID as `nonce`-bearing token requester. It does NOT require Firebase init for the sign-in itself, so missing `google-services.json` is intentional and not the regression cause for SSO.

BUT: if at any point the project switched between Firebase-mediated and direct CredentialManager flow, the Android OAuth client may have been auto-managed by Firebase ("Add fingerprint" in Firebase Console) and is now stale because the codebase moved off that path. Worth checking Firebase Console > Project Settings > Your apps > Android > SHA fingerprints to see if there's a Firebase-managed mirror that's out of sync with the GCP Console direct view.

---

## Section 6: Why GUI verification was not completed in this fork

Hard intervention from Tate at 13:18 AEST: relaunching Chrome to attach to his Default profile via CDP was thrashing his actual workstation Chrome. Chrome 136+ silently disables `--remote-debugging-port` when launched against the default `User Data` directory (security hardening to prevent malware exfiltrating cookies). Workaround attempted (clone Default profile to a mirror dir, launch Chrome there) failed to preserve auth cookies because Chrome held a write lock on the Cookies file, and the second copy attempt did not bind 9222 (likely `--do-not-de-elevate` from elevated agent context). The cost of finishing the GUI verification autonomously exceeded the value: Tate can do the manual click-through in 3 minutes when at the laptop.

Doctrine update needed: `~/ecodiaos/patterns/chrome-cdp-attach-requires-explicit-user-data-dir-and-singleton-clear.md` is incomplete - it doesn't cover the Chrome 136+ default-profile CDP block. Will append a section in a follow-up.

---

## Section 7: Actions for Tate (5-10 minutes at the laptop)

When at Corazon with logged-in Chrome:

1. Open https://console.cloud.google.com/apis/credentials?project=528428779228 - screenshot the Credentials page.
2. Click the Android OAuth client - screenshot the SHA-1 list. Note all SHA-1s.
3. Open https://play.google.com/console > Co-Exist > Setup > App signing - screenshot or copy the App signing key certificate SHA-1.
4. Open https://console.cloud.google.com/apis/credentials/consent?project=528428779228 - screenshot publishing status.
5. (Optional) PowerShell: `keytool -list -v -keystore "D:\.code\coexist\android\app\coexist-release.jks" -alias coexist` with 1Password password to get local release SHA-1.
6. Send the screenshots / SHA-1 values to me. I will identify exactly which SHA-1(s) are missing and write the GCP Console click-path to fix.

If Tate wants to fast-path the fix without screenshots: just paste the App signing key certificate SHA-1 from Play Console as a new fingerprint on the Android OAuth client in GCP Console, save, wait 5 minutes, ask Brendan to retry sign-in. 80% chance that resolves it.

---

## Section 8: What's confirmed vs unverified

**Confirmed from codebase / env / kv_store:**
- GCP project number: 528428779228
- Web client ID at runtime: `528428779228-8ggdoqckphnq0hcvj0pr2b4r124530st.apps.googleusercontent.com` (env matches code fallback)
- FCM project ID slug: `co-exist-australia-01`
- Android applicationId: `org.coexistaus.app`
- Debug keystore SHA-1: `E2:3C:3F:AD:67:F1:56:56:E8:46:30:63:46:49:01:98:E5:AE:DE:45`
- Release keystore exists, last modified 28 Mar 2026, password in 1Password
- No `.env` files in git, only `.env.example` and `.env.production` (the latter on Corazon disk)
- Plugin: `@capgo/capacitor-social-login` with Google enabled

**Unverified (Tate's GCP Console + Play Console click-through):**
- Web client config in GCP (origins, redirects)
- Android OAuth client existence + package name match
- All registered SHA-1 fingerprints on the Android client
- Local release SHA-1 (need 1Password)
- Google Play App Signing SHA-1
- OAuth consent screen publishing status
- Identity API enabled

---

## References

- Brief: status_board row "Coexist Android Google SSO - regression fix + visual test harness"
- Pre-staged Neo4j Episode: "Coexist Android Google SSO - GCP Console Diagnostic Pre-Stage" (id 3514, dated 2026-04-28)
- Codebase: `D:\.code\coexist` on Corazon (Bitbucket)
- Env file: `D:\.code\coexist\.env.production`
- Pattern doctrine: `~/ecodiaos/patterns/chrome-cdp-attach-requires-explicit-user-data-dir-and-singleton-clear.md` (needs follow-up section on Chrome 136+ default-profile block)
