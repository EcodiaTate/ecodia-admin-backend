# Secrets Registry Index

This directory holds one `.md` file per credential (or per coherent credential group) currently in `kv_store`, plus placeholder files for credentials that are referenced by code/docs but NOT yet provisioned.

**Mirrors the convention of `~/ecodiaos/patterns/`.** Each file has a `triggers:` frontmatter line. The grep-before-action protocol applies here exactly as for patterns.

**Hard rule.** This directory contains metadata about credentials, NEVER values. If a sample is needed, redact (e.g. `ATATT...XYZ12`).

## Surfacing protocol

Before any credential-needing action (release, deploy, signing, vendor-API call, smoke test login):

```
Grep "triggers:" ~/ecodiaos/docs/secrets/ -A 1
```

Read the triggers, pick the files matching your workflow keywords, read those files in full, then proceed. The cost is 30 seconds; the cost of NOT doing it is acting on stale doc references or missing creds.

**High-leverage trigger keywords** (always grep before):
- iOS / TestFlight / App Store Connect
- Android / Play Console / keystore
- Bitbucket / git push to fireauditors1 / Ordit
- Edge Function deploy / Supabase Management
- Co-Exist excel-sync / Microsoft Graph
- Corazon / Mac SSH / SY094 / MacInCloud

## Provisioned credentials

| File | Triggers | Class | Owner |
|---|---|---|---|
| [apple.md](apple.md) | apple, ios, app store connect, asc, team_id, xcodebuild, transporter, DEVELOPMENT_TEAM | gui-macro-replaces | ecodiaos |
| [apple-asc-keys.md](apple-asc-keys.md) | apple, asc, asc-keys, asc-api-key, issuer_id, ios-upload, altool, fastlane | gui-macro-replaces | ecodiaos |
| [asc-api-fallback.md](asc-api-fallback.md) | asc, asc-api-key, p8, altool, fastlane, ios-upload-fallback, programmatic-apple, key_id, issuer_id | programmatic-required | ecodiaos |
| [apple-2fa-code.md](apple-2fa-code.md) | apple-2fa, transient, stale-cred, cleanup-target | programmatic-required | ecodiaos |
| [macincloud.md](macincloud.md) | macincloud, sy094, mac, ssh, sshpass, ios-build, xcode, mac-host, remote-mac | programmatic-required | tate |
| [bitbucket.md](bitbucket.md) | bitbucket, atlassian, ordit, fireauditors1, git push, git remote, ATATT, api-token | programmatic-required | tate |
| [supabase-access-token.md](supabase-access-token.md) | supabase, supabase-access-token, edge-function-deploy, sbp_, supabase-management, supabase-cli | programmatic-required | tate |
| [laptop-agent.md](laptop-agent.md) | laptop, laptop-agent, corazon, tailscale, agent_token, eos-laptop-agent, browser.*, screenshot.*, input.* | programmatic-required | ecodiaos |
| [laptop-passkey.md](laptop-passkey.md) | laptop, corazon, passkey, windows-hello, 2fa-passkey, 5-point-check, exhaust-laptop-route | gui-macro-replaces | tate |
| [coexist-graph-api.md](coexist-graph-api.md) | coexist, microsoft-graph, graph-api, entra, azure-ad, client_secret, tenant_id, excel-sync | programmatic-required | ecodiaos |
| [coexist-m365.md](coexist-m365.md) | coexist, m365, microsoft365, charliebennett, coexistaus.org, outlook, m365-login | gui-macro-replaces | tate |
| [coexist-excel-file.md](coexist-excel-file.md) | coexist, excel, excel-sync, sharepoint-file, drive_id, item_id, sheet_name, registration-spreadsheet | programmatic-required | ecodiaos |
| [coexist-supabase.md](coexist-supabase.md) | coexist, supabase-coexist, coexist-db, anon-key-coexist, service-role-coexist, db_password-coexist | programmatic-required | ecodiaos |
| [chambers-supabase.md](chambers-supabase.md) | chambers, chambers-supabase, federation, multi-tenant-chambers, anon-key-chambers, service-role-chambers | programmatic-required | ecodiaos |
| [resend.md](resend.md) | resend, transactional-email, smtp, email-api, re_, dkim, coexist-resend | programmatic-required | ecodiaos |
| [canva-connect-api.md](canva-connect-api.md) | canva, canva-connect, design-automation, oauth-canva, client_id-canva, canva-api | programmatic-required | ecodiaos |
| [canva-mfa-backup-codes.md](canva-mfa-backup-codes.md) | canva, canva-2fa, mfa-backup-codes, canva-login, backup-codes, recovery-codes | gui-macro-replaces | tate |
| [xero-code-login.md](xero-code-login.md) | xero, bookkeeping, xero-login, xero-gui, xero-dashboard, ecodia-xero | gui-macro-replaces | ecodiaos |
| [coexist-app-test.md](coexist-app-test.md) | coexist, coexist-app, coexist-test, smoke-test, visual-verify, puppeteer-coexist | gui-macro-replaces | ecodiaos |
| [conventions.md](conventions.md) | creds-conventions, kv_store-conventions, secrets-conventions, naming-conventions-creds, misclassified | programmatic-required | ecodiaos |

## Pending (referenced by code/docs, NOT in kv_store yet)

| File | Triggers | Status |
|---|---|---|
| [_pending-android-keystores.md](_pending-android-keystores.md) | android, keystore, jks, play console, fastlane, coexist-android, roam-android, .jks, keystore_b64 | NEEDS-TATE - back up keystores from 1Password |
| [_pending-google-play-service-account.md](_pending-google-play-service-account.md) | google-play, play console, service-account, fastlane, supply, programmatic-android-upload | DEMOTED to fallback - macro path is primary; provision only if true headless cron required |
| [_pending-revenuecat.md](_pending-revenuecat.md) | revenuecat, iap, in-app-purchase, roam-iap, subscriptions, paywall, revenuecat_ios_public_key | NEEDS-TATE - Roam IAP submission blocker |

## Documentation Hierarchy

How this fits with the rest of the EcodiaOS knowledge surface:

| Layer | Path | Holds |
|---|---|---|
| Global identity / business | `~/CLAUDE.md` | Identity, decision-authority, voice rules |
| Technical operations | `~/ecodiaos/CLAUDE.md` | MCP tools, infra, scheduling, status_board mechanics. The high-level "Credentials" table cross-refs to this INDEX. |
| Doctrine (grep-addressable) | `~/ecodiaos/patterns/*.md` | One rule per file. Triggers frontmatter. |
| Per-system / per-client reference | `~/ecodiaos/clients/*.md` | Per-client / per-system docs |
| Registries (NEW) | `~/ecodiaos/docs/secrets/*.md` (this dir) | Structured references that are NOT doctrine. One file per cred. |
| Drafts | `~/ecodiaos/drafts/*.md` | In-flight drafts |
| Operational scripts | `~/ecodiaos/scripts/*.{sh,js}` | Executable runbooks |
| Pattern index | `~/ecodiaos/patterns/INDEX.md` | Doctrine index |
| Secrets index | `~/ecodiaos/docs/secrets/INDEX.md` (this file) | Credentials index |

## Drift summary (full detail in individual files)

**Stale doc references (point to creds that don't exist in kv_store):**
- `creds.asc_api_key_p8` - referenced by `scripts/release.sh`, `clients/app-release-flow-ios.md`, `patterns/ios-signing-credential-paths.md`, `clients/release-candidate-analysis-2026-04-29.md`. Demoted to fallback under GUI-macro doctrine.
- `creds.android.{slug}` - referenced everywhere but no actual rows. NEEDS-TATE.
- `creds.google_play_service_account_json` - DEMOTED to fallback.
- `creds.revenuecat_ios_public_key` - NEEDS-TATE.
- `creds.coexist_test` referenced in `clients/coexist.md:133` - actual row is `creds.coexist`. SAFE-TO-FIX (corrected this fork).
- `creds.apple.asc_api` referenced in `src/services/appStoreConnect.js` as a single object holding `{issuer_id, key_id, private_key}` - the storage shape is different (split scalars + .p8 not provisioned). Runtime would error if invoked. NEEDS-FOLLOW-UP-FORK.

**Stale pattern reference:**
- `~/ecodiaos/CLAUDE.md` and `~/CLAUDE.md` cite `~/ecodiaos/patterns/exhaust-laptop-route-before-declaring-tate-blocked.md` - file does NOT exist. NEEDS-FOLLOW-UP-FORK to author the pattern (its content lives in `~/CLAUDE.md` directly today).

**Naming-convention drift:**
- `creds.canva.*` (dotted) vs `creds.coexist_*` (underscored) vs `creds.android.{slug}` (would-be dotted). Inconsistent. Recommended: standardise on dotted (`creds.coexist.supabase` not `creds.coexist_supabase`). NEEDS-FOLLOW-UP-FORK.

**Misclassified:**
- `creds.conventions` - documentation, not credentials. Should be migrated out of the `creds.*` namespace. NEEDS-FOLLOW-UP-FORK.

**Transient artefact:**
- `creds.apple_2fa_code` - 6-digit code that expired ~30 seconds after capture. Cleanup recommended.

## Migration policy

No migration in any individual fork. Renaming kv_store keys requires lockstep updates across `scripts/`, `src/`, `mcp-servers/`, `patterns/`, `clients/`, `drafts/` - any one of which uses exact-match string lookups. A migration fork must:

1. Inventory every reference in those paths.
2. Author lockstep updates (kv_store + all references in one commit).
3. Have Tate review.
4. Apply.

Until that fork runs, this INDEX is the source of truth for "what creds exist and what they mean." Naming inconsistencies are catalogued but not modified.

## Authoring new entries

When a new credential is added to `kv_store`:

1. Author a new file `<canonical-slug>.md` in this directory.
2. Frontmatter: `triggers:` (comma-separated grep keywords), `class:` (gui-macro-replaces / programmatic-required), `owner:` (ecodiaos / tate / external).
3. Per-file schema: title (`# creds.<canonical_path>`), one-paragraph description, Source, Shape, Used by, Replaceable by macro?, Rotation, Restoration if lost, Failure mode if missing.
4. Add a row to the table above.
5. Update `~/ecodiaos/CLAUDE.md` "Credentials" if the new cred is high-leverage enough to belong in the 5-row top-level table.

When a credential is RETIRED:
1. UPDATE the file's frontmatter to mark deprecation.
2. Note the retirement date and replacement path in the file.
3. Move the row in this INDEX to a "Retired" section (do not delete - the file remains as the historical record).

## Origin

Authored 29 Apr 2026 by fork_mojm7scs_fcd13a in response to Tate's directive: "this could also be an opportunity for you to lay the foundations for a more organised documentation structure especially with our secrets."

Restructured at 15:31 AEST per Tate's course-correction: "Just make sure it isn't a big blob of text. Make sure your surfacing it at the right time when the agents will need it and when you will need it." A single registry blob was rejected; the patterns/-style one-file-per-cred convention adopted instead.
