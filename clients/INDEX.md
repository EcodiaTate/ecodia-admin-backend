# clients/ - per-client + per-system doctrine and reference

This directory holds one `.md` file per client (Co-Exist, Ordit, ...) and per system Tate operates (Corazon, SY094 MacInCloud) plus shared release-flow doctrine that applies across multiple Ecodia/client apps. Files have a YAML-ish `triggers:` frontmatter line declaring relevance scope, mirroring the `~/ecodiaos/patterns/` and `~/ecodiaos/docs/secrets/` convention.

## How this works (the surfacing mechanism)

Before any high-leverage action involving a specific client or system, `Grep` this directory for matching trigger keywords:

```
Grep "triggers:" ~/ecodiaos/clients/ -A 1
```

This returns the triggers line of every file. Pick the files whose trigger keywords intersect the action context, read those files in full, then proceed.

## High-leverage actions (always grep this directory before)

- Any client-facing email, PR comment, Bitbucket reply, or Slack DM (Co-Exist, Ordit, Resonaverde, Landcare, future clients)
- Any code change against a client codebase (Factory dispatch, branch push, deploy)
- Any iOS/Android release work (Capacitor sync, xcodebuild, gradle bundleRelease, TestFlight upload, Play Console upload)
- Any first-time app creation (Capacitor scaffold, ASC record create, Play Console listing create)
- Any laptop-agent / SY094 / Corazon operation that is not a trivial probe (multi-step browser automation, SSH session, agent-tunnel build)
- Any client-context status_board update (priority change, archive, scope shift)
- Any contract / quote / scope discussion that references a specific client

## Index

| File | Triggers (excerpt) | Purpose |
|---|---|---|
| [coexist.md](coexist.md) | coexist, kurt, charliebennett, org.coexistaus.app, coexist-release.jks, INV-2026-003, ip-retention-coexist | Co-Exist client knowledge file - read BEFORE any Co-Exist work |
| [coexist-android-sso-diagnostic-2026-04-29.md](coexist-android-sso-diagnostic-2026-04-29.md) | coexist-android-sso, credentialmanager, no-credential-error, play-app-signing-sha-1, gcp-project-528428779228, capacitor-social-login | Diagnostic: Android Google SSO regression (root-cause hypothesis + Tate-actionable fix steps) |
| [coexist-resend-smtp-setup-2026-04-29.md](coexist-resend-smtp-setup-2026-04-29.md) | coexist-resend, custom-smtp-supabase-auth, rate-limit-email-sent, resend-pro, dkim-resend, coexistaus.org-dns, squarespace-dns | Co-Exist Supabase Auth custom SMTP via Resend - blocked recon |
| [ordit.md](ordit.md) | ordit, fireauditors, fireauditors1, eugene, ekerner, craige, x-bitbucket-api-token-auth, pr-212, cognito-integration-ordit | Ordit / Fire Auditors client knowledge file (dispatch spec entry point) |
| [corazon-peer-architecture-2026-04-29.md](corazon-peer-architecture-2026-04-29.md) | corazon, 100.114.219.69, eos-laptop-agent, chrome-default-profile, chrome-profile-1, port-7456-corazon | Live tool inventory + Chrome profile state + SSH state on Tate's Windows laptop |
| [macincloud-access.md](macincloud-access.md) | macincloud, sy094, sy094.macincloud.com, user276189, sshpass, ssh-tunnel-17456, agent_token-mac, port-7456-mac | SY094 MacInCloud access pattern (SSH-only, no Tailscale) |
| [app-release-flow-android.md](app-release-flow-android.md) | play-console, gradle-bundlerelease, .aab, .jks, capacitor-android-release, fastlane-supply, play-app-signing | End-to-end Android Play Console release doctrine for Capacitor apps |
| [app-release-flow-ios.md](app-release-flow-ios.md) | xcodebuild, app-store-connect, asc-api-key, testflight, sy094, capacitor-ios-release, .ipa, .xcarchive, agvtool | End-to-end iOS App Store release doctrine for Capacitor apps |
| [app-release-flow-new-app.md](app-release-flow-new-app.md) | capacitor-init, cap-add-ios, cap-add-android, new-app-creation, bundle-id-decision, asc-app-record-create, play-console-app-create | First-time app creation across both stores |
| [release-candidate-analysis-2026-04-29.md](release-candidate-analysis-2026-04-29.md) | release-candidate-coexist, first-app-ship, testflight-first-ship, exportoptions.plist, ios-upload-macro-path | Release candidate analysis: which Ecodia app to ship first to TestFlight/Play Internal |
| [roam-audit-2026-04-29.md](roam-audit-2026-04-29.md) | roam-audit, au.ecodia.roam, roam-iap, roam-release.keystore, paywall-modal-roam, apple-sign-in-roam, samsung-keyboard-inset | Roam app audit (status_board rows, build/lint health, IAP submission readiness) |

## Authoring rules

- **One file per client OR per system OR per cross-client doctrine area.** Don't bundle two clients into one file. Don't bundle release-flow doctrine into a client file (it goes in shared `app-release-flow-*.md`).
- **`triggers:` frontmatter is mandatory.** Comma-separated, lowercase, narrow keywords that uniquely identify "this file is the right one for this work." Avoid greedy single words ("context", "deploy", "status_board", "ecodia", "factory") - they cause false-positive cascades through the brief-consistency hook. Prefer entity names + system names + specific technical terms (e.g. `coexist-release.jks`, `sy094.macincloud.com`, `org.coexistaus.app`, `100.114.219.69`).
- **Compound triggers when needed.** `ios-release-flow` beats `release`. `coexist-android-sso` beats `sso`.
- **Write triggers AFTER the body.** Read the file end-to-end first, then ask "what searches should hit this." Speculative triggers drift.
- **Update this INDEX.md when adding a file.** This index is a curated table; if it falls out of sync with the directory listing, fix it.

## When to add a new file

- A new client signs (full client knowledge file: scope, contract, stack, contacts, lessons, status board).
- A new system is integrated that has access patterns Tate / forks need to know (e.g. a new remote machine, a new SaaS dashboard with stored credentials).
- A new cross-client doctrine area emerges (e.g. a release flow that applies to 3+ apps).
- A long-form recon / audit / diagnostic doc that future sessions will need to reference. Author with date stamp `YYYY-MM-DD` in the filename so it's clearly a snapshot, not the canonical client file.

## When NOT to use this directory

- Throwaway drafts go in `~/ecodiaos/drafts/`.
- Generic operational doctrine (rules that apply across all clients) goes in `~/ecodiaos/patterns/`.
- Credentials go in `~/ecodiaos/docs/secrets/` (one file per credential, not per client).
- Operational scripts go in `~/ecodiaos/scripts/`.

## Documentation hierarchy

| Layer | Path | Holds |
|---|---|---|
| Global identity / business | `~/CLAUDE.md` | Identity, decision-authority, voice rules |
| Technical operations | `~/ecodiaos/CLAUDE.md` | MCP tools, infra, scheduling, status_board mechanics |
| Doctrine (grep-addressable) | `~/ecodiaos/patterns/*.md` | One rule per file. Triggers frontmatter. |
| Per-client / per-system reference | `~/ecodiaos/clients/*.md` (this dir) | Per-client + per-system docs |
| Credentials registry | `~/ecodiaos/docs/secrets/*.md` | One file per cred. Triggers frontmatter. |
| Drafts | `~/ecodiaos/drafts/*.md` | In-flight drafts |
| Operational scripts | `~/ecodiaos/scripts/*.{sh,js}` | Executable runbooks |

## Origin

Authored 2026-04-29 by fork_mojmvx1c_535b85. Closes the gap identified by `~/ecodiaos/drafts/triggers-audit-2026-04-29.md` (fork_mojmkhzo_1c0453): the clients/ layer was the only doctrine layer in EcodiaOS without `triggers:` frontmatter on every file or an INDEX.md. The meta-pattern at `~/ecodiaos/patterns/context-surfacing-must-be-reliable-and-selective.md` mandates all five surfacing layers (file-per-thing + triggers + pre-action grep + hook enforcement + Neo4j semantic fallback) for every doctrine-layer directory.

The first authoring pass attempted broader trigger keywords ("android", "ios", "signing", "release-flow"). Tate's mid-fork directive at 15:46 AEST tightened the bar after a sibling fork dispatch produced a 16-warning false-positive cascade from the existing patterns/ trigger surface: triggers must be NARROW and uniquely identifying. This INDEX and the 11 client-doc trigger lines reflect the tightened bar.
