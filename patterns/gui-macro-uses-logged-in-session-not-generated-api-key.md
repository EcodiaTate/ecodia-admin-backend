---
triggers: api-key, asc-api-key, generated-credential, programmatic-creds, gui-macro, logged-in-session, headless-vs-gui, macro-replaces-api, credential-management, password-manager, oauth-flow, transporter, xcode-organizer, altool, fastlane, appstoreconnect, app-store-upload, programmatic-upload, key-rotation, key-revocation, secrets-surface, p8-file, service-account-json, manual-upload, auto-deploy, vercel-cli-token, vercel-gui, github-pat, gh-cli, stripe-secret-key, stripe-dashboard
---

# GUI macros replace API keys for autonomous releases - use logged-in sessions over generated programmatic credentials when both work

## Rule

**When a SaaS workflow can be driven through Tate's already-logged-in browser/desktop session via the macro layer (`input.*` + `screenshot.*` + `macro.run`), prefer that path over generating an API key, service-account JSON, or other programmatic credential. Skip the credential-generation step entirely. Only reach for programmatic credentials when the workflow is fundamentally headless and there will never be a human GUI session in the loop (server-to-server cron, third-party integration we operate, etc.).**

## Why

The default SaaS-vendor recommendation is "create an API key, store it securely, call the API." That works but adds a credential-management surface that costs forever:

- Generating, downloading, and securing the secret (1-time setup)
- Rotation cadence (recurring forever)
- Revocation if leaked (incident-driven)
- Renewal when it expires (recurring)
- Onboarding for new team members (recurring)
- Doctrine on storage location (kv_store keys, secret-manager paths, .env precedence)

For Ecodia specifically, we already have what the API key would replicate: Tate's logged-in GUI sessions for Apple Developer / App Store Connect, Vercel, GitHub, Stripe, Google (Play Console + GCP + Workspace), Microsoft (Teams + Office), Resend, Supabase, Cloudflare, Square, Bitbucket. Those sessions live in his Chrome Default profile on Corazon and in the relevant desktop apps on Corazon and SY094. They are already authenticated, already trusted, already in his password manager, already covered by 2FA on devices he carries. The macro layer (`drive-chrome-via-input-tools-not-browser-tools.md`) lets the agent USE those sessions instead of needing parallel API credentials.

The substantive question per workflow becomes:

- **Is there a fully logged-in path through GUI?** If yes, prefer the macro path.
- **Is there a credential-only headless path?** If yes, fall back only when GUI is fundamentally unavailable (no human session, no laptop, server-to-server only).

For most release / publishing / deploy / dashboard / metadata-update workflows, the answer is "GUI works, skip the API key."

## Concrete cases

### iOS App Store Connect upload (the trigger for this rule)

| Path | What's needed | Failure modes |
|---|---|---|
| ASC API key (.p8 + Key ID + Issuer ID) | Generate at appstoreconnect.apple.com Users and Access > Integrations > Keys, download .p8 (one-time download), persist Key ID + Issuer + .p8 contents in `kv_store`, stage on Mac, pass to `xcodebuild -authenticationKeyPath` and `xcrun altool --apiKey/--apiIssuer`. | .p8 lost (cannot re-download), key revoked, IRS-style scope confusion (App Manager vs Developer), key rotated unexpectedly. |
| Xcode Organizer GUI macro | Run `xcodebuild archive` + `xcodebuild -exportArchive` to produce `.ipa` (no auth needed - signing identities live in Mac keychain from one-time Xcode login). Then `macro.run({name: "xcode-organizer-upload", params: {ipa_path}})` on the Mac to drive Xcode > Window > Organizer > Distribute App. | Mac GUI must be reachable (laptop agent on SY094 or Corazon). Apple ID session in Xcode must still be alive (one-time login covers that). |
| Transporter app macro | Same `.ipa` produced by `xcodebuild`. Then `macro.run({name: "transporter-upload", params: {ipa_path}})` drives the standalone Transporter app's drag-drop or file picker, which uses the same logged-in Apple ID. | Transporter must be installed (one-time `mas install` or App Store install). |

The macro paths use the Apple ID Tate is ALREADY logged in to. No `.p8` file to lose. No Key ID rotation. No `creds.asc_api_key_p8` row to maintain. No 2FA dance for the agent because the human-side login already cleared 2FA when Tate signed in once.

### Other SaaS workflows where this applies

| Workflow | API-key path (avoid) | GUI-macro path (prefer) |
|---|---|---|
| Vercel project create | `VERCEL_TOKEN` env var + `vercel projects add` | Drive `vercel.com/dashboard` via Tate's logged-in Chrome |
| Vercel deploy trigger | `vercel deploy --token=...` | `vercel.com/<org>/<proj>/deployments` > Redeploy button |
| Stripe payment-link create | Stripe secret key + API call | Stripe dashboard logged-in session |
| GitHub PR merge | `gh auth login` + `gh pr merge` | github.com PR page > Squash and merge button |
| Apple Developer team-id fetch | Generate key + read team scope from JWT | developer.apple.com/account membership page (proven 29 Apr 2026) |
| Supabase project metadata edit | service-role key + REST API | supabase.com/dashboard logged-in session |
| Google Play Console upload | service-account JSON + `fastlane supply` | play.google.com/console > Internal testing > Upload AAB drag-drop (Android Studio built-in publish wizard works too) |
| Apple TestFlight tester management | ASC API key + ASC API endpoints | appstoreconnect.apple.com TestFlight > Internal Testing > + Tester GUI |
| Resend domain DKIM lookup | Resend API key | resend.com/domains logged-in dashboard |

### Workflows where API keys are the right answer

| Workflow | Why GUI doesn't work |
|---|---|
| Server-to-server cron (e.g. nightly Stripe reconciliation) | No human session involved. Headless by nature. |
| Webhook signature verification | Cryptographic, programmatic-only. |
| Long-lived integrations Tate doesn't operate (e.g. our own customer-facing app calling Stripe) | The integration runs as Ecodia, not as Tate. Needs Ecodia's own credentials. |
| Read-only public-data APIs (GitHub public repos, Polygon RPC) | No credential needed at all, but if rate-limited, an API key is the right primitive. |
| Scheduled cron tasks the agent runs without a Tate session being open | Same as server-to-server. The macro layer requires the agent to drive Tate's GUI; if Tate's machine is off, no GUI. |

The rule of thumb: **if the workflow exists because Tate uses it, prefer the macro. If the workflow exists for headless service operation, use an API key.**

## Decision protocol

When about to add a new credential to `kv_store` or to a status_board row asking Tate to generate one, run this 4-question check:

1. Does Tate already do this workflow through a GUI? (Check his bookmarks, his last-week activity, his SSO enrollments.) If YES, the macro path exists.
2. Is the credential workflow fundamentally headless (server-to-server, no human in the loop)? If YES, an API key is correct. Continue with the credential generation.
3. If both paths work, what is the all-in cost over 12 months? Macro path: write the handler once, ~1-2 hours. API key path: generate, store, document, monitor for rotation, recover if lost. Macro usually wins.
4. Is the workflow security-sensitive enough that we WANT a separate, scoped credential trail (not Tate's full identity)? E.g. CI/CD that runs without a human, or a third party we want to give limited scope to. If YES, generate an API key and scope it narrowly.

If the answer is "macro works AND it's not security-isolation territory," skip the API key.

## Do

- Default to the macro path for any release / publish / dashboard / metadata workflow that Tate currently does through a GUI.
- Author the macro handler when the workflow is identified (per `~/ecodiaos/patterns/macros-record-mode-and-auto-author-from-runs.md` Phase 1 trigger criteria).
- Document in the relevant client/release flow doc which path is in use ("iOS upload via xcode-organizer-upload macro on SY094, no ASC API key in use").
- When status_board row drafts ask Tate to generate a credential, audit first: is there a GUI-macro alternative? Replace the row with a macro-authoring task instead.
- For workflows that genuinely need headless operation, generate the credential with the narrowest scope possible.

## Do not

- Do not add `next_action: "Tate generate ASC API key"` to status_board if the macro path works for the same workflow. The workflow is the goal, not the credential.
- Do not store programmatic credentials "just in case" alongside an active macro path. The credential becomes a stale artefact that drifts (rotation forgot, scope expanded, leaked unnoticed).
- Do not pass through the SaaS vendor's recommended "API key best practice" without questioning whether it applies to our setup. Vendor docs assume headless integration; we have a desktop human in the loop.
- Do not skip the macro path because "it's more reliable to use the API." The macro path is more reliable in our context: it cannot break from a key rotation we forget, cannot break from a scope mistake, and surfaces failures visually (screenshot).
- Do not let path-1 in `~/ecodiaos/patterns/ios-signing-credential-paths.md` be read as "always prefer ASC API key." That doctrine ranks the THREE programmatic-credential paths against each other; it predates the GUI-macro option. Re-read it as "if you must use programmatic credentials, prefer ASC API key over Xcode-login-on-Mac over manual-profile-drop." The GUI-macro path supersedes all three for the iOS-upload-via-Tate-Mac case.

## Verification

Before declaring "we need credential X for workflow Y," run:

1. `Grep "triggers:" ~/ecodiaos/patterns/` for terms matching the workflow.
2. Read `~/ecodiaos/patterns/macros-record-mode-and-auto-author-from-runs.md` and check whether a macro handler exists or could be authored within the Phase 1 effort budget.
3. Check whether Tate has a logged-in session for the relevant SaaS in his Chrome Default profile on Corazon or in a desktop app on Corazon/SY094.
4. If yes-yes-yes, the macro path is the right answer. Skip the credential.

## Cross-references

- `~/ecodiaos/docs/secrets/INDEX.md` - the credentials registry that catalogues which creds are GUI-macro-replaceable vs programmatic-required. Each cred file has a `class:` frontmatter that applies this doctrine. Apple-related entry points: `apple.md`, `apple-asc-keys.md`, `asc-api-fallback.md`. Android: `_pending-android-keystores.md`, `_pending-google-play-service-account.md` (the Play SA is DEMOTED to fallback under this doctrine). When considering whether to provision a new credential, grep this directory first.
- `~/ecodiaos/patterns/drive-chrome-via-input-tools-not-browser-tools.md` - the underlying Chrome-driving doctrine that makes browser-based macros work.
- `~/ecodiaos/patterns/corazon-is-a-peer-not-a-browser-via-http.md` - the peer paradigm. Macros cover desktop apps too (Xcode, Transporter, Android Studio), not just the browser.
- `~/ecodiaos/patterns/macros-record-mode-and-auto-author-from-runs.md` - how new macros get into the registry. Phase 1 hand-coded, Phase 2 record-mode, Phase 3 auto-author.
- `~/ecodiaos/patterns/ios-signing-credential-paths.md` - the older 3-path ranking for programmatic-credential iOS signing. This pattern adds a 4th option (GUI-macro) that supersedes paths 1-3 when Tate's Mac is available.
- `~/ecodiaos/patterns/exhaust-laptop-route-before-declaring-tate-blocked.md` - the 5-point check. The macro path is the natural realisation of "step 2: is the credential in Tate's logged-in session."
- Strategic_Direction: "GUI macros replace API keys for autonomous releases - use logged-in user sessions over generated programmatic credentials when both work" (Neo4j).
- `~/ecodiaos/clients/release-candidate-analysis-2026-04-29.md` and `~/ecodiaos/scripts/release.sh` - the iOS release driver was originally drafted with the ASC-API-key path, and is being updated this same session to swap in the macro path as the primary upload step (`mcp__macros__macro_run` xcode-organizer-upload OR transporter-upload), with the API key path retained only as a fallback.

## Origin

29 Apr 2026, 15:13 AEST. Tate verbatim:

> "why do we need this asc key bro.... just use the gui and it will work, i always redeploy roam via the gui working fine."

Context: the status_board P2 row "iOS ASC API .p8 private key file - locate or regenerate" was an artefact of the iOS release pipeline being designed around `xcrun altool --apiKey/--apiIssuer`. That design predates the macro layer. Tate flagged that the API key was unnecessary for the workflow he actually does (Roam redeploys through Xcode Organizer or Transporter, manually, regularly, without ever touching an API key). The macro layer (Phase 1 ships today, fork_mojldsgx_7b55bf) makes that same GUI path callable as a single tool: `mcp__macros__macro_run({name: "xcode-organizer-upload", params: {ipa_path}})`.

Same-day validation precedent: Apple Developer team-id fetch via `input.*` + `screenshot.screenshot` driving Tate's existing Chrome session worked first try (per Decision node "Apple cred-fetch via Tate Chrome blocked at 5-point check step 2 - password not saved" - the cred-fetch only blocked because the Apple password wasn't yet saved in Tate's Chrome password manager; the macro mechanics worked perfectly).

The release.sh script's iOS branch is updated this same session to call the macro as the primary upload path, with the ASC API key path retained as a documented fallback for the case where Tate's Mac is unavailable. The status_board row for the .p8 file is demoted accordingly.

Authored: fork_mojmpn4g_ca6af8 (cold-start fortification meta-fork).
