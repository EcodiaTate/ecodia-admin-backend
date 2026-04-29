---
triggers: asc, asc-api-key, asc-api-issuer, asc-api-key-id, p8, altool, fastlane, ios-upload-fallback, programmatic-apple, app store connect, key_id, issuer_id, xcrun, --apiKey, --apiIssuer
class: programmatic-required
owner: ecodiaos
---

# creds.asc_api_issuer_id + creds.asc_api_key_id (+ creds.asc_api_key_p8, pending)

Three scalars used together when the iOS upload runs through the fallback API-key path (`xcrun altool --apiKey <id> --apiIssuer <uuid> --authenticationKeyPath <p8>` or fastlane equivalent). The PRIMARY iOS upload path is the GUI-macro path on SY094 / Corazon - this fallback only fires when the Mac GUI is unavailable.

| Key | Shape | Currently in kv_store? |
|---|---|---|
| `creds.asc_api_key_id` | scalar string, 10 chars | YES (since 2026-04-29) |
| `creds.asc_api_issuer_id` | scalar string, UUID 36 chars | YES (since 2026-04-29) |
| `creds.asc_api_key_p8` | scalar string, full .p8 file contents (BEGIN/END lines included) | **NO - not provisioned** |

The .p8 is intentionally absent because the GUI-macro doctrine demoted this path to fallback-only.

## Source

appstoreconnect.apple.com > Users and Access > Integrations > Keys.

- `key_id`: the 10-char string in the Key ID column.
- `issuer_id`: the UUID at the top of the page (one per account, never changes).
- `p8`: downloadable ONCE when the key is generated. Lost = the only recovery is REVOKE + REGENERATE.

## Shape

three scalar strings (NOT a single object).

## Used by

- `~/ecodiaos/scripts/release.sh` ASC fallback branch (`scripts/release.sh:300-307, 550-552`)
- `~/ecodiaos/src/services/appStoreConnect.js` (reads from a phantom `creds.apple.asc_api` path that does NOT exist - drift; see `INDEX.md` Drift section)
- `~/ecodiaos/clients/app-release-flow-ios.md` (path 1 in the credential ranking)
- `~/ecodiaos/patterns/ios-signing-credential-paths.md` (path 1 of three)

## Replaceable by macro?

Yes for the WORKFLOW (iOS upload). The macro path (`mcp__macros__macro_run({name: 'xcode-organizer-upload'})` or `transporter-upload`) is the documented primary; this triple of scalars is consulted only on the fallback branch.

If you find yourself reaching for these scalars: first check whether the macro path is live. See `~/ecodiaos/patterns/gui-macro-uses-logged-in-session-not-generated-api-key.md`.

## Rotation

- `key_id`: per-vendor-policy. Apple permits revoke and regenerate on demand.
- `issuer_id`: never (one per Apple account for life).
- `p8`: revoked when the key is revoked; if lost mid-life of an active key, only path is revoke + regenerate.

## Restoration if lost

- `key_id`, `issuer_id`: re-read from the ASC Keys page; UPSERT scalars.
- `p8`: cannot be re-downloaded. Revoke the key on appstoreconnect.apple.com, generate a new key, save the .p8 immediately to `creds.asc_api_key_p8` (only if the fallback path is being kept live).

## Drift

- `creds.asc_api_key_p8` is referenced by the release driver and pattern files but does not exist in kv_store. Either populate it or formally demote the fallback path.
- `~/ecodiaos/src/services/appStoreConnect.js` reads `creds.apple.asc_api` as a single object holding `{issuer_id, key_id, private_key}`. That key path is NOT the actual storage shape - the runtime would error if invoked. Needs follow-up fork to align (see `INDEX.md` Drift).
