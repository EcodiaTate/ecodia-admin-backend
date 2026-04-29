# vercel-redeploy - Recon (RECON-REQUIRED)

**Date:** 29 Apr 2026
**Author:** fork_mojqajrz_cf6fa6
**Doctrine status:** Phase 1 observation rule violation - Vercel deployments-page UI never observed.
**Shipped state:** `D:\.code\eos-laptop-agent\macroHandlers\vercel-redeploy.js` exists. Registered. Dispatch-callable.
**Recommended action:** schedule live observation pass with Tate's hands OR retract.

## What this macro is supposed to do

Trigger "Redeploy" on the most recent deployment of a Vercel project. Useful when an env-var change needs a fresh build with the same source (no git push needed).

Two URL paths the registry supports:
- Deployments page: `https://vercel.com/<org>/<project>/deployments` - click "..." menu on most recent deploy, click "Redeploy"
- Production overview: `https://vercel.com/<org>/<project>` with `use_production_overview=true` - different button affordance

## What proper recon would require

1. Drive Tate's existing Chrome (Default profile) to a real Vercel project deployments page (e.g. `https://vercel.com/ecodiatate/ecodiaos-frontend/deployments`).
2. Capture initial screenshot. Save to `~/ecodiaos/drafts/vercel-redeploy-page-2026-04-29.png`.
3. Identify pixel coordinates of:
   - The first row's "..." (kebab menu) button.
   - The "Redeploy" menu item that appears after click.
   - The confirm dialog's "Redeploy" button.
4. For the alternate path (`use_production_overview=true`):
   - Drive to `https://vercel.com/<org>/<project>` overview.
   - Identify the "Redeploy" button on the production card.
   - Capture confirm dialog coordinates.
5. Update vercel-redeploy.js with observed coordinates.

## Risk if dispatched as-is

This macro could click the wrong menu item or trigger the wrong project's redeploy if coordinates are off. Vercel's menu items are dense (Promote, Rollback, View Logs, Inspect, Delete, Redeploy) - one wrong-pixel click could be destructive.

## Alternative: use the Vercel API instead

`mcp__business-tools__vercel_trigger_deploy` already exists. It's API-driven, deterministic, and doesn't need Tate's auth state. Per the GUI-macro-vs-API-key doctrine (`~/ecodiaos/patterns/gui-macro-uses-logged-in-session-not-generated-api-key.md`), GUI macros are preferred when both work - but for Vercel the API path is already wired up and provably correct. Recommend keeping the GUI macro as a fallback for cases the API doesn't cover (e.g. Pro-tier-only redeploy options) and defaulting to the API call for routine redeploys.

## Status

- Handler shipped, dispatch-callable, MEDIUM-HIGH RISK if dispatched without recon (Vercel UI click could land on Delete instead of Redeploy).
- Recon-required: ~5 min of Tate's hands at Corazon.
- API alternative exists for the routine case.
- This fork: did NOT execute the recon.

## Cross-references

- Handler source: `D:\.code\eos-laptop-agent\macroHandlers\vercel-redeploy.js`
- API alternative: `mcp__business-tools__vercel_trigger_deploy`
- Doctrine: `~/ecodiaos/patterns/macros-record-mode-and-auto-author-from-runs.md`
- GUI-vs-API doctrine: `~/ecodiaos/patterns/gui-macro-uses-logged-in-session-not-generated-api-key.md`
- Reconciliation: `~/ecodiaos/drafts/macro-phase1-shipped-vs-doctrine-reconciliation-2026-04-29.md`
