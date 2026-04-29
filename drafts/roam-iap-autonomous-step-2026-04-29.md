# Roam IAP - autonomous-step follow-up brief (queued, NOT dispatched)

**Date:** 2026-04-29
**Authoring fork:** fork_mojscxdr_cb48a3 (recon-only)
**Trigger to dispatch:** Tate green-lights option (a) - Corazon-Chrome-driven ASC config
**Sibling docs:** drafts/roam-iap-submission-readiness-2026-04-27.md (full step list), clients/roam-audit-2026-04-29.md (current state)
**Status board row:** 75f6855d-7a96-44cd-bbfc-77a15afef386

This is the brief for a single follow-up fork that would advance Roam IAP submission as far as autonomously achievable via Corazon. Not for execution by this fork.

## Pre-dispatch verification (next fork must do FIRST)

1. Probe Corazon health: `curl http://100.114.219.69:7456/api/health` - if fail, escalate to Tate (laptop off).
2. Probe Chrome profile holds ASC login: full-screen `screenshot.screenshot` after `input.shortcut [super]` -> click Chrome taskbar icon -> `input.shortcut [ctrl, l]` -> type `appstoreconnect.apple.com/apps` -> `input.key Enter` -> wait 4s -> screenshot. If logged-out screen visible, escalate (need Profile-1 or fresh login).
3. Probe Chrome profile holds RevenueCat login: same pattern with `app.revenuecat.com`.
4. If ASC login fires Apple 2FA SMS to Tate's phone -> escalate immediately, do NOT proceed.

## Autonomously-achievable steps (if pre-dispatch passes)

In ascending difficulty:

### Step A - ASC App Privacy declaration (15 min)
- Path: My Apps -> Roam -> App Privacy -> Get Started / Edit
- Declare per readiness doc step 2 last bullet: Account info (Sign in with Apple), Location (geolocation plugin), Purchases (IAP), Identifiers (RevenueCat app_user_id mapped to Supabase user UUID).
- Click-by-click via input.* tools. Screenshot after each save.

### Step B - ASC IAP product creation (15 min)
- Path: My Apps -> Roam -> In-App Purchases -> + (Create)
- Type: Non-Consumable
- Product ID: `roam_unlimited` (must match RC_PRODUCT_ID exactly - verify against tripGate.ts before typing)
- Reference name: "Roam Untethered"
- Display name + description: SURFACE TO TATE first (voice call per readiness doc step 3)
- Price tier: SURFACE TO TATE first (voice call per readiness doc step 3) - default to $9.99 AUD anchor
- Localizations: English (US) minimum

### Step C - ASC App listing entry (description, keywords, subtitle) (30 min)
- Path: My Apps -> Roam -> App Information / Pricing and Availability / Build
- Subtitle: SURFACE TO TATE first (Tate voice call)
- Category: Travel (primary), Lifestyle (secondary)
- Privacy URL: https://roam.ecodia.au/legal/privacy
- Support URL: https://roam.ecodia.au/legal/contact
- Marketing URL: https://roam.ecodia.au
- Age rating: 4+
- App description / keywords / what's new: SURFACE TO TATE first (Tate voice call)

### Step D - ASC Tax forms (10 min)
- Path: Agreements, Tax, and Banking -> Tax forms
- Australia AU/W-8BEN-E equivalent. ABN 89 693 123 278 (Ecodia Pty Ltd, GST registered 3 Feb 2026 - both verifiable via ABR public lookup).
- Watch for SMS 2FA - escalate immediately if it fires.

### Step E - RevenueCat dashboard config (20 min)
- URL: app.revenuecat.com
- Verify project + iOS app `au.ecodia.roam` exist (if TestFlight build 24 went through with RC SDK already wired, this is likely set up - probe first)
- ASC API key paste (generated via ASC Users and Access -> Keys -> + (this part requires ASC GUI, do as part of step D-E sequence))
- Product `roam_unlimited` synced from ASC
- Entitlement `roam_unlimited` mapped to `roam_unlimited` product
- Webhook URL: https://api.roam.ecodia.au/stripe/webhook
- Webhook Bearer secret: generate, save to kv_store at `creds.revenuecat_webhook_secret`, paste into RC
- Public iOS key: copy from RC, save to `kv_store.creds.revenuecat_ios_public_key`

### Step F - Production env vars on roam-backend (5 min)
- This is NOT GUI-driven - SSH into roam-backend host (Cloud Run per Neo4j: roam-backend Cloud Run service min-instances=1) and verify env block has STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET, STRIPE_PRICE_ID, REVENUECAT_WEBHOOK_SECRET, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY.
- If REVENUECAT_WEBHOOK_SECRET is missing, paste the value from kv_store and redeploy.

## NOT autonomously achievable (genuine 5-point check fails)

- ASC banking setup - Apple SMS 2FA to Tate's phone, Tate not at laptop (step 3 fail)
- Screenshots (readiness doc step 6) - SY094 agent down (step 1-2 fail). Could re-attempt if SY094 agent comes back online; meanwhile genuinely Tate-physical (Tate at his actual Mac with Xcode + simulator).
- TestFlight build upload - Xcode build + archive on Mac (genuinely Tate-physical or via SY094-when-up).
- Final "Submit for Review" press - actually IS web-form-clickable, but should be Tate's call after he reviews everything one last time.

## Dispatch envelope (when Tate green-lights)

Brief skeleton:
- Pre-dispatch verify (above) - bail-fast if any fail
- Steps A through F in order, screenshot after each save, surface ALL Tate-voice-call items in advance and proceed only with confirmed copy
- Surface SMS 2FA immediately to Tate via /sms-tate skill
- Update status_board row 75f6855d after each step lands; flip next_action_by to 'tate' for the final 4 (banking, screenshots, build upload, final submit) once A-F shipped
- Final report: which of A-F shipped, which surfaced for Tate copy/decision, what's left

## Pattern tags (for the dispatch fork to apply)

- [APPLIED] patterns/exhaust-laptop-route-before-declaring-tate-blocked.md - 5-point check applied step-by-step
- [APPLIED] patterns/corazon-is-a-peer-not-a-browser-via-http.md - shell.shell + filesystem.* + screenshot.* peer paradigm
- [APPLIED] patterns/drive-chrome-via-input-tools-not-browser-tools.md - input.* + screenshot, NOT browser.*
- [APPLIED] docs/secrets/laptop-agent.md - Corazon agent token
- [APPLIED] docs/secrets/laptop-passkey.md - 6969 for any Windows-unlock prompt
- [APPLIED] patterns/no-symbolic-logging-act-or-screenshot.md (or equivalent) - screenshot after each save = artefact-of-action
- [APPLIED] patterns/gui-macro-uses-logged-in-session-not-generated-api-key.md - default to logged-in Chrome over generating ASC API keys
- [APPLIED] patterns/no-client-contact-without-tate-goahead.md - this is internal config, not client contact, no email triggered

## Why this brief was authored but NOT dispatched

The recon fork's mandate was probe + score + update + draft. Actual ASC config work is high-leverage and needs Tate's explicit per-task green-light (per Tate's repeated "ask first before sending anything outbound" doctrine - and ASC config plus webhook publishing has the same character). This brief sits in drafts/ until Tate texts "green-light Corazon Roam IAP push" or equivalent. Then the conductor dispatches a single fork against this file.
