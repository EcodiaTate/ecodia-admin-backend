# Phase 1 Macros: Shipped State vs. Doctrine Reconciliation

**Date:** 29 Apr 2026, 17:30+ AEST
**Author:** fork_mojqajrz_cf6fa6 (resume of fork_mojpge0a_3c7dcd)
**Tate authorized resume at:** 17:19 AEST 29 Apr 2026
**Doctrine update at:** 17:11 AEST 29 Apr 2026 (8 min before resume authorization)
**Doctrine file:** `~/ecodiaos/patterns/macros-record-mode-and-auto-author-from-runs.md`

## TL;DR

The prior fork (`fork_mojpge0a_3c7dcd`) shipped 6 hand-coded macros to Corazon at `D:\.code\eos-laptop-agent\macroHandlers\` AND updated `registry.json` to register them. All 11 macros (3 prior Phase 1 + 2 iOS + 6 from the brief) appear in `macroSuite.list`. The dispatch surface works.

**However** the same fork was hard-corrected by Tate at 17:11 AEST for shipping author-from-imagination handlers. The doctrine update added the **Phase 1 observation rule (NON-NEGOTIABLE)** and named macincloud-login as **permanently stub-only**.

The brief I was given to resume the fork was written before the 17:11 doctrine update. The brief's instructions ("author 6 macros, dry-run-verify each") are structurally in conflict with the new doctrine ("no author-from-imagination Phase 1 macros allowed").

This document reconciles the gap. The conductor (main) needs to decide whether to:

- **Option A:** Retract the 6 shipped handlers (replace with stub-only handlers), trust the recon docs, wait for Tate-recorded versions via Phase 2.
- **Option B:** Keep the shipped handlers but add observation gates (every first-run requires conductor screenshot-verify before subsequent uses) and treat them as "alpha quality, conductor-only, no autonomous dispatch."
- **Option C:** Schedule a Tate-supervised observation pass for the 5 Chrome macros (~30 min of Tate's hands) and update each handler to use observed selectors. macincloud-login still goes Phase 2.

This fork did NOT make this call. Marking [NEXT_STEP] in the report.

## What's actually on disk (verified 29 Apr 2026 17:35 AEST)

```
D:\.code\eos-laptop-agent\macroHandlers\
├── apple-signin.js            # prior Phase 1 - PROBABLY OK (used in real flows)
├── coexist-admin-signin.js    # prior Phase 1 - PROBABLY OK
├── common.js                  # shared helpers
├── index.js                   # registry loader
├── sshHelper.js               # SSH primitives for Mac flows
├── vercel-login.js            # prior Phase 1
├── xcode-organizer-upload.js  # iOS Phase 1, brief 15:25 AEST - SY094
├── xcode-organizer-upload.applescript
├── transporter-upload.js      # iOS Phase 1, brief 15:25 AEST - SY094
├── transporter-upload.applescript
├── macincloud-login.js        # SHIPPED 17:30 AEST - PERMANENTLY-STUB per 17:11 doctrine
├── macincloud-login.applescript
├── github-login.js            # SHIPPED 17:30 AEST - hardcoded coords {x:683, y:290}
├── stripe-dashboard.js        # SHIPPED 17:30 AEST - same pattern
├── gmail-send.js              # SHIPPED 17:30 AEST - same pattern
├── supabase-dashboard.js      # SHIPPED 17:30 AEST - same pattern
└── vercel-redeploy.js         # SHIPPED 17:30 AEST - same pattern
```

## Evidence the 6 shipped handlers are author-from-imagination

Reading `github-login.js`:

```js
// Coordinates assume Chrome window approximating 1366x768 (Corazon screen size).
// Drift detection is via screenshot inspection by the conductor.
const COORDS = {
  email_field:    { x: 683, y: 290 },
  password_field: { x: 683, y: 360 },
  autofill_row:   { x: 683, y: 420 },
  signin_button:  { x: 683, y: 430 },
  twofa_field:    { x: 683, y: 320 },
}
```

The handler's own comment then admits:

```js
// Step 3: type email/username (login_field is the GitHub field id).
// If page redirected away from /login, this clicks at the same coord but
// hits whatever element happens to be there. The conductor verifies via
// postScreenshot whether the field actually got input.
```

These coordinates have never been observed against a live screenshot. The doctrine's retraction is correct. The same pattern (hardcoded COORDS table, no recon doc, no live screenshot verification) applies to stripe-dashboard.js, gmail-send.js, supabase-dashboard.js, and vercel-redeploy.js by the same fork.

## Why I did NOT dry-run them

Per doctrine: "Hallucinated macros that fail at runtime cost more trust than recon-only macros that say 'I do not know yet, Tate please record.'" Dry-running a hallucinated handler that happens to land a click on the correct pixel by luck would generate false confidence. Dry-running one that lands on the wrong pixel would also be uninformative because there's nothing to fix without observation. The honest move is to NOT dry-run until the recon pass produces real coordinates.

## What this fork DID deliver

1. **6 recon docs** at `~/ecodiaos/drafts/<macro-name>-recon-2026-04-29.md` - one per shipped brief macro. Each names the page URL, the assumed coordinates, the observation steps required, and the failure modes the handler would exhibit if dispatched as-is.
2. **1 reconciliation doc** (this file) capturing the shipped-vs-doctrine gap and the three options for main.
3. **status_board P2 row** "Macros Phase 1 brief expansion: 6 hallucinated handlers shipped, recon-required before production trust" - notes the fork ID, list of macro names, doctrine conflict.
4. **Existing P1 row about Co-Exist iOS ship**: NOT changed. macincloud-login is permanently stub-only per doctrine; the iOS ship blocker stays Tate-required (Phase 2 record-mode is the unblock path, not author-from-imagination).
5. **Neo4j Episode** capturing the resume context, the doctrine conflict, and the option set for main.

## What this fork did NOT deliver

- Replacement of the 6 shipped JS handlers with stub-only versions. That is a destructive action requiring conductor sign-off (the handlers are loaded by macroSuite.list right now; removing them changes the dispatch surface). Flagged as [NEXT_STEP] for main.
- Live observation passes for the 5 Chrome macros. Requires Tate's hands at the Corazon console for each macro (~5 min each). Cannot be done from a fork.
- macincloud-login dry-run reaching 2FA pause. Per doctrine this macro is permanently stub-only; dry-run would test only the SSH path, not the AppleScript path, and the AppleScript path is the hallucinated layer.

## Cross-references

- Doctrine: `~/ecodiaos/patterns/macros-record-mode-and-auto-author-from-runs.md` (Phase 1 observation rule, lines 33-69)
- Architecture: `~/ecodiaos/drafts/macro-architecture-roadmap-2026-04-29.md`
- Prior fork that shipped: `fork_mojpge0a_3c7dcd` (errored on `out of extra usage`)
- Brief I resumed: passed in as the first user message of fork_mojqajrz_cf6fa6
- Tate's hard correction at 17:11 AEST is captured in the doctrine's Origin section

---

## Option A executed

**Timestamp:** 29 Apr 2026, 17:44 AEST (07:44 UTC).
**Fork id:** fork_mojquxhy_2a5b93.
**Action:** Replaced the 6 hallucinated macro handlers on Corazon (`D:\.code\eos-laptop-agent\macroHandlers\`) with stub-only versions that throw an explicit Phase-1-stub error on dispatch, pointing at `~/ecodiaos/patterns/macros-record-mode-and-auto-author-from-runs.md`.

**Files retracted (6):**
1. `macincloud-login.js` - PERMANENTLY STUB-ONLY per 17:11 AEST 29 Apr 2026 doctrine. Throw message names the permanent status. Sibling `macincloud-login.applescript` left on disk (documents the imagined flow; useful as a Phase 2 starting point if Tate ever re-greenlights).
2. `github-login.js`
3. `stripe-dashboard.js`
4. `gmail-send.js`
5. `supabase-dashboard.js`
6. `vercel-redeploy.js`

**Untouched (5 trusted prior-Phase-1 + iOS macros):** `apple-signin.js`, `coexist-admin-signin.js`, `vercel-login.js`, `xcode-organizer-upload.js` (+ `.applescript`), `transporter-upload.js` (+ `.applescript`), plus `common.js`, `index.js`, `sshHelper.js`.

**Brief deviation noted (and corrected):** the brief's stub template specified `async run() { throw ... }` as the entrypoint. The live agent dispatcher in `eos-laptop-agent` calls `handler.handle()`, not `handler.run()`. First write iteration produced stubs that errored with the generic `"handler.handle is not a function"` instead of the explicit Phase-1-stub message. Detected via the verification dispatch step. Stubs were rewritten to export both `handle` (the actual dispatcher contract) and a `run` alias that delegates to `handle`, so the explicit doctrine pointer reaches any caller regardless of which entrypoint convention they use. The trusted `apple-signin.js` confirms the `handle` contract.

**Verification log:**

1. `macroSuite.list` after restart - 11 macros register:
   ```
   count=11
     apple-signin
     vercel-login
     coexist-admin-signin
     xcode-organizer-upload
     transporter-upload
     macincloud-login
     github-login
     stripe-dashboard
     gmail-send
     supabase-dashboard
     vercel-redeploy
   ```

2. `macroSuite.run name=github-login` (post-restart) - throws cleanly:
   ```
   {"success":false,"error":"github-login is a Phase 1 stub. Run record-mode
   against the live UI with Tate present (or have Tate execute the flow
   once with the screen recorder running) to capture real selectors/coords.
   See ~/ecodiaos/patterns/macros-record-mode-and-auto-author-from-runs.md.",
   "duration_ms":0,"steps":0}
   ```

**Operational note:** because Node `require` caches modules at first load, the first dispatch attempt against the freshly-written stubs hung (the stale pre-write `github-login.js` module was still resident and tried to drive Chrome). One `pm2 restart eos-laptop-agent` cleared the cache. The agent restart count now reads 16; non-issue per the "restart counts only matter when accelerating rapidly" doctrine. Worth noting for Phase 2 record-mode work: any future stub/handler swap should include a planned PM2 restart, not just a file write.

**Registry note:** `macroSuite.list` returns macro descriptions from a separate registry (likely a JSON/YAML config inside the agent), NOT from the handler module's `description` export. The retracted handlers' `description` strings in the registry still show the original (imagined) descriptions. The new stub `description` only surfaces if a caller require()s the handler module directly. The registry stays inaccurate until either (a) the registry is updated, or (b) the registry is regenerated from the handler modules. Not blocking - the runtime throw is the canonical signal that these are stubs - but flagging for Phase 2.

**Phase 2 record-mode required for re-shipment** (5 of the 6 retracted macros):
- github-login
- stripe-dashboard
- gmail-send
- supabase-dashboard
- vercel-redeploy

Each needs Tate-supervised observation pass (~5 min hands-on per macro at Corazon) capturing real selectors/coords on the live Chrome UI before any of them can be re-authored. `macincloud-login` is permanently stub - the SY094 macro is bypassed by the trusted `xcode-organizer-upload` + `transporter-upload` SSH+AppleScript path that's already in production for iOS releases.
