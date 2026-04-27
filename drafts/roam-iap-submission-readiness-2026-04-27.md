# Roam IAP - App Store submission readiness pack

**Date:** 2026-04-27 21:08 AEST
**Sibling doc:** `roam-iap-audit-2026-04-27.md` (UI audit only; this doc covers everything else)
**Status board row:** `Roam IAP Fix` (parked, owner: tate)
**Trigger to unpark:** GST registration confirmed via ABR + Apple Paid Apps Agreement signed.

This doc is the submission checklist. It assumes the morning the GST application clears, you (Tate) want a single page that says "do these N things in this order and IAP is live in 24-48 hours." That is what this doc is.

## TL;DR

Code is shipped. Backend webhook works. Database schema is in place. Frontend purchase + restore flow is built. The remaining work is **all configuration in three GUIs (App Store Connect, RevenueCat, production env)**, plus screenshots and a privacy-policy URL audit.

GST is the only true external blocker. Everything else can be staged and ready-to-fire.

## What is shipped (verified on disk 2026-04-27)

- [x] **Frontend** `src/lib/paywall/tripGate.ts` - `purchaseUnlimited`, `restorePurchases`, `isUnlocked`, `syncUnlockFromRC`, `initRevenueCat`. RC product id `roam_unlimited`, entitlement id `roam_unlimited`. Lazy-loaded `@revenuecat/purchases-capacitor` to keep ~120KB out of the initial bundle. Both web (Stripe Checkout redirect) and native (RevenueCat) paths wired.
- [x] **Backend** `app/api/stripe.py` - `/stripe/checkout` (creates checkout session), `/stripe/confirm` (webhook-slow fallback), `/stripe/webhook` (unified handler that routes by header presence: `stripe-signature` -> Stripe path, no header -> RevenueCat path), `/stripe/grant-manual` (test-mode only). Stripe signature verification is enforced. RevenueCat path enforces a Bearer secret (`REVENUECAT_WEBHOOK_SECRET`) and rejects non-UUID `app_user_id` values to prevent garbage upserts.
- [x] **Database** `supabase/migrations/001_entitlements.sql` - `user_entitlements` (unique on `user_id, source`, RLS read-own only, server-only writes via service role) + `user_trip_counts` (server-side counter via `increment_trip_count` security-definer function so users cannot self-increment).
- [x] **iOS bundle config** `au.ecodia.roam`, dev team `86PUY7393S`, marketing version `1.0`, build version `19`, Apple Sign-In entitlement present.
- [x] **Legal pages** `/legal/privacy`, `/legal/terms`, `/legal/contact`, `/legal/attributions` all exist as Next-style route groups in the frontend.
- [x] **Anti-cheat** Server-authoritative trip count + entitlement. localStorage is offline cache only. `mergeLocalTripsToServer` pushes pre-auth trips on sign-in so users can not cheat by clearing storage.

## External blocker - GST registration: NOT BLOCKED (verified 2026-04-27 21:11 AEST)

**Verified via ABR public lookup at https://abr.business.gov.au/ABN/View?id=89693123278:**
- Entity: ECODIA PTY LTD
- Entity status: Active from 23 Nov 2025
- **GST: Registered from 3 Feb 2026** (84 days ago as of today)

The status_board row "GST Registration / Application submitted to ATO. Awaiting response." (last touched 2026-04-23) was stale. The kv_store memory file `project_roam_iap.md` (last touched Apr 8) was stale. CLAUDE.md was correct: Ecodia Pty Ltd is GST registered. The IAP blocker has been gone for almost three months and nobody noticed.

**Implication:** Roam IAP can ship now. Apple Paid Apps Agreement can be signed today. There is no external dependency. The remaining work is configuration (steps 1-8 below) and Tate's GUI time.

## What needs Tate at the GUI when unparked

Listed in the order to do them. Each step has a cost estimate.

### 1. App Store Connect - tax + banking + paid agreements (15-30 min)

URL: https://appstoreconnect.apple.com -> Agreements, Tax, and Banking
- [ ] Sign Paid Apps Agreement (requires GST registration confirmed in step above)
- [ ] Add Tax forms - Australia AU/W-8BEN-E equivalent (ABN required)
- [ ] Add bank account for payouts (USD account preferred for FX; AUD account works but Apple does the FX conversion)
- [ ] Verify Apple Developer Program membership is current (annual $149 per CLAUDE.md cost structure)

### 2. App Store Connect - app listing entry (30-60 min)

URL: https://appstoreconnect.apple.com -> My Apps -> Roam (create if not exists)
- [ ] Bundle ID matches `au.ecodia.roam` (iOS dev team `86PUY7393S`)
- [ ] App name: "Roam" (must be available; verify no collision)
- [ ] Subtitle: short positioning line (Tate copy call - same uncomfortable-truth voice as Quorum of One; the audit doc flagged the customer-facing copy pass as "Tate's voice judgement")
- [ ] Category: Travel (primary), Lifestyle (secondary)
- [ ] Privacy policy URL: https://roam.ecodia.au/legal/privacy (route exists; verify it renders on the production deploy before submitting)
- [ ] Support URL: https://roam.ecodia.au/legal/contact
- [ ] Marketing URL: https://roam.ecodia.au (or homepage equivalent)
- [ ] Age rating: 4+ (no objectionable content; verify if mapping or location features change this)
- [ ] App Store description, keywords, what's new (Tate copy call)
- [ ] App Privacy section - DECLARE: Account info (Sign in with Apple), Location (geolocation plugin present), Purchases (IAP), Identifiers (RevenueCat app_user_id mapped to Supabase user UUID). Do not under-declare; Apple rejects on this.

### 3. App Store Connect - in-app purchase product (15 min)

Same dashboard -> Roam -> In-App Purchases -> + (Create)
- [ ] Type: **Non-Consumable** (one-time unlock, not subscription, not consumable). The frontend treats `roam_unlimited` as binary entitled / not-entitled.
- [ ] Product ID: `roam_unlimited` (must match `RC_PRODUCT_ID` in `tripGate.ts` exactly)
- [ ] Reference name: "Roam Untethered"
- [ ] Display name (for users): "Unlock Unlimited Trips" (Tate copy call)
- [ ] Description: "One-time purchase for unlimited trip planning." (Tate copy call)
- [ ] Price tier: Tate decides - check the in-progress paywall copy ("make it count"); price tier defines the regional prices Apple charges (e.g. tier $4.99 USD = ~$7.99 AUD). Recommend $9.99 AUD as round-number anchor; verify against the existing Stripe `STRIPE_PRICE_ID` value so web price and native price match.
- [ ] Review screenshot (1024x1024 PNG of the paywall modal)
- [ ] Review notes - explain how the reviewer triggers the paywall (`?paywall=1` URL param works in dev; for review, log them in and create 2 trips to hit the gate organically; document either path in review notes)
- [ ] Localizations - English (US) minimum; English (AU) optional

### 4. RevenueCat dashboard (20-30 min)

URL: https://app.revenuecat.com
- [ ] Project exists and matches Roam app
- [ ] iOS app added with bundle id `au.ecodia.roam`
- [ ] Apple App Store Connect API key configured (App Store Connect -> Users and Access -> Keys -> generate; paste into RC)
- [ ] Product `roam_unlimited` synced from App Store Connect
- [ ] Entitlement `roam_unlimited` created and `roam_unlimited` product mapped to it (matches `RC_ENTITLEMENT_ID` in `tripGate.ts`)
- [ ] Webhook configured: URL `https://api.roam.ecodia.au/stripe/webhook` (the unified handler routes by header). Add Authorization header `Bearer <REVENUECAT_WEBHOOK_SECRET>` so the backend can validate.
- [ ] Public API key (iOS) generated -> store at `kv_store.creds.revenuecat_ios_public_key` -> wire into `initRevenueCat(apiKey)` in `NativeBootstrap.tsx` (verify the bootstrap currently reads from env or a config; if not, that is a small Factory task before submission)

### 5. Production env vars on roam-backend (5 min)

Verify these are set on the prod FastAPI deploy (env source depends on whether roam-backend runs on VPS or Vercel; check current deployment):
- [ ] `STRIPE_SECRET_KEY` (live `sk_live_...`)
- [ ] `STRIPE_WEBHOOK_SECRET` (from Stripe dashboard webhook config)
- [ ] `STRIPE_PRICE_ID` (must match price configured in Stripe for parity with IAP price)
- [ ] `REVENUECAT_WEBHOOK_SECRET` (matches the Bearer token configured in step 4)
- [ ] `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` (existing)

Quick check command (Tate at terminal): `ssh roam-backend-host && env | grep -E 'STRIPE|REVENUECAT'` or check Vercel/host env config UI.

### 6. Screenshots + assets (60-120 min)

App Store requires device-frame screenshots at specific sizes. The simplest path is to use Apple's automated tool (xcrun simctl) on the SY094 Mac.
- [ ] iPhone 6.7" screens (iPhone 15 Pro Max etc) - 1290 x 2796, minimum 3, recommended 5-8
- [ ] iPhone 6.5" screens - 1242 x 2688
- [ ] iPad screens (only if iPad supported per Info.plist) - 2048 x 2732
- [ ] App icon (already present in `Assets.xcassets/AppIcon.appiconset`) - verify 1024x1024 master is set
- [ ] Optional: 30s app preview video (high-effort, defer to v1.1)

Screenshot capture path on SY094:
1. `xcrun simctl boot "iPhone 15 Pro Max"` (or whatever simulator name)
2. Build the iOS app: `cd ~/workspaces/roam-frontend && npm run cap:build && npx cap run ios`
3. Once running, navigate to each key screen and `xcrun simctl io booted screenshot ~/Desktop/roam-screen-N.png`
4. Repeat for each screen size by switching simulator devices

Suggested screen sequence:
1. Onboarding / welcome
2. Trip list (empty or populated)
3. Map view of a planned trip
4. Trip detail
5. Paywall modal (drives the IAP narrative for review)
6. Unlocked unlimited state

### 7. TestFlight upload + internal review (30 min)

Once 1-6 are done:
- [ ] Build archive in Xcode (Product -> Archive) on SY094
- [ ] Upload to App Store Connect
- [ ] Add Tate as TestFlight tester
- [ ] Test the full IAP flow end-to-end on a real device (Apple sandbox account purchase) before submitting for review

### 8. Submit for App Store review (5 min + 24-48h Apple wait)

- [ ] Click "Submit for Review"
- [ ] Apple typical turnaround 24-48h
- [ ] Common rejection reasons to pre-empt: missing privacy declaration, paywall not visible enough, restore-purchase button missing (it is built; verify it is visible on the paywall modal), incorrect IAP type (Non-Consumable is correct here)

## Open Tate-decisions captured from sibling audit

(From `roam-iap-audit-2026-04-27.md`, quoted for one-stop reading.)

1. **WelcomeModal SSR-pattern simplification** - replace `useSyncExternalStore` with `useState/useEffect` to match `PaywallModal`. ~15 min Factory task. Recommend: green-light with one-line approval before resubmission so the codebase is internally consistent.
2. **Paywall copy pass** - read every CTA line. "make it count" is the only flagged line; Tate's voice call.
3. **ASC resubmission timing** - is the IAP UI cleanup gated on the billing fix, or independent? Currently parked together but they are decouplable.

## What I (EcodiaOS) can drive autonomously when GST is confirmed

Without Tate at the GUI:
- Verify GST status via WebSearch on ABR public lookup (no API key needed for HTML scrape)
- Update status_board row to unparked + sharpen next_action
- Dispatch the WelcomeModal Factory task (#2 from audit) if Tate green-lights it via SMS
- Generate the App Store description / keywords / subtitle drafts (Tate copy review needed before they go live)
- Generate App Privacy declaration drafts based on actual code (geolocation, IAP, Sign in with Apple, RC identifiers all confirmed in code)
- Pre-generate review notes covering paywall trigger flow

What I cannot drive without Tate or SY094 GUI:
- Anything in App Store Connect dashboard
- Anything in RevenueCat dashboard
- Screenshot capture (needs simulator access on Mac; SY094 agent has SSH but Xcode GUI required)
- Paid Apps Agreement / banking / tax forms

## Recommended action when Tate next reads this

1. Run the ABR lookup (2 min). If GST is registered, unpark the row.
2. Block 2-3 hours on a Mac day to do steps 1-7 above sequentially. They are mostly clicking through dashboards, not coding.
3. Submit for review same session.
4. SMS when submitted - I will schedule daily checks for review status until live or rejected.
