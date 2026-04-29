# stripe-dashboard - Recon (RECON-REQUIRED)

**Date:** 29 Apr 2026
**Author:** fork_mojqajrz_cf6fa6
**Doctrine status:** Phase 1 observation rule violation - hardcoded coords never observed against live Stripe layout.
**Shipped state:** `D:\.code\eos-laptop-agent\macroHandlers\stripe-dashboard.js` exists. Registered. Dispatch-callable.
**Recommended action:** schedule live observation pass with Tate's hands OR retract.

## What proper recon would require

1. Drive Tate's existing Chrome (Default profile - the workspace tate@ecodia.au profile) to https://dashboard.stripe.com via `input.shortcut [ctrl, l]` + `input.type` + `input.key enter`.
2. Capture initial-state screenshot. Save to `~/ecodiaos/drafts/stripe-dashboard-page-2026-04-29.png`.
3. Determine landed state: dashboard (logged in, autofill not needed) vs login form (logged out).
4. If login form: identify true pixel coordinates of email_field, password_field (if visible), autofill_row, signin_button. Capture screenshot of each step.
5. If 2FA challenge appears: capture coordinates of OTP input.
6. Update COORDS table in stripe-dashboard.js with observed values.
7. Add screenshot-verify step between clicks.

## Likely current state on Corazon

Tate's Default Chrome profile probably has an active Stripe session - in which case nav lands on the dashboard with no login UI to drive. The handler's login flow would never need to fire. But the handler doesn't differentiate: it dispatches the click sequence regardless.

A proper handler would:
- Probe URL via post-nav screenshot.
- If `dashboard.stripe.com/<acct_id>/...` loaded - return `{ok: true, state: 'logged_in'}`.
- Only if redirected to `/login` - drive the autofill flow.

## Status

- Handler shipped, dispatch-callable, will execute click sequence even when no login UI is present (potentially clicking wrong elements on the live dashboard).
- Recon-required: ~3 min of Tate's hands at Corazon + a fork to add the logged-in/logged-out branching + observed COORDS.
- This fork: did NOT execute the recon.

## Cross-references

- Handler source: `D:\.code\eos-laptop-agent\macroHandlers\stripe-dashboard.js`
- Doctrine: `~/ecodiaos/patterns/macros-record-mode-and-auto-author-from-runs.md`
- Reconciliation: `~/ecodiaos/drafts/macro-phase1-shipped-vs-doctrine-reconciliation-2026-04-29.md`
