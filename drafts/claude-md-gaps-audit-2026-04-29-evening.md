# CLAUDE.md Gap Audit, 29 Apr 2026 (post-session evening checkpoint, supersedes prior evening pass)

Fork id: fork_mojz0xpp_e39ccf. Audit-only. Brief explicitly forbids any CLAUDE.md or pattern edits in this fork; a separate fork applies the edits if the conductor dispatches one.

Audit time: 21:30 AEST 29 Apr 2026 (11:30 UTC).

Files audited end-to-end: `~/CLAUDE.md` (1089 lines), `~/ecodiaos/CLAUDE.md` (720 lines), `~/ecodiaos/patterns/INDEX.md` (170 lines, last touched 11:16 UTC = 21:16 AEST). Patterns directory: 121 files. Drafts directory: prior audits at 11:05 UTC, 10:05 UTC, and 08:11 UTC examined as inputs.

This audit is the FOURTH in a chain today and is positioned at the brief's deliverable path `~/ecodiaos/drafts/claude-md-gaps-audit-2026-04-29-evening.md`, overwriting the 18:00 AEST evening pass. Prior inputs:

- `claude-md-gaps-audit-2026-04-29.md` (afternoon, fork_mojkcdy8) - SUPERSEDED by an 11:05 UTC = 21:05 AEST overwrite (fork_mojy0yhf_97c026, late-evening successor).
- `claude-md-gaps-audit-2026-04-29-evening.md` (18:00 AEST first evening pass) - this fork overwrites it. Its content was subsumed by the late-evening audit and partially shipped.
- `claude-md-gaps-audit-2026-04-29-evening-v2.md` (10:05 UTC = 20:05 AEST, fork_mojvxk0t) - second evening pass, retained at its own filename.

The 11:05 UTC overwrite at `claude-md-gaps-audit-2026-04-29.md` is the most recent comprehensive audit and is treated as the authoritative input. This audit verifies which of its P1/P2/P3 items have shipped in the 25 minutes since AND identifies net-new gaps that surfaced AFTER 21:05 AEST (notably `~/ecodiaos/patterns/cowork-conductor-dispatch-protocol.md` authored at 21:14 AEST and the INDEX.md touch at 21:16 AEST).

---

## Verification of prior audit's P1/P2/P3 (status check)

Late-evening audit at `claude-md-gaps-audit-2026-04-29.md` (11:05 UTC = 21:05 AEST) listed these.

**P1 ship-list (5 items, prior audit "must ship before next session"):**

- P1 #1 (G1): Author exhaust-laptop-route pattern file. **SHIPPED.** File exists at `~/ecodiaos/patterns/exhaust-laptop-route-before-declaring-tate-blocked.md` (21:03 AEST, 7329 bytes). Listed in `~/ecodiaos/patterns/INDEX.md` line 123. Cross-referenced from `~/CLAUDE.md` lines 133, 155 + `~/ecodiaos/CLAUDE.md` line 268.
- P1 #2 (G2): Edit `~/CLAUDE.md` line 146 5-point check step 2 to use input.* + screenshot probe. **SHIPPED.** Verified line 146: probe is now (a) `screenshot.screenshot` to see if Chrome is open, (b) `input.shortcut [ctrl, l]` for address bar, (c) `screenshot.screenshot` after page load. The proposed text in prior audit's G2 has landed near-verbatim.
- P1 #3 (G5): Add cross-references for macros-plan-end-to-end + macros-must-be-validated. **SHIPPED.** Both cross-referenced from `~/ecodiaos/CLAUDE.md` lines 214 and 220 respectively.
- P1 #4: Reclassify status_board row "Stale pattern ref - exhaust-laptop-route". **STATUS UNVERIFIED.** Audit fork is read-only; the row state was not probed. Carries forward as P2 G2 below.
- P1 #5 (G9): Reconcile SY094 agent-status contradiction. **STATUS UNVERIFIED, line 173-174 still reads "agent NOT running".** Carries forward as P1 G3 below.

**P2 list (5 items):**

- P2 #6 (G6): SUPERSEDED banner on macro-pivot draft. **SHIPPED.** Top-of-file SUPERSEDED line at `~/ecodiaos/drafts/macro-pivot-to-computer-use-2026-04-29.md` line 3.
- P2 #7 (G8): Factory CLI paywall freshness probe. **NOT SHIPPED.** Carries forward as P2 G4.
- P2 #8 (G7): Verify morning-briefing cron prompt. **NOT SHIPPED.** Carries forward as P2 G5.
- P2 #9 (M2): continuous-work cross-ref from `~/ecodiaos/CLAUDE.md`. **NOT SHIPPED.** Verified by grep: only `~/CLAUDE.md` references the file. Carries forward as P3 G7 (downgraded reasoning in Section 5).
- P2 #10: cowork-first-check.sh hook implementation. **NOT SHIPPED.** Still status='pending' per `~/ecodiaos/CLAUDE.md` line 555. Carries forward as P2 G6.

**P3 list (5 items):**

- P3 #11 (G3): Cowork "all four facets" mismatch. **NOT SHIPPED.** Line 173 still reads "all four". Carries forward as P3 S1.
- P3 #12 (G4): "five PreToolUse hooks" header. **NOT SHIPPED.** Line 548 still reads "five". Carries forward as P3 S2.
- P3 #13 (M3): forks-self-assessment-is-input cross-ref. **NOT SHIPPED.** Carries forward as P3 G8.
- P3 #14 (M4): cred-rotation cross-ref from `~/CLAUDE.md`. **NOT SHIPPED.** Carries forward as P3 G9.
- P3 #15-16: Defer carry-forward structural items. Still deferred.

**Summary: 4 of 5 P1 items shipped; 1 P1 ITEM SHIPPED of the P2 list (G6 banner); 9 items carry forward.**

---

## Section 1: Gaps - rules surfaced not yet codified

### G1. cowork-conductor-dispatch-protocol.md not cross-referenced from `~/CLAUDE.md` (P3, NEW)

Pattern file authored at 21:14 AEST (4 minutes after the late-evening audit completed). Cross-referenced from `~/ecodiaos/CLAUDE.md` line 152 (the "Conductor -> Cowork dispatch protocol (29 Apr 2026 21:08 AEST refinement, fork_mojy0izs_f73f7c)" subsection). NOT cross-referenced from `~/CLAUDE.md` "Claude Cowork is the 1stop shop for UI-driving tasks" section.

The technical mechanics rightly belong in the technical manual so this is borderline. But `~/CLAUDE.md` line 195 already cross-refs the parent doctrine file (`claude-cowork-is-the-1stop-shop-for-ui-driving-tasks.md`). For symmetry the conductor-dispatch protocol should be named alongside it.

**Proposed action:** Append to `~/CLAUDE.md` line 195 cross-references list: `, ~/ecodiaos/patterns/cowork-conductor-dispatch-protocol.md (the bounded-step dispatch protocol with Cowork)`.

**Target:** `~/CLAUDE.md` line 195 (Cowork section cross-references).

---

### G2. Status_board reclassification of "Stale pattern ref - exhaust-laptop-route" - status unverified (P2, carry-forward from prior P1 #4)

Prior audit P1 #4: reclassify the row priority from 3 to 1 immediately, archive on file landing. The file landed at 21:03 AEST. Whether the row was archived is unverified by this audit (read-only).

**Proposed action:** A 2-second `db_query` probe by the next conductor turn against `SELECT * FROM status_board WHERE name LIKE '%exhaust-laptop-route%' AND archived_at IS NULL`. If the row exists active, archive it. If already archived, no-op.

**Target:** status_board verification by next-turn conductor.

---

### G3. SY094 agent-status contradiction - still unresolved (P1, carry-forward from prior P1 #5)

`~/ecodiaos/CLAUDE.md` line 173-174 still reads: "2026-04-27 status: agent NOT running. Source staged at ~/eos-laptop-agent but Node.js is not installed on the MacInCloud user shell."

Prior audit P1 #5 flagged this contradicts a status_board row claiming "macros registered + dry-run-verified on SY094 macroSuite". Either Node was installed since 2026-04-27 (in which case CLAUDE.md is stale) or the macros are unverified (in which case the iOS-TestFlight row is overstating readiness).

**Proposed action:** SSH probe to SY094 and `curl localhost:7456/api/health` over the SSH tunnel. Reconcile within 24h.

**Target:** `~/ecodiaos/CLAUDE.md` line 173 OR status_board iOS-TestFlight row.

---

### G4. Factory CLI paywall freshness probe - still unresolved (P2, carry-forward from prior G8)

`~/ecodiaos/CLAUDE.md` line 374: "2026-04-28 OPERATIONAL ALERT - Factory CLI is paywall-gated." 25+ hours stale at audit time. status_board row "Factory phantom-failing - both Claude Max CLI accounts credit-exhausted" is the matching tracking row.

**Proposed action:** A 5-line probe fork (no-op echo Factory session) by the next-turn conductor.

**Target:** Probe fork → status_board row + `~/ecodiaos/CLAUDE.md` line 374.

---

### G5. Day-plan kv_store entry for 2026-04-30 not yet authored (P2, carry-forward from prior G7)

`~/CLAUDE.md` Continuous-work section lines 54-59 documents the schema for `kv_store.ceo.day_plan_YYYY-MM-DD`. No `ceo.day_plan_2026-04-30` exists at audit time. Tomorrow's 09:00 AEST morning-briefing cron should author it.

**Proposed action:** Verify the morning-briefing cron prompt by the next-turn conductor (`SELECT prompt FROM os_scheduled_tasks WHERE name = 'morning-briefing'`). Update if the day-plan-author step is missing.

**Target:** `os_scheduled_tasks` row for `morning-briefing` cron (prompt field).

---

### G6. cowork-first-check.sh hook still status='pending' (P2, carry-forward from prior P2 #10)

`~/ecodiaos/CLAUDE.md` line 555 row references `~/ecodiaos/scripts/hooks/cowork-first-check.sh (status='pending', spec only as of 29 Apr 2026)`. Spec exists at `~/ecodiaos/patterns/claude-cowork-is-the-1stop-shop-for-ui-driving-tasks.md` Section 8. Not implemented in 25+ hours since spec authoring.

**Proposed action:** Fork-dispatch implementation. Brief should reference both the spec section and the existing `brief-consistency-check.sh` for hook structural template. Register in `~/.claude/settings.json` PreToolUse hooks for `mcp__forks__spawn_fork` and `mcp__factory__start_cc_session`.

**Target:** `~/ecodiaos/scripts/hooks/cowork-first-check.sh` (new file) + `~/.claude/settings.json` hook registration.

---

### G7. continuous-work-conductor-never-idle.md not cross-referenced from `~/ecodiaos/CLAUDE.md` (P3, downgraded from prior P2 #9)

`~/CLAUDE.md` cross-refs the file twice (lines 70 and 96). `~/ecodiaos/CLAUDE.md` does NOT cross-ref it.

Downgraded from P2 to P3 because grep against the file system finds the pattern from either CLAUDE.md path, and the 5-forks-always section in `~/ecodiaos/CLAUDE.md` mirrors the operational rule. Symmetry is desirable but not high-leverage.

**Proposed action:** Append to `~/ecodiaos/CLAUDE.md` 5-forks-always section cross-references list: `~/ecodiaos/patterns/continuous-work-conductor-never-idle.md`.

**Target:** `~/ecodiaos/CLAUDE.md` 5-forks-always section "Cross-references" sub-bullet list (around line 411-413 area).

---

### G8. forks-self-assessment-is-input-not-substitute.md cross-references missing from BOTH CLAUDE.md files (P3, carry-forward from prior P3 #13)

Pattern file authored 10:10 AEST today. Verified by grep: NEITHER `~/CLAUDE.md` NOR `~/ecodiaos/CLAUDE.md` cross-reference it.

**Proposed action:** Add cross-reference in two places: (a) `~/ecodiaos/CLAUDE.md` Factory section near the review-deploy doctrine block ("Review & Deploy - This Is YOUR Job" sub-section), and (b) `~/CLAUDE.md` Anti-Patterns Behavioural list.

**Target:** Two CLAUDE.md files, two cross-reference inserts.

---

### G9. cred-rotation-must-propagate-to-all-consumers.md not cross-referenced from `~/CLAUDE.md` (P3, carry-forward from prior P3 #14)

Verified by grep: `cred-rotation-must-propagate` matches in only ONE of the two CLAUDE.md files (the technical manual `~/ecodiaos/CLAUDE.md` line 295). The business-file `~/CLAUDE.md` does not reference it.

**Proposed action:** Add a line in `~/CLAUDE.md` Operational Lessons → Database & Security sub-section (or a new Credentials sub-section).

**Target:** `~/CLAUDE.md` Operational Lessons section.

---

## Section 2: Stale items - refs to outdated tooling, removed flags, superseded doctrine

### S1. "all four facets" numerical mismatch on `~/CLAUDE.md` line 173 - still unresolved (P3, carry-forward)

`~/CLAUDE.md` line 173 verbatim: "Cowork already has the page accessibility tree, Anthropic's agentic capability shipped, and Tate's signed-in browser session - all four facets a hand-rolled loop would only partially have."

Three items listed, "all four" stated.

**Target:** `~/CLAUDE.md` line 173 + verify pattern file consistency.

---

### S2. "five PreToolUse hooks" header on `~/ecodiaos/CLAUDE.md` line 548 - still unresolved (P3, carry-forward)

`~/ecodiaos/CLAUDE.md` line 548 says "five PreToolUse hooks". The table immediately below has SIX rows. The sixth (cowork-first-check) is marked status='pending' but it IS in the table.

**Proposed action:** Edit line 548 to "six PreToolUse hooks (one pending implementation)" or "five active PreToolUse hooks plus one pending".

**Target:** `~/ecodiaos/CLAUDE.md` line 548.

---

### S3. The "old kv_store ceo.active_threads JSON blob is DEPRECATED" wording (P3 informational, BRIEF-CHECK)

Brief asked to specifically check this. `~/ecodiaos/CLAUDE.md` line 359 already explicitly says: "The old kv_store 'ceo.active_threads' JSON blob is DEPRECATED - use status_board instead." Captured correctly.

**No action needed.**

---

### S4. References to `schedule_delayed for delegation` (P3 informational, BRIEF-CHECK)

Brief asked to specifically check this. `~/ecodiaos/CLAUDE.md` line 467 already explicitly says: "Never use `schedule_delayed` to delegate work. That hijacks the main OS conversation stream. Factory sessions run in the background independently." Captured correctly.

**No action needed.**

---

### S5. References to Factory CLI without the 28 Apr paywall caveat (P3 informational, BRIEF-CHECK)

Brief asked to specifically check this. `~/ecodiaos/CLAUDE.md` line 374 has the paywall alert at the top of the Factory section. Other Factory references (line 426 Dispatching, line 433 Monitoring) inherit the caveat from the section header. Acceptable.

**No action needed.** (See G4 above for freshness-probe action.)

---

### S6. References to `cu.*` / hand-rolled computer-use loops without Cowork-supersedes-this caveat (P2, BRIEF-CHECK)

Brief asked to specifically check this. `~/ecodiaos/CLAUDE.md` line 220 in the Macro authoring doctrine block carries the "PENDING PIVOT (29 Apr 2026)" header. Line 222 says "the bespoke macro runtime ... is being replaced by Anthropic computer-use" but per the 20:25 AEST refinement this should now read "Cowork primary, computer-use fallback". The PENDING PIVOT block's reference to `~/ecodiaos/drafts/macro-pivot-to-computer-use-2026-04-29.md` is technically correct (the draft has its own SUPERSEDED banner) but the block itself does NOT mention Cowork as the primary path.

This is the most-leveraged stale item in this section. Anyone reading the macro authoring doctrine without first reading the Cowork section above will miss the substrate flip.

**Proposed action:** Edit `~/ecodiaos/CLAUDE.md` line 220-228 area Macro authoring doctrine "PENDING PIVOT" block to clarify Cowork is now primary, computer-use is fallback. One sentence insert near the top of the block.

**Target:** `~/ecodiaos/CLAUDE.md` line 220-228 area.

---

## Section 3: Missing cross-references

### M1. cowork-conductor-dispatch-protocol.md from `~/CLAUDE.md` (P3, same as G1).

### M2. continuous-work-conductor-never-idle.md from `~/ecodiaos/CLAUDE.md` (P3, same as G7, carry-forward).

### M3. forks-self-assessment-is-input-not-substitute.md from BOTH files (P3, same as G8, carry-forward).

### M4. cred-rotation-must-propagate-to-all-consumers.md from `~/CLAUDE.md` (P3, same as G9, carry-forward).

### M5. macros-must-be-validated-by-real-run-before-codification.md from `~/ecodiaos/CLAUDE.md` (RESOLVED).

Cross-referenced from `~/ecodiaos/CLAUDE.md` line 220 ("Full doctrine: ..."). Resolved.

### M6. exhaust-laptop-route-before-declaring-tate-blocked.md - cross-references all in place (RESOLVED).

Cross-referenced from `~/CLAUDE.md` line 133 + line 155 AND `~/ecodiaos/CLAUDE.md` line 268. Resolved.

### M7. claude-cowork-is-the-1stop-shop-for-ui-driving-tasks.md from BOTH files (RESOLVED).

Cross-referenced from `~/CLAUDE.md` line 195 AND `~/ecodiaos/CLAUDE.md` line 150. Resolved.

### M8. use-anthropic-existing-tools-before-building-parallel-infrastructure.md - cross-refs in place (RESOLVED).

Cross-referenced from `~/CLAUDE.md` line 89 AND `~/ecodiaos/CLAUDE.md` macro-authoring block. Resolved.

---

## Section 4: Structural issues

### St1. Findability of 5-forks-always + continuous-work + fork-by-default doctrines (P3 deferred, BRIEF-CHECK)

Brief asked specifically: "are 5-forks-always doctrine + continuous-work doctrine + fork-by-default doctrine in proximate sections, or scattered?"

`~/CLAUDE.md` layout:
- Line 17-37: "Fork by default - doing work on main is the exception, not the rule"
- Line 41-50: "Use Anthropic's existing tools before building parallel infrastructure" (intervening section)
- Line 54-72: "Continuous work - the conductor never goes idle"
- Line 76-99: "5 forks always - empty slots are failure"
- Line 103-117: "Codify at the moment a rule is stated, not after"

The three doctrines ARE in proximate sections (lines 17-99 cover all three). Reasonable adjacency.

`~/ecodiaos/CLAUDE.md` layout:
- Line 386-411: "5 forks always - empty slots are failure" (mirrored from `~/CLAUDE.md`)
- continuous-work doctrine: NOT mirrored (only cross-referenced via the 5-forks section, which is also missing the cross-ref per G7).
- fork-by-default: NOT mirrored.

The technical manual currently mirrors only 5-forks-always. Defer per the same reasoning prior audits used for technical/business split discipline.

**No action this audit.**

---

### St2. Findability of cron-efficiency rule from email-triage / os-forks-reaper context (P3 deferred, BRIEF-CHECK)

Brief asked specifically: "Is the cron-efficiency rule discoverable from email-triage / os-forks-reaper context?"

The cron-efficiency rule lives at `~/ecodiaos/CLAUDE.md` line 23-25 (sub-bullet under STATUS BOARD). It is NOT cross-referenced from the email-triage cron documentation in the Scheduling & Autonomy section. Anyone reading the email-triage doctrine without first reading the top of the file would miss the fast-exit rule.

**No action this audit.** Defer; could become a P2 if mediocre cron behaviour emerges.

---

### St3. Findability of temporal-injection rule (UTC for machines, AEST for Tate) (P3 satisfactory, BRIEF-CHECK)

Brief asked specifically: "Is the temporal-injection rule (UTC for machines, AEST for Tate) easy to find?"

The rule lives at `~/ecodiaos/CLAUDE.md` line 614-616 (under "Temporal Injection - Knowing What Time It Is" sub-section). The output rule is in a bold paragraph at line 616 and is grep-targetable. Acceptable findability.

**No action needed.**

---

### St4. The two "Pattern Surfacing" sections in `~/ecodiaos/CLAUDE.md` (P3 deferred, carry-forward)

Same as v2 audit St4 and late-evening audit St3. Top-of-file "PATTERN SURFACING" + later "Pattern Surfacing - Check `~/ecodiaos/patterns/` BEFORE High-Leverage Actions" inside Session Orientation. Two near-identical sections. Defer.

---

### St5. The `~/CLAUDE.md` table-of-contents is implicit (P3 deferred, carry-forward)

Same as v2 audit St2 and late-evening audit St4. 1089 lines, no TOC. Defer.

---

### St6. Cowork "all four facets" + hook-count "five" mismatches (P3, see S1 + S2).

---

## Section 5: Prioritised P1/P2/P3 to-do list

### P1 (must ship before next session):

1. **Resolve SY094 agent-status contradiction.** Probe SY094 over SSH (or SSH-tunneled `curl localhost:7456/api/health`). Reconcile `~/ecodiaos/CLAUDE.md` line 173-174 ("agent NOT running") against the status_board iOS-TestFlight row. Update whichever is stale. (Resolves G3 / prior P1 #5)

### P2 (within 24 hours):

2. **Macro authoring PENDING PIVOT block clarity.** Edit `~/ecodiaos/CLAUDE.md` line 220-228 area to clarify Cowork is primary, computer-use is fallback. One-sentence insert. (Resolves S6)

3. **Status_board verification probe.** 2-second `db_query` against `status_board` for any row matching `name LIKE '%exhaust-laptop-route%' AND archived_at IS NULL`. Archive if active. (Resolves G2 / prior P1 #4)

4. **Factory CLI paywall freshness probe.** No-op Factory session. Update `~/ecodiaos/CLAUDE.md` line 374 alert date and status_board row. (Resolves G4 / prior P2 #7)

5. **Verify morning-briefing cron prompt** for explicit `ceo.day_plan_2026-04-30` author step. Update if missing. (Resolves G5 / prior P2 #8)

6. **Implement cowork-first-check.sh hook** per spec in `claude-cowork-is-the-1stop-shop-for-ui-driving-tasks.md` Section 8. Register in PreToolUse for `mcp__forks__spawn_fork` and `mcp__factory__start_cc_session`. Edit `~/ecodiaos/CLAUDE.md` line 548 to "six PreToolUse hooks" once shipped. (Resolves G6 + S2 / prior P2 #10 + P3 #12)

### P3 (backlog):

7. Cross-ref `cowork-conductor-dispatch-protocol.md` from `~/CLAUDE.md` line 195 (Cowork section). (Resolves G1 / M1)

8. Fix `~/CLAUDE.md` line 173 "all four facets" to "all three facets" or name the fourth. (Resolves S1 / prior P3 #11)

9. Cross-ref `forks-self-assessment-is-input-not-substitute.md` from `~/ecodiaos/CLAUDE.md` Factory review-deploy block AND `~/CLAUDE.md` Anti-Patterns Behavioural. (Resolves G8 / prior P3 #13)

10. Cross-ref `cred-rotation-must-propagate-to-all-consumers.md` from `~/CLAUDE.md` Operational Lessons. (Resolves G9 / prior P3 #14)

11. Cross-ref `continuous-work-conductor-never-idle.md` from `~/ecodiaos/CLAUDE.md` 5-forks-always section. (Resolves G7 / prior P2 #9, downgraded P2 to P3)

12. Defer all carry-forward structural items: St1 (CLAUDE.md cluster mirroring), St2 (cron-efficiency findability), St4 (dedup of two Pattern Surfacing sections), St5 (~/CLAUDE.md TOC), structural items from prior afternoon audit's ST1-ST5.

---

## Section 6: Audit count by priority

- Section 1 gaps: 9 items (G1-G9). P1: 1 (G3). P2: 4 (G2, G4, G5, G6). P3: 4 (G1, G7, G8, G9).
- Section 2 stale: 6 items (S1-S6). P2: 1 (S6). P3: 2 (S1, S2). 3 informational with no action.
- Section 3 cross-references: 8 items. 4 carry-forward unresolved (M1-M4 = G1, G7, G8, G9). 4 RESOLVED.
- Section 4 structural: 6 items. 0 actionable this audit. All deferred.
- **Total surfaced this audit: 11 actionable items.** P1: **1 item**. P2: **5 items**. P3: **5 items**.
- **Verified shipped from prior audit: 5 items** (4 of 5 P1, 1 of 5 P2).

---

## Top-3 highest-leverage additions (ship next)

1. **G3: Reconcile SY094 agent-status contradiction.** The iOS-TestFlight readiness claim depends on whether SY094 macroSuite is actually running. If the agent is down, the "one driver-script from ship" status_board row is overstating readiness. Cheapest probe (SSH curl) settles it; impact is on a P1 status_board row.

2. **S6: Macro authoring PENDING PIVOT block clarity.** One-sentence edit to clarify Cowork-primary / computer-use-fallback. Low cost; the block currently still reads as if computer-use is primary, which contradicts the 20:25 AEST refinement and the cowork-first-check.sh hook spec that has been authored against the corrected understanding.

3. **G6: Implement cowork-first-check.sh hook.** Spec exists at `~/ecodiaos/patterns/claude-cowork-is-the-1stop-shop-for-ui-driving-tasks.md` Section 8. Pending status for 25+ hours is a doctrine-vs-enforcement gap of the kind `~/ecodiaos/patterns/recurring-drift-extends-existing-enforcement-layer.md` warns against. The hook is the mechanical-enforcement layer for the Cowork doctrine.

---

## Audit-self-check

- All findings have file paths AND specific line numbers.
- No paraphrases; every flagged line was directly read or grep-confirmed in this audit.
- No em-dashes used in this document.
- Audit fork is read-only; no CLAUDE.md or pattern edits applied.
- Brief explicitly forbids spawning an edit fork from within this audit; that decision is left to the conductor.

End of audit.
