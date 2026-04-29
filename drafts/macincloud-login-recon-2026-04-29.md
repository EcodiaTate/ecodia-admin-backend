# macincloud-login - Recon (PERMANENTLY STUB-ONLY)

**Date:** 29 Apr 2026
**Author:** fork_mojqajrz_cf6fa6
**Doctrine status:** PERMANENTLY STUB-ONLY per `~/ecodiaos/patterns/macros-record-mode-and-auto-author-from-runs.md` (Phase 1 observation rule, line 67-69)
**Shipped state:** handler exists at `D:\.code\eos-laptop-agent\macroHandlers\macincloud-login.js` + `.applescript` companion. Registered in `registry.json`. Returned by `macroSuite.list`.
**Recommended action:** retract / replace with stub-only handler.

## Why permanently stub-only

Per doctrine: "Apple 2FA flow + Xcode Settings UI + remote macOS via SSH+osascript is THREE non-trivial layers stacked. AppleScript-driven Xcode UI is especially fragile (UI tree changes per Xcode point-release, Settings layout drifts, Accounts pane sub-layout drifts). The macincloud-login macro is permanently stub-only until Tate records it via Phase 2 with his hands at the SY094 VNC console."

## What was shipped (author-from-imagination layers)

1. SSH path via `ssh2` npm package on Corazon - PROBABLY OK (mechanical, testable with `stage_only=true`)
2. AppleScript at `~/.../macincloud-login.applescript` to drive Xcode > Settings > Accounts UI - HALLUCINATED (no observation of the Xcode 26.3 Settings pane on SY094)
3. The pause-point convention "AppleScript exits with stdout 'OK PAUSED_AT_PASSWORD email=<email>'" - HALLUCINATED (no recorded run to validate the marker)
4. The keychain-persistence claim "Xcode keychain holds session ~30 days" - UNVERIFIED ASSUMPTION

## What proper recon would require

This is what the Phase 2 record-mode pass needs to capture (not this fork's job):

1. Tate at SY094 VNC console.
2. Tate runs `macroSuite.startRecording {name: "macincloud-login"}`.
3. Tate clicks Xcode in dock. Xcode opens.
4. Tate hits Cmd+Comma. Xcode Settings opens.
5. Tate clicks "Accounts" tab. Pane changes.
6. Tate clicks "+" button. Add-account dialog opens.
7. Tate clicks "Apple ID". Email field appears.
8. Tate types `code@ecodia.au`.
9. Tate clicks Continue. Password field focuses.
10. Tate types Apple ID password (PASSWORD-REDACTED in recording).
11. Tate clicks Continue. Apple sends 2FA push to iPhone.
12. Tate enters 6-digit 2FA code (CODE-REDACTED in recording).
13. Tate clicks Continue. Account lands in Xcode keychain.
14. Tate runs `macroSuite.stopRecording`.

Phase 2's draftWriter consumes the buffer, redacts password + 2FA, emits a runnable handler. That handler is the trustworthy macincloud-login.

## Cross-references

- Doctrine: `~/ecodiaos/patterns/macros-record-mode-and-auto-author-from-runs.md`
- MacInCloud access pattern: `~/ecodiaos/clients/macincloud-access.md`
- macincloud creds: `~/ecodiaos/docs/secrets/macincloud.md` (kv_store: `creds.macincloud`)
- Phase 2 dispatch readiness: `~/ecodiaos/drafts/macro-architecture-roadmap-2026-04-29.md` Brief A
- Co-Exist iOS ship blocker (the consumer of this macro): status_board P1 row

## Status

- Shipped handler: present, NOT trusted, dispatch-callable but will fail at the AppleScript step.
- Permanent classification: stub-only.
- Unblock path: Phase 2 ships, Tate records this flow, draftWriter emits the real handler.
- This fork: DOES NOT replace the shipped handler. That's a destructive action for main to authorize.
