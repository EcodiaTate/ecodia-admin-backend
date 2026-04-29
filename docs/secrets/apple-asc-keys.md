---
triggers: apple, asc, app store connect, asc-keys, asc-api-key, issuer_id, ios-upload, ios-release, ipa, programmatic-apple, altool, fastlane
class: gui-macro-replaces
owner: ecodiaos
---

# creds.apple_asc_keys

Catalogue of which ASC API keys exist on the Apple Developer account. Holds `issuer_id` (one per account, never rotates) and a `team_keys[]` listing of generated keys with their key_ids. The .p8 PRIVATE keys are intentionally NOT here - the GUI-macro upload doctrine supersedes the API-key path for iOS upload, so we don't maintain the .p8 secrets at all unless the fallback path is invoked.

## Source

appstoreconnect.apple.com > Users and Access > Integrations > Keys. Scraped via Corazon Chrome macro 29 Apr 2026.

## Shape

object `{issuer_id, team_keys[], note, fetched_at, fetched_by_fork, fetched_via, screenshot}`

## Used by

- Reference only. Release driver does NOT consume this; the per-key scalars (`creds.asc_api_key_id`, `creds.asc_api_issuer_id`) are what the API-key fallback path reads.
- `~/ecodiaos/clients/app-release-flow-ios.md` cross-ref.

## Replaceable by macro?

Yes - the row IS the macro output. Re-run the ASC keys macro to refresh.

## Rotation

Per-vendor-policy. Apple does not auto-rotate ASC API keys; they live until revoked.

## Restoration if lost

1. Corazon Chrome > appstoreconnect.apple.com > Users and Access > Integrations > Keys
2. Screenshot the page; UPSERT `creds.apple_asc_keys` with fresh fields

The .p8 file from any individual key cannot be re-downloaded - only the `key_id` and `issuer_id` are visible after the one-time download window. If a fallback API-key upload is needed and the .p8 is gone, REVOKE the key on the same page and generate a new one (then capture the .p8 to `creds.asc_api_key_p8` if the fallback path is being kept live).
