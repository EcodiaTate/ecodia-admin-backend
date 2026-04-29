---
triggers: revenuecat, iap, in-app-purchase, roam-iap, subscriptions, paywall, ios-iap, android-iap, revenuecat-key, revenuecat_ios_public_key
class: programmatic-required
owner: tate
---

# creds.revenuecat_ios_public_key - PENDING

**Status: PENDING.** Required for Roam's in-app purchase / subscriptions integration. Referenced in `~/ecodiaos/drafts/roam-iap-submission-readiness-2026-04-27.md` as a submission-readiness blocker.

## What it is

RevenueCat iOS public API key. Public-side identifier (NOT a secret in the sense of the secret API key) that the iOS client embeds and uses to identify itself to RevenueCat's SDK. Read-only from the client's perspective.

## Source

app.revenuecat.com > Project > Apps > {iOS app} > API keys.

## Shape (would-be)

scalar string.

## Used by (will be, once provisioned)

- `NativeBootstrap.tsx` in the Roam app (per `drafts/roam-iap-submission-readiness-2026-04-27.md:84`):
  ```
  initRevenueCat(apiKey)
  ```
  The bootstrap currently reads from env or a config; if not, that's a small pre-submission task.

## Replaceable by macro?

No - this is a client-embedded identifier, not a workflow credential. The iOS app NEEDS this baked into the build.

## Rotation

RevenueCat keys can be rotated from the dashboard; rebound only on incident.

## Provisioning steps

1. Tate logs into app.revenuecat.com.
2. Project > Apps > Roam (iOS) > API keys > Public.
3. Copy public key value.
4. UPSERT `creds.revenuecat_ios_public_key` (or, more idiomatic, embed directly into the Roam build config / env file).

## Note on storage location

A scalar API key that's CLIENT-EMBEDDED (i.e. ships in the iOS binary and is therefore not actually secret) might not belong in `kv_store.creds.*` at all - it's effectively config, not credentials. Possible alternatives:

1. Roam build config (env file or constants module).
2. `kv_store.config.revenuecat.ios_public_key`.

NEEDS-TATE call when provisioning.

## Failure mode while pending

Roam IAP integration cannot initialise. Revenue features blocked. App Store review may flag missing IAP if the build advertises subscriptions but doesn't actually wire them.
