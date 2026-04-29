---
triggers: app-release-pipeline-spec, productized-release-pipeline, end-to-end-app-release, release-pipeline-builder, release-orchestration-spec, scripts-release-sh, macincloud-release, capacitor-release-pipeline, release-intake, release-runbook, release-status-board-lifecycle
priority: high
canonical: false
spec_status: scoping-only-not-implementation
---

# End-to-End App Release Pipeline - Productized Buildout Spec

Authored 2026-04-29 by fork `fork_mojt2x9l_19d23c` against status_board row `d0092340-afc7-4a41-a1e7-3cc8933cd6d4` ("End-to-end app release pipeline (productized buildout)"), in response to Tate verbatim 09:53 AEST 29 Apr:

> "today once we are done all this we get onto helping you make app releases end-to-end. Receiving the request via email or me, patching the code with a fork or cc, testing, approving, pushing, then the fun part which is the android and apple releases via android studio and the macincloud/xcode setup."

This doc is **SCOPING ONLY**. It is not the pipeline. It is the brief a future builder fork will pick up.

Companion / source-of-truth docs (read these before any builder fork):
- `~/ecodiaos/scripts/release.sh` (~795 LOC, the existing partial driver - covers stages 4-7 single-shot)
- `~/ecodiaos/scripts/macros/{xcode-organizer-upload,transporter-upload}.applescript` (existing iOS macro drivers)
- `~/ecodiaos/clients/app-release-flow-ios.md` (per-step iOS flow, doctrine)
- `~/ecodiaos/clients/app-release-flow-android.md` (per-step Android flow, doctrine)
- `~/ecodiaos/clients/app-release-flow-new-app.md` (first-time app creation)
- `~/ecodiaos/clients/release-candidate-analysis-2026-04-29.md` (the live first-ship recon)
- `~/ecodiaos/clients/macincloud-access.md`
- `~/ecodiaos/clients/coexist.md` (the lighthouse instance)
- `~/ecodiaos/patterns/ios-signing-credential-paths.md`
- `~/ecodiaos/patterns/gui-macro-uses-logged-in-session-not-generated-api-key.md`
- `~/ecodiaos/patterns/exhaust-laptop-route-before-declaring-tate-blocked.md`
- `~/ecodiaos/drafts/macro-architecture-roadmap-2026-04-29.md`

---

## Section 1 - Goal + Non-Goals

### Goal

A productized service that takes any Capacitor-wrapped Ecodia or client app from a "ship X" trigger to a real release lane (TestFlight Internal, App Store production, Play Internal, Play Production) with **one orchestrator entry point**, an auditable status_board lifecycle row, and a build-test-sign-upload-release pipeline that requires a Tate-physical action ONLY at the irreducible gates (banking 2FA, store-side first-time app submission, screenshots that need a real device).

The pipeline is **the same code path** for every Ecodia app and every Capacitor-wrapped client app. Per-codebase variation is encoded as a YAML/JSON runbook descriptor, not as forked code.

### What's IN scope (this productized buildout)

1. **Intake layer** - normalises a release request from any of: (a) inbound email to code@ ("Please ship X to TestFlight"), (b) Tate-typed chat instruction ("ship coexist ios testflight"), (c) status_board row state transition ("approved -> ready-to-ship"), (d) cron-driven scheduled releases. Produces a single canonical release-request record with slug, platform, env, source-commit, requester.
2. **Patch / fork layer** - if the release-request includes scope (bug fix, feature) the orchestrator dispatches an `mcp__forks__spawn_fork` (or, when CLI is unblocked, Factory) to produce the diff. PR creation, CI gates, and merge-to-main are part of this layer.
3. **Test layer** - post-patch, pre-build: lint, typecheck, unit tests, smoke tests (Puppeteer for web; iOS Simulator / Android emulator for native). Failure here aborts the release before it touches store-side state.
4. **Approval gate** - status_board row pauses on `awaiting-tate-approval` if (a) cost-of-error is high (production submission, or first-time-store), or (b) the change-class requires it (auth, payments, IAP). Auto-skipped for routine TestFlight ships.
5. **Build layer** - a corrected, generalised version of `scripts/release.sh`'s build steps. Per-platform: Capacitor sync, version bump, archive (iOS) / bundleRelease (Android).
6. **Sign + upload layer** - GUI-macro path is the default per Strategic_Direction "GUI macros replace API keys for autonomous releases". ASC API key is fallback only. Android upload via `fastlane supply` (programmatic SA) or Corazon-Chrome-driven Play Console (GUI-macro fallback).
7. **Store-side post-upload layer** - TestFlight tester group assignment, Play Console internal-track promotion, version-metadata fill (if `prod` and metadata is committed to repo as fastlane deliver / play screenshots).
8. **Smoke-test post-ship** - Puppeteer or device-side smoke that the new build is reachable on the test lane. SMS Tate when build is testable.
9. **Status_board lifecycle row** - one row per release-request, tracks every transition: intake -> patched -> tested -> approved -> built -> uploaded -> on-track -> verified.
10. **Audit + idempotency layer** - kv_store `release.last.{slug}.{platform}` keyed by (commit + env). Refuses duplicate ships. Git tag per release. Neo4j Episode per release.
11. **Per-codebase runbook descriptor** - one file `~/ecodiaos/runbooks/{slug}.json` or `.md`-with-yaml-frontmatter, defining the inputs the pipeline needs to ship that app. Schema in Section 3.

### What's OUT of scope (explicit non-goals)

1. **Native-Kotlin or native-Swift apps.** Capacitor-wrapped Vite/React/Next is the universe. Native-only apps are a future add-on; the runbook descriptor schema reserves space for `framework: "capacitor" | "native-ios" | "native-android"` but only `capacitor` is implemented.
2. **iOS metadata + App Review submission for first-time apps.** The first prod submission of a brand-new app goes through `app-release-flow-new-app.md` with Tate at the laptop. The pipeline ships TestFlight builds for new apps autonomously; the production-submission GUI dance (screenshots, app description, content rights, IDFA disclosure, App Review questions) is opt-in / Tate-driven for v1. Subsequent prod versions of an established app ARE in-scope.
3. **Replacing fastlane / xcodebuild / gradlew.** The pipeline is a thin orchestrator over the existing CLI tools, not a re-implementation. Where a vendor CLI works, we shell out.
4. **Replacing Corazon's Chrome browser-driving for Play Console GUI fallback.** When the programmatic path (`fastlane supply` with SA JSON) fails or the SA isn't provisioned, the fallback is "drive Tate's logged-in Play Console via Corazon input.* + screenshot.*" per the GUI-macro doctrine - NOT a new headless browser scrape. The pipeline calls macros; the macros live in the laptop-agent macro registry per `macros-record-mode-and-auto-author-from-runs.md`.
5. **Cross-account/cross-team dispatch.** This pipeline is for code@ecodia.au (Apple Developer team Ecodia Pty Ltd, 86PUY7393S) and Tate's personal Google Play developer account. Client apps that have THEIR OWN Apple Dev / Play accounts (rare; we generally use ours under the IP-retention model) are out of scope for v1.
6. **Web releases.** Vercel auto-deploys from main. The pipeline could be a thin wrapper over `vercel deploy` and `vercel promote` but routine web ships are already auto. Web is in-scope only for the "smoke-test the deployed PR before shipping native" stage, not as its own release lane.
7. **CI-driven releases on every push to main.** The pipeline is request-driven, not push-driven. Triggering a release is an explicit act; main-branch commits accumulate until a release-request fires. (Future: opt-in auto-ship-to-TestFlight-on-main-merge per slug, but not v1.)

---

## Section 2 - Architecture Sketch

```
                    +-----------------------+
                    |  intake (any source)  |
                    |  - email body parse   |
                    |  - Tate chat command  |
                    |  - status_board edge  |
                    |  - cron schedule      |
                    +-----------+-----------+
                                |
                                v
                    +-----------------------+
                    | release_requests row  |   (NEW table)
                    | id, slug, platform,   |
                    | env, scope, commit,   |
                    | requester, source     |
                    +-----------+-----------+
                                |
                  has scope?    |
                    yes <-------+------> no (release current main as-is)
                     |                          |
                     v                          |
        +-----------------------+               |
        |  patch fork           |               |
        |  mcp__forks__spawn    |               |
        |  -> PR -> merge       |               |
        +----------+------------+               |
                   |                            |
                   v                            v
             +------------------------+
             |  test layer            |
             |  - lint / tsc          |
             |  - unit (vitest)       |
             |  - smoke (puppeteer)   |
             |  - native sim/emu(opt) |
             +-----------+------------+
                         |
              fail? <----+----> pass
                |             |
                v             v
       abort+SMS   +--------------------------+
                   |  approval gate           |
                   |  - auto for TF routine   |
                   |  - status_board pause    |
                   |    for prod / first-time |
                   +-----------+--------------+
                               |
                               v
                   +------------------------+
                   |  build layer           |
                   |  iOS: archive on SY094 |
                   |  Android: bundle on VPS|
                   +-----------+------------+
                               |
                               v
                   +------------------------+
                   |  sign + upload layer   |
                   |  iOS macro -> ASC TF   |
                   |  Android fastlane supp |
                   |    -> Play internal    |
                   +-----------+------------+
                               |
                               v
                   +------------------------+
                   |  store-side post-up    |
                   |  - TF tester group     |
                   |  - Play track promo    |
                   |  - prod metadata (opt) |
                   +-----------+------------+
                               |
                               v
                   +------------------------+
                   |  smoke + announce      |
                   |  - SMS Tate            |
                   |  - email requester     |
                   |  - Neo4j Episode       |
                   |  - status_board done   |
                   +------------------------+
```

### Process boundaries

- **Orchestrator** runs in the existing ecodia-api process (PM2 `ecodia-api`). New module `src/services/releasePipelineService.js`. State persisted in Postgres.
- **Builds run on the right host:**
  - iOS archive + sign + upload runs on SY094 via SSH (existing pattern).
  - Android bundleRelease runs on the VPS (gradle-on-Linux is fine; no Android Studio needed for `gradlew bundleRelease`).
  - Android fastlane supply runs on the VPS.
  - Android Corazon-Chrome fallback runs on Corazon via the laptop-agent macro layer.
  - iOS Xcode Organizer / Transporter macro runs on SY094 via osascript over SSH (release.sh already inlines this).
- **No client-side state.** The pipeline is callable from a single CLI entry, a single MCP tool, an HTTP webhook, and a status_board state-edge listener. All four converge on the same `releasePipelineService.dispatch(request)`.

### Trust boundaries

- All credentials read from kv_store, never from .env or hardcoded.
- Per-app signing creds keyed under `creds.android.{slug}` (Android) or `creds.apple` + per-team profiles (iOS, single team for now).
- The macro layer's "Tate is logged in to Xcode/Transporter/Play Console on this host" is a trust assumption; verified by macro pre-flight (read window title / cookie state) before the long upload step.
- Idempotency: `release.last.{slug}.{platform}.{env}` kv_store row blocks duplicate ships of the same commit. Future: per-version-code Play uniqueness check via fastlane.

---

## Section 3 - Per-Codebase Runbook Template

Each app gets a runbook descriptor at `~/ecodiaos/runbooks/{slug}.{json|yaml}`. The pipeline reads this on dispatch. Schema below; treat as proposed - the builder fork can refine.

```yaml
---
slug: coexist
display_name: Co-Exist Australia
canonical: true

repo:
  workspace: ~/workspaces/coexist        # NOT ~/workspaces/coexist/fe (this codebase is flat)
  remote: https://github.com/EcodiaTate/coexist.git
  default_branch: main
  framework: capacitor
  package_manager: npm                    # npm | yarn | pnpm

build:
  web_build: "npm run build"              # produces dist/
  cap_sync_targets: [ios, android]

ios:
  enabled: true
  xcode_project: ios/App/App.xcodeproj   # NOT App.xcworkspace - per release-candidate doctrine
  scheme: App
  bundle_id: org.coexistaus.app
  team_id_kv: creds.apple.team_id        # kv_store path
  signing_path: macro                    # macro | altool
  macro_host: sy094                      # sy094 | corazon
  macro_name: xcode-organizer-upload     # default; transporter-upload as fallback
  export_options_plist: ios/App/ExportOptions.plist  # must exist in repo
  testflight_group: "Internal Testers"
  bump_strategy: agvtool_what_version_plus_1
  spm_node_modules_subset:
    - node_modules/@capacitor
    - node_modules/@capgo
  # rsync these from VPS to SY094 ~/projects/{slug}/node_modules/ before xcodebuild

android:
  enabled: true
  application_id: org.coexistaus.app
  signing:
    keystore_kv: creds.android.coexist.keystore_b64
    keystore_password_kv: creds.android.coexist.keystore_password
    key_alias_kv: creds.android.coexist.key_alias
    key_password_kv: creds.android.coexist.key_password
    keystore_path: android/app/coexist-release.jks      # written from kv_store at build time
  upload_path: fastlane                  # fastlane | corazon_chrome | manual
  play_sa_kv: creds.google_play_service_account_json    # required for fastlane path
  bump_strategy: increment_versionCode
  internal_track_name: internal

approval:
  testflight: auto                       # auto | tate
  prod: tate                             # always Tate for prod first-time
  first_time_app: tate
  change_class_requires_tate:            # if PR touches these paths, gate on Tate
    - src/services/auth/**
    - src/services/payments/**
    - src/services/iap/**
    - capacitor.config.ts

smoke:
  web: "https://coexist.ecodia.au"
  testflight_url: "https://testflight.apple.com/join/<token>"
  device_smoke_required: false           # true forces device-side post-ship verify

contact:
  requester_default: tate@ecodia.au
  client_communication: false            # never email Co-Exist directly without Tate go-ahead
```

### Roam runbook differences (illustrative, not for first-build)

- `repo.workspace: ~/workspaces/roam-frontend` (note: NOT under `roam/` - flat name from before the slug convention)
- `ios.xcode_project: ios/App/App.xcworkspace` (verify; older Capacitor scaffold)
- `android.application_id: au.ecodia.roam`
- `android.signing.keystore_path: roam-release.keystore` (root level, NOT android/app/)
- `android.signing.signingConfigs_block_present: false` - **REPO GAP**, runbook flags this so build attempt produces a clear error not a confusing gradle failure.
- `approval.first_time_app.testflight: tate` (Roam has not yet shipped to TestFlight)
- `iap.enabled: true` - extra runbook section for IAP-bearing apps; requires App Store Connect IAP record creation gate.

### Chambers runbook differences

- New-app status: `app_record_state.ios: not_created`, `play_console_state: not_created`. Pipeline refuses release until Tate flips these to `created` after running the new-app GUI flow.
- `android.signing.keystore_path: android/app/chambers-release.jks` (does not exist yet - build fails with clear directive: "Generate keystore via fork dispatch, then add password to kv_store creds.android.chambers").

### Why a runbook descriptor instead of inline pipeline knowledge

- New apps onboard by writing one file. No code changes.
- Pipeline code stays generic.
- Drift between doctrine docs and actual ship config is detectable (lint runbook against repo state).
- Status_board can read the runbook to render "what would ship for {slug}" without running anything.

---

## Section 4 - Automation Gaps (Where Tate / Mac / GUI Are Required)

The pipeline aims for full autonomy on routine TestFlight + Play Internal ships. The list below names every step where autonomy is not yet possible or is preconditional.

### Genuine Tate-physical (no automation possible)

| Step | Why Tate-physical | Frequency | Mitigation |
|------|-------------------|-----------|------------|
| Bank-account 2FA for Apple/Google payment changes | SMS to Tate's phone; not on Corazon | Rare (annual or per banking change) | Surface as status_board well in advance |
| Apple Developer Program License Agreement re-acceptance | Periodic Apple-pushed updates; web GUI on developer.apple.com | Variable (~quarterly) | Pipeline detects via altool error code; SMS Tate with deep-link |
| One-time Xcode Apple ID login on SY094 | Keychain login persists ~30 days | ~monthly | Macro pre-flight checks Xcode Settings > Accounts; SMS Tate if expired |
| First-time App Store Connect record creation for a new app | App-creation GUI; idempotency key etc. | Once per new app | Documented in `app-release-flow-new-app.md`; gated in runbook |
| First-time Play Console app entry | Same | Once per new app | Same |
| App Review production submission for first-time app | Screenshots, description, content rating, IDFA disclosure, IAP disclosure - GUI-heavy | Once per new app per platform | Tate-driven for v1; productize in v2 once we have the macro library |
| Play Data Safety form, IARC content rating | Web GUI | Once per new app | Same |
| Banking & tax forms for IAP / paid apps | GUI + identity verification | Once per developer account | Tate-only |

### Mac-required, automatable via SY094 + macro layer

| Step | Currently | Once macros land |
|------|-----------|------------------|
| `xcodebuild archive` | Working in release.sh | Same |
| `xcodebuild -exportArchive` | Working in release.sh | Same |
| Xcode Organizer upload (GUI-macro path) | Macros registered + dry-run-verified per status_board row 5654eccc | Working post-Tate-Xcode-login on SY094 |
| Transporter upload (GUI-macro fallback) | AppleScript driver staged | Working post-Tate-Apple-ID-login in Transporter on SY094 |
| TestFlight tester group assignment | Manual | App Store Connect API: `POST /betaTesters` with ASC API key (path 2 fallback) OR macro-drive ASC GUI |
| App Store Connect production submission for established apps | GUI | fastlane deliver wired to commit-checked metadata |

### Browser/GUI-required on Corazon for Android Play Console fallback

| Step | When needed | Currently |
|------|-------------|-----------|
| Play Console internal track promotion via web UI | When fastlane SA JSON not provisioned | Manual today; macro-able post-Phase-2 macro library |
| Play Data Safety form | Per-app one-time | Manual |
| Play Content Rating | Per-app one-time | Manual |
| Pricing & Distribution config | Per-app one-time | Manual |

### Pre-conditional credentials (one-time generation, then automated forever)

| Cred | Path | Status |
|------|------|--------|
| `creds.apple.team_id` | Tate looks up at developer.apple.com > Membership | RESOLVED (status_board 557f2d54) - team_id=86PUY7393S |
| `creds.asc_api_key_p8 + key_id + issuer_id` | Tate generates at appstoreconnect.apple.com > Keys (fallback path only) | RESOLVED meta (key_id=6U5835AAQY captured) - .p8 file content still pending |
| `creds.android.{slug}.{keystore_b64,passwords,alias}` | Tate exports + base64 encodes per slug | PENDING for coexist (P2 status_board) |
| `creds.google_play_service_account_json` | Tate creates SA at Play Console > API access > grant Release Manager > download JSON | PENDING (P3 / future) |

### What the automation gap doc tells the builder fork

- Default-build assumes the macro path is happy. If pre-flight detects "Xcode session expired" the pipeline aborts with a single SMS to Tate naming the unblock action and the deep-link.
- The pipeline does NOT try to be clever about retrying when a Tate-physical step is hit. It surfaces, waits, resumes.
- Programmatic-credential paths (ASC API key, Play SA JSON) are documented as fallbacks, not deleted. Some workflows (TestFlight tester assignment, Play track promotion) MUST go programmatic to be truly autonomous; the runbook flips them on per-app as creds get provisioned.

---

## Section 5 - Status_Board Lifecycle Row Template + Transition Rules

Every release-request creates exactly one status_board row that lives through the full lifecycle. No mid-flight row-splitting.

### Row template (proposed)

```sql
INSERT INTO status_board (
  entity_type, entity_ref, name, status, next_action, next_action_by,
  context, priority
) VALUES (
  'task',
  'release:{slug}:{platform}:{env}:{requestId}',
  'Release: {slug} {platform} -> {env}',
  'intake',                                                 -- see state machine below
  'Pipeline: parse intake, resolve runbook, compute scope', -- next_action follows status
  'ecodiaos',                                               -- transitions per state
  'requestId={requestId} runbook={path} commit={shaShort} requester={email}',
  CASE env
    WHEN 'prod' THEN 1                   -- production ships always P1
    WHEN 'testflight' THEN 2             -- TestFlight P2
    WHEN 'internal-track' THEN 2
    ELSE 3
  END
);
```

### State machine

| status | next_action_by | who advances |
|--------|----------------|--------------|
| `intake` | `ecodiaos` | Pipeline: validate request, resolve runbook, normalise scope |
| `patch-needed` | `ecodiaos` | Pipeline dispatches patch fork |
| `patching` | `ecodiaos` | Patch fork running |
| `pr-open` | `ecodiaos` | Pipeline waits for CI green + auto-merge if change-class allows |
| `awaiting-tate-review` | `tate` | High-risk change-class; Tate merges PR |
| `merged` | `ecodiaos` | Pipeline picks up post-merge commit |
| `testing` | `ecodiaos` | Pipeline runs lint/tsc/vitest/smoke |
| `awaiting-tate-approval` | `tate` | Production ships, first-time apps - Tate confirms |
| `building` | `ecodiaos` | Pipeline runs build on the right host |
| `signing-uploading` | `ecodiaos` | Pipeline runs macro / fastlane / altool path |
| `awaiting-store-processing` | `external` | Apple/Google processing - poll or webhook |
| `on-track` | `ecodiaos` | Build live on TestFlight / Play Internal |
| `smoke-pending` | `tate-or-ecodiaos` | If `device_smoke_required=true` Tate; else automated Puppeteer |
| `verified-shipped` | `ecodiaos` | Pipeline writes Neo4j Episode, archives row |
| `failed` | `ecodiaos` or `tate` | Pipeline classifies and surfaces; auto-retry only on transient |

### Transition rules

- Every transition writes `last_touched=NOW()` and appends one line to `context` with `[YYYY-MM-DD HH:MM AEST] {old_status} -> {new_status}: {one-line reason}`. The row tells the full story without spawning sibling rows.
- `next_action` is rewritten on every transition. Stale `next_action` is a bug - the audit fork should flag rows with `next_action` not matching `status`.
- `priority` can be auto-elevated: a `failed` status pinned at production env auto-bumps to P1 and sends SMS to Tate within 60s.
- `archived_at` is set on `verified-shipped` after a 24h verification window (gives time for crash reports / TestFlight feedback to roll in before archive).
- A row stuck in `awaiting-tate-*` for >48h auto-pings Tate via SMS once, then waits silently (no flood).
- A row stuck in `awaiting-store-processing` for >2h on TestFlight or >24h on Play Internal triggers a polling probe; if still processing, surface and wait. Apple/Google delays are normal.

### Companion artefacts

- `release_requests` table (NEW) holds the canonical request payload and FK-links to status_board.
- `kv_store release.last.{slug}.{platform}.{env}` carries the most-recent successful release (commit, ts, version) for idempotency checks.
- Neo4j `Episode` per `verified-shipped` row, named `Release shipped: {slug} {platform} {env} {version} ({date})`.

---

## Section 6 - First Concrete Instance: Roam IAP

Source: status_board row `75f6855d-7a96-44cd-bbfc-77a15afef386` "Roam IAP Fix" (P2, Tate-blocked on auth-decision today). GST registration is RESOLVED (verified by status_board recon). IAP submission is the actual ship, not a code change.

### What a Roam IAP run through the pipeline looks like

1. **Intake.** Source: status_board state-edge listener fires when row 75f6855d transitions to `ready-to-ship`, OR Tate types "ship roam ios prod". Builds canonical request: `{slug:"roam", platform:"ios", env:"prod", scope:"none-current-main", requester:"tate@ecodia.au"}`.
2. **Runbook lookup.** `~/ecodiaos/runbooks/roam.{json|yaml}`. Surfaces: `iap.enabled=true`, `approval.prod=tate`, `approval.first_time_app=tate` (Roam has never shipped to App Store production - status_board says only TestFlight builds 22/23/24 to date).
3. **Pre-flight gates** (pipeline-runs-as-checks, before any build):
   - **(a) GST registration** - read from kv_store `creds.au.gst_registered=true` (Roam-app-only constraint per `~/ecodiaos/clients/roam.md` doctrine if it exists; else status_board read).
   - **(b) RevenueCat dashboard config** - listed in row context as P2 prerequisite. Pipeline does NOT verify RevenueCat itself in v1; it surfaces "RevenueCat config required - confirm complete?" as a Tate-confirm gate.
   - **(c) IAP product records in App Store Connect** - check via App Store Connect API (`GET /v1/inAppPurchases`), or surface for Tate to confirm if no API path. v1: Tate confirms; v2: API call.
   - **(d) Tax & banking forms** - banking SMS to Tate's phone has been the Tate-blocker; checked via `creds.apple.banking_complete` flag (Tate flips after his banking-2FA call).
   - **(e) App Privacy + Listing copy** - per status_board this is autonomous-via-Corazon; pipeline can offer to drive the Privacy form if `runbook.app_privacy_completed=false`. v1: skip; v2: macro.
4. **No patch needed.** Roam main is the candidate; status_board row 8a1293f / dpl_M9eq...READY confirms the most-recent-merged change is on Vercel.
5. **Test layer.** Vitest, tsc, eslint, Playwright CLS suite (status_board row 457c9ce7 confirms Playwright suite is wired). Smoke against `https://roam.ecodia.au`.
6. **Approval gate.** `approval.prod=tate` AND `approval.first_time_app=tate` -> status_board pauses, SMS to Tate: `roam ios prod ready - confirm to ship?`.
7. **Build.** SY094 path. Roam is on `~/workspaces/roam-frontend`. iOS project is `ios/App/App.xcworkspace` (Roam uses an older Capacitor scaffold per release-candidate-analysis line 99). Capacitor sync, agvtool bump (currently versionCode=1, never shipped TestFlight; bump to 2 or to the next build per pipeline state). Archive + export + macro upload.
8. **Sign + upload.** Macro path via `xcode-organizer-upload`. Fallback to Transporter macro on failure. Hard fallback to altool (requires .p8) on macro double-fail.
9. **Store-side post-upload.** TestFlight tester group assignment via API (or manual for first time). Production submission requires the GUI-heavy app metadata + IAP review flow - **v1 of this pipeline punts here** and SMS Tate "build live on App Store Connect, complete prod submission GUI". v2 will productize via macros.
10. **Smoke.** Tate verifies on physical device via TestFlight. Status_board moves to `verified-shipped`.

### What this instance reveals about gaps

- **IAP-specific pre-flight is NOT a generic capability.** Each IAP-bearing app needs its own `runbook.iap_pre_flight_checks` block. v1: hardcoded for Roam; v2: schema-defined.
- **Production submission for first-time apps is the v1 punt boundary.** Pipeline goes as far as "build live on App Store Connect"; the metadata + IAP submission is Tate-driven via the existing macro path.
- **Roam Android signing config absence** (release-candidate doc note 7) means `roam android internal-track` would fail at build. The runbook has to flag this explicitly OR the pipeline auto-dispatches a fork to add the signingConfigs block before the first Android build. Decision for the builder fork: add a "repo-readiness" pre-flight stage that can heal known repo gaps autonomously.

---

## Section 7 - Second Concrete Instance: Chambers Phase 2 Capacitor Wrap

Source: Chambers Phase 1 web shipped today (Episode "SCYCC Chambers Phase 1 shippable buildout - PR #2 (29 Apr 2026)"). Phase 2 is the Capacitor wrap, currently on branch `feat/capacitor-ios-wrap-2026-04-29` not merged. Bundle ID `au.ecodia.chambers`. ASC record + Play Console entry NOT yet created. Inherited Co-Exist build.gradle is broken (references `coexist-release.jks` and alias `coexist` - won't sign for Chambers).

### What a Chambers Phase 2 ship-to-TestFlight run looks like

1. **Intake.** Tate types "ship chambers ios testflight" or status_board edge fires.
2. **Runbook lookup.** `~/ecodiaos/runbooks/chambers.json`. Surfaces:
   - `app_record_state.ios: not_created` -> **HARD GATE**, pipeline SMS Tate with deep-link to ASC + new-app GUI checklist from `app-release-flow-new-app.md`. Aborts. Resumes on Tate flipping the runbook flag.
   - `branch.ios_capacitor_wrap_merged: false` -> hard gate, pipeline tries to auto-merge `feat/capacitor-ios-wrap-2026-04-29` if CI green AND change-class allows; else pauses on `awaiting-tate-review`.
   - `repo_gaps.android_build_gradle_inherited: true` -> if Android target requested, hard gate: pipeline auto-dispatches fork to fix build.gradle (replace `coexist-release.jks` with `chambers-release.jks`, alias `chambers`, env vars `CHAMBERS_KEYSTORE_PASSWORD/KEY_PASSWORD`) AND generate the chambers keystore. The keystore generation requires Tate to capture passwords (one-shot) and POST them to `creds.android.chambers`.
3. **Patch.** Fork-dispatch to:
   - (a) Author `~/workspaces/chambers/fe/ios/App/ExportOptions.plist` (matches Co-Exist template).
   - (b) Reset `versionCode=1`, `versionName="1.0"` in `android/app/build.gradle` (currently inherited as 6 / "1.6").
   - (c) Generate Chambers icon set + splash from primary brand asset (per `app-release-flow-new-app.md`).
4. **Test.** Same as Roam.
5. **Approval gate.** `approval.first_time_app.testflight: tate` -> Tate-confirm before building.
6. **Build + sign + upload.** SY094 macro path. Same template.
7. **Store-side.** First-time TestFlight - tester group must be created on ASC. Pipeline can do this via ASC API (path requires .p8); or surface to Tate.
8. **Smoke.** Tate on device.

### What this instance reveals

- **The new-app gate has to be a first-class concept.** Hardcoded "if `app_record_state.ios=not_created` SMS Tate with deep-link" is fine for v1; v2 productizes the new-app flow via Corazon macros (per `gui-macro-uses-logged-in-session-not-generated-api-key.md`) so even first-time submissions are autonomous.
- **Repo-readiness pre-flight is a real stage.** Multiple apps have known repo gaps that are not creds-blocked. The pipeline should auto-heal where the fix is mechanical (template files), surface where it's not (Tate decision: which build.gradle config block goes where).
- **Chambers's "inherited keystore" trap is the canonical example of why per-codebase runbooks beat heuristics.** A heuristic "if `android/app/build.gradle` exists then build" would have shipped a Co-Exist-signed Chambers AAB to Play - exact bug case. The runbook descriptor names the slug, the slug-keystore path, the slug-passwords env-var prefix; mismatch = build refused.

---

## Section 8 - Estimated Builder-Fork Scope

The **builder fork** that turns this spec into running code. Estimate assumes the existing primitives are usable.

### Dependencies (existing, must be stable)

- `~/ecodiaos/scripts/release.sh` (~795 LOC) - REUSE the build/sign/upload core; refactor into orchestrator-callable functions, do NOT rewrite.
- AppleScript drivers in `scripts/macros/` - REUSE.
- Macro registry on the laptop-agent (`xcode-organizer-upload`, `transporter-upload` already registered + dry-run-verified per status_board row 5654eccc).
- `mcp__forks__spawn_fork` for patch-layer dispatch (substitute for Factory CLI while paywalled).
- `mcp__factory__start_cc_session` once paywall lifts (or NOT - forks may end up the permanent path).
- Status_board, kv_store, Neo4j, Postgres - all live.
- SSH to SY094 + sshpass + rsync - working.
- Ecodia-api PM2 process - the orchestrator runs in-process.

### New code surface (rough LOC estimate)

| Component | Path | LOC | Complexity |
|-----------|------|-----|-----------|
| `releasePipelineService.js` | `src/services/releasePipelineService.js` | ~600-900 | Medium - state machine, request dispatch, runbook resolution |
| `releaseIntakeService.js` (email parser, chat-cmd parser, edge listener, cron) | `src/services/releaseIntakeService.js` | ~250-400 | Medium - 4 input sources |
| `releaseTestService.js` (lint/tsc/vitest/smoke wrapper) | `src/services/releaseTestService.js` | ~200-300 | Low - shells out to existing tools |
| Refactor of `scripts/release.sh` into callable phases | `scripts/release-phases/{preflight,build,sign,upload,store,smoke}.sh` | ~800 (mostly redistributing existing) | Medium - careful refactor, preserve behaviour |
| `releaseRoutes.js` (HTTP webhook + status endpoint) | `src/routes/release.js` | ~150 | Low |
| MCP tool surface (`release_dispatch`, `release_status`, `release_cancel`) | `src/mcp/release/*` | ~200 | Low - mirror existing MCP patterns |
| Runbooks for {coexist, roam, chambers, sidequests} | `~/ecodiaos/runbooks/*.{yaml\|json}` | ~50 each, 4 apps = 200 | Low - YAML authoring |
| Migrations (`release_requests` table, status_board indexes) | `migrations/059_release_requests.sql` | ~80 | Low |
| Tests (vitest) | `tests/release/*.test.js` | ~400-600 | Medium - state machine tests, mock SSH/macro dispatch |
| Doctrine pattern files (post-build) | `~/ecodiaos/patterns/release-pipeline-*.md` | 3-4 files, ~200 each | Low - written from observed reality |
| `~/ecodiaos/CLAUDE.md` cross-references | edit-only | ~30 lines added | Low |

**Total new code:** roughly 2,500-4,000 LOC plus ~400 LOC of refactor of existing release.sh. Two to four builder forks, sequenced per the phase plan below.

### Phasing (proposed, NOT mandatory)

**Phase 0** (pre-build, 1 fork, ~2 hours): Refactor `scripts/release.sh` into phase-scripts. No behaviour change. Verify via dry-run on Co-Exist.

**Phase 1** (1 fork, ~4-6 hours): `releasePipelineService` core + state machine + runbook loader + `coexist.yaml` runbook. CLI entry (`scripts/release-pipeline.sh ship coexist ios testflight`) + status_board row write. Skip patch layer, skip intake parsing - just take a request as JSON arg. Build, sign, upload, store-post-up via existing scripts. End-to-end Co-Exist iOS TestFlight ship through the orchestrator.

**Phase 2** (1 fork, ~3-4 hours): Intake layer. Email parser + chat-command parser + status_board state-edge listener. MCP tool surface (`release_dispatch`, `release_status`).

**Phase 3** (1 fork, ~3-4 hours): Patch layer. Fork-dispatch for code changes. PR creation, CI gate, auto-merge for routine change-class, gate-on-Tate for high-risk.

**Phase 4** (1 fork, ~2 hours): Roam runbook + first-time-app-gate handling + IAP-specific pre-flight checks. Ship Roam to TestFlight via the orchestrator.

**Phase 5** (1 fork, ~3 hours): Chambers runbook + repo-readiness auto-heal stage + new-app GUI deep-link surfacing. First Chambers TestFlight ship.

**Phase 6** (1 fork, ~3 hours): Production-submission v2. fastlane deliver wired. App Review questions read from runbook. TestFlight tester-group API. Play Console internal->prod promotion automation.

### Critical-path dependencies

- **Tate at SY094 GUI for one-time Xcode Apple ID login** (status_board row 5654eccc). Without this, the macro path fails at first dispatch and the pipeline forces fallback to altool which still works but defeats the GUI-macro doctrine.
- **`creds.android.coexist` populated** before Phase 1 can ship Android. iOS-only Phase 1 is fine.
- **Stability of macro registry on laptop-agent** - if macros change without `pm2 restart eos-laptop-agent` per the require-cache pattern, runs fail. Build the pipeline assuming this constraint and pre-flight `eos-laptop-agent` health every dispatch.
- **No new Factory CLI quota burn** - all builder forks via `mcp__forks__spawn_fork`. The 5/5 fork-slots-always rule applies.
- **Fork numbered-resource collisions** (per `parallel-forks-must-claim-numbered-resources-before-commit.md`) - migration numbers, branch suffixes, kv_store keys. Brief each builder fork to read the numbered space at write-time.

### What v1 MVP looks like

**The smallest useful thing:** Phases 0-1 only. Single CLI entry, single runbook (Co-Exist), no intake parser, no patch layer. Run as `scripts/release-pipeline.sh ship coexist ios testflight` and watch the status_board row transition through the full lifecycle. Tate-physical gates (Xcode login, Tate approval) work but are surfaced as SMS, not productized.

That alone closes status_board row d0092340 because it demonstrates the productized buildout architecturally - the "single orchestrator + per-codebase runbook + status_board lifecycle" - even if only one app is wired through it. Phases 2-6 are productization scope.

**Estimated wall time for v1 MVP:** one builder fork session, 4-6 hours focused work, Co-Exist iOS TestFlight as the first end-to-end ship.

**Estimated wall time for full Phase 6:** spread over ~1-2 weeks of background work in 5-fork rotation, so probably 2-3 weeks of calendar time given other priorities.

---

## Origin

Authored 2026-04-29 by fork `fork_mojt2x9l_19d23c` against the conductor brief to scope the productized release pipeline. Source material: status_board row d0092340-afc7-4a41-a1e7-3cc8933cd6d4 (the row id in the brief had a typo - actual id is d0092340-afc7-4a41 not d0092340-a1f7-4dc1, easy resolution via name match), `scripts/release.sh` (read in full, ~795 LOC), `clients/coexist.md`, `clients/release-candidate-analysis-2026-04-29.md`, `clients/app-release-flow-{ios,android,new-app}.md`, Neo4j Episodes "Co-Exist iOS TestFlight pipeline staged 2026-04-29 13:00 AEST" + 14 release-related Episodes from the last fortnight.

[APPLIED] /home/tate/ecodiaos/patterns/no-symbolic-logging-act-or-schedule.md - the artefact IS the deliverable; no "I considered scope" without file.
[APPLIED] /home/tate/ecodiaos/patterns/fork-by-default-stay-thin-on-main.md - cross-system scoping is multi-tool work, justified the fork.
[APPLIED] /home/tate/ecodiaos/patterns/no-retrospective-dumps-in-director-chat.md - structured doc + structured fork report; no narration in chat.
[APPLIED] /home/tate/ecodiaos/patterns/continuous-work-conductor-never-idle.md - 5/5 maintenance via the meta-conductor, this fork keeps a slot occupied.
[APPLIED] /home/tate/ecodiaos/clients/coexist.md - lighthouse instance for the pipeline; runbook authoring proposes coexist.yaml shape per the actual repo state.
[NOT-APPLIED] /home/tate/ecodiaos/docs/secrets/laptop-agent.md - no agent dispatch in this scoping fork; future builder fork will tag.
[NOT-APPLIED] /home/tate/ecodiaos/docs/secrets/laptop-passkey.md - no Windows GUI in scoping.
[NOT-APPLIED] /home/tate/ecodiaos/patterns/corazon-is-a-peer-not-a-browser-via-http.md - referenced but not driven in scoping.
[NOT-APPLIED] /home/tate/ecodiaos/patterns/corazon-puppeteer-first-use.md - no browser work.
[NOT-APPLIED] /home/tate/ecodiaos/patterns/drive-chrome-via-input-tools-not-browser-tools.md - no Chrome.
[NOT-APPLIED] /home/tate/ecodiaos/patterns/macros-record-mode-and-auto-author-from-runs.md - cited in spec but not authoring macros in this fork.
[NOT-APPLIED] /home/tate/ecodiaos/clients/corazon-peer-architecture-2026-04-29.md - referenced for Android Play Console fallback context only, not driven.
