# gmail-send - Recon (RECON-REQUIRED)

**Date:** 29 Apr 2026
**Author:** fork_mojqajrz_cf6fa6
**Doctrine status:** Phase 1 observation rule violation - the Gmail compose UI was not observed before the handler was authored.
**Shipped state:** `D:\.code\eos-laptop-agent\macroHandlers\gmail-send.js` exists. Registered. Dispatch-callable.
**Recommended action:** schedule live observation pass with Tate's hands OR retract.

## Why this one is particularly fragile

Gmail's compose dialog:
- Is a floating modal, not a fixed page layout.
- Coordinates depend on viewport AND on whether the inbox is in single-pane / split-pane / preview-pane mode.
- The To/Cc/Bcc/Subject/Body fields each have variable layout depending on whether Bcc/Cc are expanded.
- The Send button moves based on the modal's vertical position which depends on email body length.

Hardcoded pixel coordinates for this UI will rot within days. A robust gmail-send macro requires either:

- (a) Gmail keyboard shortcuts (`c` to compose, Tab between fields, `cmd/ctrl+enter` to send) - far more stable than coordinates.
- (b) Drive Gmail via `browser.evaluate` to manipulate the DOM directly (but the brief mandates input.* per drive-chrome doctrine).
- (c) Observation-driven, screenshot-anchored find-and-click using image template matching (out of scope for Phase 1).

The current handler likely uses (a) but the prior fork's keyboard shortcut sequence was author-from-imagination.

## What proper recon would require

1. Drive Tate's existing Chrome to https://mail.google.com (Default = workspace tate@ecodia.au profile).
2. Verify the inbox loads with Tate logged in. Capture screenshot.
3. Send `c` keyboard shortcut to open compose. Capture screenshot of the compose modal.
4. Identify the actual keyboard shortcut sequence to navigate to/cc/bcc/subject/body that works with Tate's current Gmail layout.
5. Document any quirks (e.g. Gmail's "scheduled send" vs "send" buttons, the "are you sure?" prompt for short emails).
6. Update gmail-send.js with the verified shortcut sequence.

## Status

- Handler shipped, dispatch-callable.
- HIGH-RISK if dispatched without recon: could send a malformed email or fail silently mid-compose.
- Recon-required: ~10 min of Tate's hands at Corazon + a fork to update the handler.
- This fork: did NOT execute the recon.

## Cross-references

- Handler source: `D:\.code\eos-laptop-agent\macroHandlers\gmail-send.js`
- Doctrine: `~/ecodiaos/patterns/macros-record-mode-and-auto-author-from-runs.md`
- Reconciliation: `~/ecodiaos/drafts/macro-phase1-shipped-vs-doctrine-reconciliation-2026-04-29.md`
- Note: most outbound email should still go via `mcp__google-workspace__gmail_send` (Workspace API, deterministic), NOT this macro. The macro is for cases where the API path doesn't apply (e.g. Tate-account-only emails, complex formatting).
