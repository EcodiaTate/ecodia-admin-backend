# supabase-dashboard - Recon (RECON-REQUIRED)

**Date:** 29 Apr 2026
**Author:** fork_mojqajrz_cf6fa6
**Doctrine status:** Phase 1 observation rule violation - GitHub OAuth flow + Supabase landing page never observed.
**Shipped state:** `D:\.code\eos-laptop-agent\macroHandlers\supabase-dashboard.js` exists. Registered. Dispatch-callable.
**Recommended action:** schedule live observation pass with Tate's hands OR retract.

## What proper recon would require

1. Drive Tate's existing Chrome (Default profile) to https://supabase.com/dashboard.
2. Capture initial screenshot. Save to `~/ecodiaos/drafts/supabase-dashboard-page-2026-04-29.png`.
3. Determine landed state:
   - **Logged in** (most likely): lands on `/projects` listing or last-viewed project.
   - **Logged out, GitHub OAuth available**: redirected to `/sign-in` showing "Continue with GitHub" button.
   - **Logged out, email/password**: same `/sign-in` page, "Sign in with email" button.
4. For the GitHub OAuth path (default per registry):
   - Click "Continue with GitHub". Capture screenshot.
   - Verify GitHub authorize flow appears (or auto-accepts if Tate previously authorized Supabase).
   - Capture coordinates of the "Authorize" button if it appears.
5. For the email/password path (`use_github=false`):
   - Click "Sign in with email". Capture screenshot.
   - Identify email/password coordinates.
   - Identify autofill-row coordinates (Chrome autofill).
6. Update supabase-dashboard.js with observed coordinates.
7. Note: this macro depends on `github-login` working first if the GitHub session has expired - chain dependency, document explicitly.

## Most likely live state on Corazon

Tate's Default Chrome probably has an active Supabase session. Like stripe-dashboard, the macro doesn't differentiate. A proper handler would no-op when already logged in.

## Chain dependency

If `use_github=true` (default) AND GitHub session is expired, the macro depends on the github-login macro being functional. Both are currently recon-required, so the dependency chain is broken until both have observation passes.

## Status

- Handler shipped, dispatch-callable, will execute click sequence regardless of landed state.
- Recon-required: ~5 min of Tate's hands at Corazon.
- This fork: did NOT execute the recon.

## Cross-references

- Handler source: `D:\.code\eos-laptop-agent\macroHandlers\supabase-dashboard.js`
- Chained macro: `~/ecodiaos/drafts/github-login-recon-2026-04-29.md`
- Doctrine: `~/ecodiaos/patterns/macros-record-mode-and-auto-author-from-runs.md`
- Reconciliation: `~/ecodiaos/drafts/macro-phase1-shipped-vs-doctrine-reconciliation-2026-04-29.md`
