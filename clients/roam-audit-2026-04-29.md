---
triggers: roam-audit, au.ecodia.roam, roam-iap, roam-release.keystore, paywall-modal-roam, apple-sign-in-roam, samsung-keyboard-inset, dpl_8B4GdEpzJRawYm8dqbm2KK7XxKZN, fork_mojkm195_05c428, lucide-react-Infinity-shadow, useSyncExternalStore, RoamTileServerPlugin, roam-86PUY7393S, roam-status-board-rows
---

# Roam Audit - 2026-04-29

**Fork:** fork_mojkm195_05c428
**Repo state:** main @ bd27e38 (today's PR #3 merged - purchase escape + haptic guard)
**Prod state:** Vercel dpl_8B4GdEpzJRawYm8dqbm2KK7XxKZN READY on commit bd27e38
**Today's prior ships:** PR #1 account AuthGate (cd919b1), PR #2 Apple Sign-In iOS gate (8868d73), PR #3 purchase escape + haptic guard (bd27e38).

## 1. Open status_board rows touching Roam

13 rows. 8 are next_action_by=tate (UX/policy/credentials), 4 are ecodiaos (queued or audit-only), 1 is external (DigitalOcean window).

| Priority | Row | Owner | Stale? |
|----|----|----|----|
| P2 | Brand hygiene attribution placement | tate | No - active decision queue |
| P2 | Android keystores not backed up to kv_store | tate | No - needs passwords from Tate |
| P2 | End-to-end app release pipeline (productized) | ecodiaos | No - deferred per Tate directive |
| P2 | Roam IAP Fix | tate | No - GST verified, Mac day pending |
| P2 | Visual reflection capability Layer 1 | tate | No - awaiting go-ahead |
| P3 | Mobile sign-in GUI verification consolidated checklist | ecodiaos | No - waits for laptop agent up |
| P4 | DO VPS maintenance window 2026-05-04 | external | No - dated future |
| P4 | Mobile sign-in SSO test coverage gap | ecodiaos | No - deferred per row |
| P4 | Roam UI P3-1 /login URL/mode mismatch | tate | No - awaiting UX decision |
| P4 | Roam + Sidequests attribution placement | tate | No - design call |
| P5 | Mobile sign-in .env.example documentation gap | ecodiaos | No |
| P5 | Roam UI P3-5 sign-in footer leaks routes | tate | No - awaiting UX decision |
| P5 | Roam UI P3-2/P3-3 mobile target sizes | ecodiaos | No - deferred batch |

No stale rows. No orphans. The board accurately reflects backlog.

## 2. Recent test reports / triage docs

`drafts/roam-iap-audit-2026-04-27.md` (audit, 5 findings):
- F1 PaywallModal inline styles - intentional for portal CSS isolation. NO ACTION.
- F2 WelcomeModal `useSyncExternalStore` SSR pattern - misapplied for Vite+Capacitor (no SSR). Recommend simplification to match PaywallModal `useState/useEffect`. **Shipped this fork - see section 8.**
- F3 tripGate dev-only `?paywall=1` shortcut - production-safe (DCE'd). NO ACTION.
- F4 Paywall copy "make this one count" - Tate voice call. SURFACE.
- F5 lucide-react `Infinity` import shadow - cosmetic. NO ACTION.

`drafts/roam-iap-submission-readiness-2026-04-27.md` (submission pack):
- All findings pre-IAP submission. Status board IAP row tracks completion. No actionable orphans.

## 3. Build / lint health

**Build:** `npm run build` clean in 26.2s. 0 errors.
- Bundle warning: `maplibre` chunk 1.02 MB / 276 KB gzip. Pre-existing, not a regression. Bigger concern in a future a11y pass than tonight.

**Lint:** `npm run lint` reports **102 errors, 36 warnings**. All 102 errors are pre-existing baseline:
- ~80% are `no-empty` (empty catch blocks in offline storage idb.ts, supabase auth.tsx, places/format.ts, peerSync, packsStore, etc.). Intentional swallows for offline-best-effort writes. SURFACE.
- 2x `prefer-const` in `lib/offline/rebuildNavpack.ts:124-125` (`sa`, `sb`). Trivial. SURFACE as deferred.
- 1x `no-useless-escape` in `lib/utils/openingHours.ts:82`. Trivial. SURFACE as deferred.
- 36 `@typescript-eslint/no-unused-vars` warnings. Mostly exports never imported (offline store helpers). SURFACE for future dead-code pass.

CI not blocking on lint (102 baseline errors and main keeps shipping). Not a deploy gate.

## 4. Smoke probes (server-side curl)

| Path | HTTP | Notes |
|----|----|----|
| `/` | 200 | SPA shell |
| `/login` | 200 | SPA shell |
| `/account` | 200 | SPA shell - AuthGate is client-side (cannot verify via curl) |
| `/purchase/success` | 200 | SPA shell - escape link is client-side |
| `/legal/privacy` | 200 | SPA shell |

All routes serve. Routes are client-rendered SPA so AuthGate / escape-link verification requires GUI - flagged in audit row P3 "Mobile sign-in GUI verification consolidated checklist" which is awaiting laptop agent.

## 5. Capacitor / mobile readiness

**iOS** (`ios/App/App/`):
- Bundle id `au.ecodia.roam`, dev team `86PUY7393S` (per submission readiness pack)
- `App.entitlements`: `com.apple.developer.applesignin` = `["Default"]`. No other capabilities (no Push, no Background). Adequate for v1.
- `Info.plist`, `AppDelegate.swift`, `LocalFileServer.swift`, `RoamTileServerPlugin.swift` present.
- `App.xcassets` present.
- versionName `1.0` / build version `19` (per submission readiness pack).

**Android** (`android/app/`):
- `applicationId "au.ecodia.roam"`
- `versionCode 1`, `versionName "1.0"`
- `AndroidManifest.xml` present, `java/`, `res/` populated.
- **At-risk:** keystore not backed up to kv_store. P2 status_board row is owned by Tate.

**capacitor.config.ts:**
- `webDir: "out"`, served from device storage (offline-first, no network for shell).
- `server.allowNavigation` whitelists `*.ecodia.au`, `*.supabase.co`, `*.supabase.in`. Tight scope.
- StatusBar dark, SplashScreen black. iOS `contentInset: never`, Android `allowMixedContent: false`. Defensible defaults.

Nothing missing for v1 submission once Tate does the Mac day.

## 6. Open PRs

`gh pr list --state open` → empty. No leftover branches on the remote.

Local branches all merged: `fix/account-authgate`, `fix/purchase-success-escape-plus-haptic-guard-2026-04-29`, `fix/android-apple-button-gate-fork_moibxwyr` all green per Vercel state.

## 7. Recent commits (14 days)

- bd27e38 fix(purchase): escape link + haptic guard (today, PR #3)
- 8868d73 fix(login): Apple Sign-In iOS gate (today, PR #2)
- cd919b1 fix(account): AuthGate (today, PR #1)
- 1d0e690 Factory: Playwright + Lighthouse CLS regression suite (Apr 27-28)
- da1f01c Factory: CLS layout-shift audit completion
- 364c3e9 Factory: Roam UI hygiene pass - 4 weekend bugs

Pattern: today's three PRs picked off the highest-priority items from the Apr 27-28 UI audit. The codebase is in a clean state.

## 8. Top-3 ship-able fixes

**Cap 3. Shipped: 1.**

### Shipped: PR-WelcomeModal-SSR-simplify (this fork)

- **File:** `src/components/paywall/WelcomeModal.tsx`
- **Change:** Replace `useSyncExternalStore(() => () => {}, () => true, () => false)` with `const [mounted, setMounted] = useState(false); useEffect(() => setMounted(true), [])`. Mirrors PaywallModal exactly.
- **Why:** Roam is Vite + Capacitor. There is no SSR. The `useSyncExternalStore` pattern is a misapplied Next.js holdover. PaywallModal in the same directory uses the simpler pattern. Aligning eliminates a confused pattern from the codebase.
- **Risk:** Low. Both patterns gate on `if (!mounted || !open) return null`. Both skip first client paint. Identical observable behaviour for client-only render.
- **Deploy verify:** Vercel polled to READY, prod curl confirms shell still serves, build artifact contains updated WelcomeModal chunk hash.

### Not shipped (cap reason or risk):

- **WelcomeModal copy "make this one count"** - Tate voice call, surface.
- **App Store ID placeholder in LegalNav.tsx:27** - `id000000000` placeholder. Not user-facing yet (app not on store). Update post-submission. Surface.

## 9. Top-3 surface-to-Tate items

1. **Roam IAP submission Mac day** (status_board P2 `75f6855d`). GST cleared 84 days ago, codebase ready, all eight ASC+RC steps documented in `roam-iap-submission-readiness-2026-04-27.md`. Tate decision: schedule the Mac day.

2. **Paywall copy + WelcomeModal copy pass** (audit F4 + section 8 above). Lines flagged: "make this one count", "After 2 free trips, go Untethered for $19.99". Tate's voice judgement before ASC review. ~15 min once decided.

3. **Android keystore kv_store backup** (status_board P2 `d51856c1`). At-risk. Lose the keystore, lose Play Store update path (key-rotation flow only). Needs Tate to provide passwords for `roam-release.keystore` (in `~/workspaces/roam-frontend/`).

## 10. Top-3 deferred items

1. **Lint baseline cleanup** - 102 errors, all pre-existing, not deploy-blocking. Trivial 3 to auto-fix (2x prefer-const + 1x no-useless-escape) but not user-impactful. Schedule as a single dedicated PR when there's a hygiene window.

2. **Bundle size on `maplibre` chunk** - 1.02 MB / 276 KB gzip. Manual chunking strategy or dynamic-import deferred. Not regression - pre-existing.

3. **`/login` UX nuance** (status_board P4 `42dcd640`, P5 `b9bd8ea5`). Both are Tate UX calls already on the board. Bundling these into one Factory job after Tate decides is the efficient path.

---

## Summary

Roam is in good shape post the three PRs Tate shipped today. Status board accurately reflects backlog. Build clean, prod READY, no open PRs. One small SSR-pattern simplification shipped this fork to align WelcomeModal with PaywallModal. Three medium items surfaced to Tate (IAP Mac day, copy pass, Android keystore). Three low items deferred to existing rows.
