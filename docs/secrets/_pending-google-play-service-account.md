---
triggers: google-play, play console, service-account, fastlane, supply, play-developer-api, android-upload, aab-upload, programmatic-android-upload, demoted-to-fallback
class: programmatic-required
owner: tate
---

# creds.google_play_service_account_json - PENDING (and demoted)

**Status: PENDING but DEMOTED to fallback under the GUI-macro doctrine.** A row would only need to exist if the unattended-upload path is being kept live; the primary path is now Play Console drag-drop via Tate's logged-in Chrome on Corazon.

## What it is

A Google Cloud service account JSON key, scoped to Play Developer API with Release Manager role. Used by `fastlane supply` and any other programmatic Play upload tool to publish AABs without a human GUI session.

## Source

- Play Console > Setup > API access > Service accounts
- Grant Release Manager role
- Download JSON key (one-time)

## Shape (would-be)

scalar string holding the full JSON key contents.

## Used by (will be, if kept live)

- `~/ecodiaos/scripts/release.sh:618` (Android upload branch)
- `~/ecodiaos/clients/app-release-flow-android.md:55, 209`
- `~/ecodiaos/clients/app-release-flow-new-app.md:249`

## Replaceable by macro?

YES, for the workflow. Per `~/ecodiaos/patterns/gui-macro-uses-logged-in-session-not-generated-api-key.md`:

| Path | What it does |
|---|---|
| Service account JSON + `fastlane supply` | Programmatic upload, no human in loop. Requires this credential. |
| Play Console drag-drop via Corazon Chrome | Macro path. Tate is logged in. No credential needed. |

The macro path is the default. This credential is provisioned ONLY if a true headless cron upload becomes a requirement (e.g. nightly internal-testing-track autodeploy without Tate's machine reachable).

## Rotation

Per Google Cloud policy. Service account keys can be rotated; old keys revokable in GCP console.

## Provisioning decision

Default: **don't provision.** The macro path is the documented primary. Author the upload macro (`play-console-upload` AHK macro on Corazon, or screenshot+input on Mac) and skip this credential.

If it ever IS provisioned:
1. Play Console > Setup > API access > Service accounts > Create service account.
2. Grant Release Manager role.
3. Download JSON key.
4. Tate UPSERTs the full JSON contents into `kv_store.creds.google_play_service_account_json`.

## Failure mode while pending

`scripts/release.sh` Android branch's programmatic upload step errors at preflight (with the credential). If the macro path is used (default), the lack of this row is correct.
