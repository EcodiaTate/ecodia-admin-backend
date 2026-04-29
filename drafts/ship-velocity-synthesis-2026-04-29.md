# Ship Velocity Synthesis - 29 Apr 2026

Author: fork_mojrse37_503a4b (strategic synthesis fork, 18:05 AEST window)
Method: cross-system probe across git (5 repos), Neo4j (last 22h Decisions/Patterns/Episodes), os_forks table (109 forks started in window), kv_store day plan, status_board active rows.

---

## 1. What shipped

**ecodiaos-backend (24 commits to main, 22h window):**
- `cd46340` iOS upload via GUI macros - xcode-organizer-upload + transporter-upload (PR #15)
- `5955cd6` doctrine: GUI macros replace API keys for autonomous releases (PR #14)
- `c8749bd` doctrine: three-phase macro architecture (PR #13)
- `071220b` brief-consistency hook - outreach-prep + drafting-only negation guards (PR #12)
- `f6219f4` release.sh end-to-end driver script - ios+android, creds-driven, fail-loud (PR #11)
- `ace177a` doctrine: continuous-work conductor (PR #10)
- `b473b08` doctrine: drive Chrome via input.* + screenshot, not browser.* (PR #9)
- `e3557cd` hooks: fork-by-default-nudge mechanical enforcement (PR #8)
- `a16e400` brief-consistency hook tuning + 5 new pattern files
- `fe3a010` brief-consistency hook false-positive class fix (PR #7)
- `5d7794c` invoice-payment-state-producer-feed query rewrite (PR #6)
- `e4bd2a7` forkService - await _dbUpdate at 3 sites + warn upgrade (resolves overnight stuck-in-spawning, PR #5)
- `091a051` listeners: wire email_events producer in gmailService.processThread (PR #4)
- `42b06e6` enable 1M context for opus-4-7 (compaction at ~767k not ~167k, PR #2)
- Plus 7 doctrine + visual-verify pattern commits (Episode 3609 follow-ups)

**ecodiaos-frontend (10 commits to main, 22h window):**
- `ca01038` ExportOptions.plist for autonomous TestFlight (PR #14)
- `cb9ba45` leader/tasks Samsung/Android bugs - blank tab, keyboard hides Save, OK overcompletes (PR #13)
- `d1728a1` excel-sync definitive sheet ↔ DB reconciliation - alias map + synthetic guard + monitoring (PR #12)
- `fdaaab9` excel-sync link Forms-synthetic impact to app-created events (PR #11)
- `f2313e6` card focal-point position forwarded through list-view callers (PR #9)
- `49f674a` vite base path fix for SPA routes /events/new and /admin/* (PR #10)
- `1b6ac3e` remove orphan /map page (PR #7)
- `f7a6096` surveys auto-derive event_impact from survey responses (PR #8)
- `6c04cf1` map pin North East Victoria collective on member map (PR #6)
- `913dc04` chat emoji reactions on messages (PR #5)

**chambers (4 commits to main, 22h window):**
- `8a1293f` welcomemodal SSR mount fix - useState/useEffect pattern (PR #4) [Roam-side fix in chambers repo by mistake or shared - clarification needed]
- `bd27e38` purchase escape link during polling + haptic web guard (PR #3)
- `8868d73` login Apple Sign-In gated to iOS only (PR #2)
- `cd919b1` account /account guarded behind AuthGate, prevents unauth Delete-account exposure (PR #1)

**Doctrine (pattern files authored today, 5+ confirmed by commit `a16e400` + later commits):**
- `~/ecodiaos/patterns/macros-learn-by-doing-vision-first-run-with-question-surface.md` (Tate redirect 17:55 AEST)
- `~/ecodiaos/patterns/graceful-credit-exhaustion-handling.md` (Tate flag 17:19 AEST)
- `~/ecodiaos/patterns/code-at-ecodia-au-is-only-google-workspace-and-claude-max.md` (Tate correction 17:44 AEST)
- `~/ecodiaos/patterns/continuous-work-conductor-never-idle.md` (Tate 14:35 AEST + 17:03 third-strike addendum)
- `~/ecodiaos/patterns/fork-by-default-stay-thin-on-main.md` (Tate 13:17 AEST)
- `~/ecodiaos/patterns/drive-chrome-via-input-tools-not-browser-tools.md` (Tate 14:32 AEST)
- `~/ecodiaos/patterns/decision-quality-self-optimization-architecture.md` (canonical 7-layer reference)
- Plus 5 brief-consistency-hook + visual-verify pattern files (Episode 3609 cluster)

**Telemetry / observability:**
- Phase B (Layer 4) of Decision Quality Architecture SHIPPED (fork_mojnrqs8 + fork_mojpf9sm recovery): dispatch_event/surface_event/application_event/outcome_event tables, JSONL → 15min batch consumer → Postgres pipeline, /api/telemetry/decision-quality endpoint, decision-quality-drift-check cron.
- Phase A (Layer 2 priority/canonical ranking) SHIPPED via resume fork_mojqc5j1_6cf5bd: 103/103 patterns + 11/11 clients + 23/23 docs/secrets tagged with triggers; all 4 surfacing hooks emit 1 PRIMARY + up to 3 ALSO + tail.

**Fork stats (109 forks started 22h window):** 85 done, 9 spawning (active), 8 errored (all credit-exhaustion at ~17:14 AEST), 5 aborted (orphaned by overnight ecodia-api restart), 2 running.

---

## 2. What learned (5 generalisable doctrine items)

1. **Three-strike doctrine pressure landed three top-of-file P1 directives in a single day** (fork-by-default 13:17 → conductor-never-idle 14:35 → 5-forks-always 17:03). The pattern: when Tate states the same correction in different framings within a fortnight, mechanical enforcement (PreToolUse hooks) ships within hours of the third strike, not after a meeting. Codified in `~/ecodiaos/patterns/recurring-drift-extends-existing-enforcement-layer.md`. The 5-forks-always strike already has a recon doc (`fork-slot-empty-warn-hook-recon-2026-04-29.md`); fourth strike auto-ships the hook regardless of approval cycle.

2. **Mid-flight correction reach is the architecture's tightest feedback loop.** Tate's 17:44 AEST GitHub correction (one of three concurrent forks was implicitly trying to log into a `code@` GitHub account that doesn't exist) landed via `mcp__forks__send_message` injection into all 3 running forks within 90s + a pattern file authored within 3 minutes (`code-at-ecodia-au-is-only-google-workspace-and-claude-max.md`). This is faster than any meeting-based correction loop because (a) forks are addressable individually mid-execution, (b) the codify-at-the-moment-stated rule auto-routes the correction into doctrine, (c) the surface-injection hooks make sure the correction surfaces on next dispatch. The architectural prerequisite: forks must be running concurrently for mid-flight correction to be cheaper than re-dispatch.

3. **Hallucinate-then-retract is detectable cleanly when the artefact is on-disk and inspectable, not when it's only in conversation.** Macros Phase 1 shipped 6 hand-coded handlers with hallucinated coordinate tables (e.g. `github-login.js {x:683, y:290}`). The hallucination was catchable because (a) the handler files lived on Corazon at known paths, (b) the handler's own comments admitted the coords were never observed, (c) `macroSuite.list` exposes runtime registry. fork_mojquxhy_2a5b93 retracted by replacing each with an explicit Phase-1-stub throw - canonical signal at runtime even though the registry descriptions stayed stale. The doctrine: never trust an artefact whose verification path is "I'll dry-run it" - either observe-then-codify (Phase 2/3 macro doctrine, then superseded by 17:55 learn-by-doing redirect) or stub-and-stop. Pattern: the hallucinate path is detectable when the handler self-documents its assumptions.

4. **Credit-exhaustion + autoswitch + manual-resume - infra worked, doctrine had to land afterwards.** The 5-fork wave 16:59-17:10 AEST all errored on `out of extra usage · resets 8:10am UTC`. Autoswitch between tate@ and code@ Claude Max accounts handled the NEXT dispatch wave correctly, but the original 5 errored hard with no resumable=true flag, no resume_fork_id, no status_board surface. Tate's 17:19 directive ("autoswitch worked perfectly so should be fine to resume them, need to handle that more gracefully next time") explicitly named the gap as doctrine-level not infra-level. Pattern shipped same day (`graceful-credit-exhaustion-handling.md`); implementation pending in status_board P2 row. Doctrine = artefact, mechanism = follow-up work. The point: working infra without doctrine = next-time-Tate-has-to-flag-it; doctrine without follow-up implementation = next-time-mechanism-still-not-there. Both are required.

5. **The forking architecture compounds doctrine velocity by an order of magnitude.** 109 forks dispatched in a 22-hour window, 85 completed cleanly. Average end-to-end fork time ~5-15 min. The conductor-on-main wrote zero code today (confirmed by git author analysis - all PRs landed via fork-dispatched Factory or fork-direct work). This is the answer to "why fork-by-default": at 5/5 active forks, throughput is bounded by Tate's input rate + Claude Max credit cap, not by main-conductor token budget. Today proved the model: when Tate types one correction at 17:44, three forks absorb it; when one mistake is found at 17:11 (macro hallucination), one retract-fork ships the fix while four other forks ship unrelated work.

---

## 3. What's compounding

- **Phase A surfacing (shipped today) makes Phase C tag forcing functional** - the priority-ranked surface lines (PRIMARY/ALSO/tail) are what Phase C's `[APPLIED]` / `[NOT-APPLIED]` tags reference. Without Phase A, tag forcing has nothing canonical to point at.
- **Phase B telemetry (shipped today) makes Phases D + E + G measurable** - dispatch_event/surface_event/application_event/outcome_event are the pipes that future outcome correlation, per-primitive perf, and adversarial self-audit all consume. Today's 3/7 layers shipped is a 3x leverage move because the remaining 4 layers reuse the same telemetry infrastructure.
- **Mechanical hooks (fork-by-default, brief-consistency, cred-mention-surface, status-board-write-surface, doctrine-edit-cross-ref-surface, post-action-applied-tag-check) all feed model-visible PreToolUse/PostToolUse warnings** - each hook authored today raises the floor on conductor behaviour without raising token cost. The compounding shape: each hook protects against a specific known drift, the catalogue of hooks grows monotonically, drift modes already prevented stay prevented across session restarts.
- **GUI macros + iOS upload macros + release.sh driver shipped together = one-Tate-action-from-autonomous-release** - the Co-Exist iOS TestFlight pipeline now needs only Tate's one-time Xcode login on SY094 (saved in keychain ~30 days). After that one action, scripts/release.sh coexist ios testflight runs end-to-end. This compounds because: (a) the same pipeline applies to Roam, Chambers iOS wrap, future products; (b) the GUI-macro doctrine (kv_store secrets file `gui-macro-uses-logged-in-session-not-generated-api-key.md`) supersedes API-key generation as the default for any GUI-accessible vendor.
- **Codify-at-the-moment-stated discipline shipped 4 doctrine files within ~30 min of the originating Tate correction** (13:17 fork-by-default, 14:32 drive-chrome-via-input, 14:35 conductor-never-idle, 17:03 5-forks-always, 17:44 code@-vendor-identity, 17:55 macros-learn-by-doing). This is durable across session restarts in a way conversational acknowledgements are not.

**One-off (NOT compounding):** the macro Phase-1 retraction itself is a one-off cleanup; the future-proofing is the learn-by-doing doctrine that supersedes it. The 24 ecodiaos-backend commits include a few small bugfix-y ones (invoice-payment-state-producer-feed, forkService DB persistence) that don't compound but were necessary clearance work.

---

## 4. What's still wrong

- **Mechanical credit-exhaustion handling is doctrine-only, not implemented.** Status_board P2 row "Mechanical credit-exhaustion handling - implementation" lists 6 unimplemented steps (detect/classify, schema add, auto-resume, anti-flood backoff, telemetry, status_board surface). Next credit-exhaustion wave will be exactly as bad as today's was without this.
- **Cron-fire + Tate-message context-injection is recon-only.** Brief-consistency hooks fire on fork dispatch + Factory dispatch, but the same surfacing for cron-fire prompts (in `schedulerPollerService.fireTask`) and Tate-message ingress (in `osSessionService._sendMessageImpl`) is documented but not implemented (status_board P2). Means: doctrine surfaces when I dispatch a fork, but NOT when a cron wakes me with a generic prompt or Tate sends a fresh message.
- **Switch profile stub is unimplemented + the doctrine that supersedes it (learn-by-doing) needs primitives that don't exist yet** (vision.locate, question.surface, runbook.save/load). 5 retracted Chrome macros (github-login, stripe-dashboard, gmail-send, supabase-dashboard, vercel-redeploy) all sit in stub state. The path forward shifted twice today (calibration → record-mode → learn-by-doing); none of those 3 paths has shipped working primitives yet.
- **Co-Exist iOS TestFlight ship is one Tate action away but not autonomous.** Tate must connect to SY094 via VNC/RDP and sign in to Xcode > Accounts once. Status_board P1. Until that lands, the productized release pipeline is not validated end-to-end.
- **9 forks still in `spawning` status as of synthesis time** - some may be the genuinely active concurrent forks (this synthesis fork + day-end gap audit + status board sweep + credit-exhaustion verify + others), but stale `spawning` rows are also a known telemetry drift (no automatic state-stuck cleanup). Should be cleared before bed.
- **The Conservation Platform packaging decision (4 calls) sits at next_action_by=tate.** Decision one-pager shipped at `~/ecodiaos/drafts/conservation-platform-rebrand/packaging-decision-one-pager-2026-04-29.md` with autonomous defaults (register trellis.com.au, use hybrid pricing in internal drafts only, HOLD Landcare relay, lighthouse stays branded as itself) firing EOD 30 Apr AEST if no Tate response. The Landcare hook in particular goes stale in 4-6 weeks per the Carbon-MRV recon.
- **Status_board has 123 active rows.** Drift accumulation is real - fork_mojrqspj_e54bcc is currently running an archival sweep but hasn't reported yet. If it lands clean tonight, board should drop to ~80-100 active.

---

## 5. Tomorrow's first action

**Check kv_store + tate@ inbox for Tate's Apple Xcode-login confirmation. If landed: dispatch `scripts/release.sh coexist ios testflight` immediately (~25-40 min wall, fully autonomous via xcode-organizer-upload + transporter-upload macros, ASC API key fallback retained behind IOS_UPLOAD_FALLBACK_TO_ALTOOL=1).** This single action validates the full productized release pipeline end-to-end for the first time, unblocks the Co-Exist iOS P1 status_board row, and proves the GUI-macro doctrine that supersedes API-key generation. If Tate hasn't logged in yet: the second-highest-leverage move is to dispatch the mechanical credit-exhaustion handling implementation fork (status_board P2 row, doctrine already shipped, brief is the 6-step list inside the pattern file). Both are forkable; the first should run as the morning meta-loop's first dispatch.

---

End synthesis.
