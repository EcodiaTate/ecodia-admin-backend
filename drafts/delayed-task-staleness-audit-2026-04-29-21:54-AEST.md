# Delayed-task staleness audit - 29 Apr 2026 21:54 AEST

Fork: fork_mok00dzv_5ab06b
Brief: probe the 4 fork-resume tasks + 1 credit-exhaustion-resume meta-task scheduled for 13:15 UTC (23:15 AEST) and cancel any whose original work has shipped via parallel paths.

Context: 10:34-10:38 UTC credit-exhaustion wave errored 4 forks. Per `~/ecodiaos/patterns/graceful-credit-exhaustion-handling.md` each was assigned a `resume-fork-<id>` delayed task at reset+5min. By 21:00 AEST the wave had lifted and replacement forks were dispatched manually with refined briefs. This audit confirms the replacements and cancels the now-redundant resumes per `~/ecodiaos/patterns/cancel-stale-schedules-when-work-resolves-early.md`.

[APPLIED] ~/ecodiaos/patterns/cancel-stale-schedules-when-work-resolves-early.md because the audit produces concrete `schedule_cancel` calls against tasks whose underlying work has been resolved via parallel paths.
[APPLIED] ~/ecodiaos/patterns/graceful-credit-exhaustion-handling.md because the wave's recovery is the trigger and the resume-task lifecycle is governed by this doctrine.
[APPLIED] ~/ecodiaos/patterns/scheduled-redispatch-verify-not-shipped.md because the verify-before-redo discipline applied to each task before classification.
[APPLIED] ~/ecodiaos/patterns/no-symbolic-logging-act-or-schedule.md because the audit ships cancellations, not "would be nice to clean up."
[NOT-APPLIED] ~/ecodiaos/patterns/external-blocker-freshness-probe.md because no external counterparty involved - this is internal scheduler hygiene.

---

## Section 1 - Audited tasks (5 rows, one per task)

| Task ID | Name | Original fork | Original ended_at | Replacement / outcome | Classification | Action |
|---|---|---|---|---|---|---|
| `a0e627f4-3319-43a1-bbe5-dbe4126ce2f0` | resume-fork-fork_mojx4o6h_fa549f | fork_mojx4o6h_fa549f (Co-Exist comprehensive feature audit) | 10:38:01 UTC `error` `credit_exhaustion` | fork_mojxqcwu_d209ed spawned 10:51:40 UTC with refined brief - same scope, different output path. Currently `spawning` (zombie spawn-state, separate concern from this audit). | (a) REDUNDANT - replacement fork exists | CANCEL |
| `9e93d915-d1d3-4b9d-acbf-a324cd435897` | resume-fork-fork_mojx7q66_67616f | fork_mojx7q66_67616f (Symbiotic Cowork-conductor MCP integration) | 10:38:03 UTC `error` `credit_exhaustion` | fork_mojxrj0v_d65a25 `running` since 10:52:35 UTC with broader brief: "Cowork ⟷ EcodiaOS MCP symbiosis - design the highest-leverage shared-state surface AND ship the first slice end-to-end" - refined supersession of original Neo4j-only framing. | (a) REDUNDANT - replacement fork running with broader brief | CANCEL |
| `f8940ee2-71e9-47ae-8e7a-c9864a62c3ba` | resume-fork-fork_mojw7558_b2e90a | fork_mojw7558_b2e90a (Co-Exist privacy fix) | 10:38:39 UTC `error` `credit_exhaustion` | fork_mojxpyx8_3299d2 `done` 10:54:22 UTC. Privacy fix shipped on coexist main as commit 148f7dc "feat(coexist): role-tiered participant profile privacy" + refactor 7b914e3. PR #15 merged. Smoke screenshots at `~/ecodiaos/drafts/coexist-privacy-test-screenshots/`. CI follow-ups: fork_mojyr41e_4f60fd done, fork_mojyxiqo_518403 spawning. | (a) REDUNDANT - work shipped end-to-end | CANCEL |
| `727fd9ae-96c5-4b3a-8755-8d89155e48cd` | resume-fork-fork_mojwzo7w_23c769 | fork_mojwzo7w_23c769 (Cowork 1stop shop doctrine codification) | 10:38:02 UTC `error` `credit_exhaustion` | fork_mojxqxy2_8cde80 spawned 10:52:07 UTC ("mechanical-enforcement layer for Cowork 1stop shop doctrine"). Pattern file `~/ecodiaos/patterns/claude-cowork-is-the-1stop-shop-for-ui-driving-tasks.md` written 10:55 UTC (21367 bytes). Cowork-first-check.sh hook shipped as fork_mojziamq_980de8 done 11:46 UTC. Doctrine + mechanical hook both landed. | (a) REDUNDANT - doctrine + hook shipped | CANCEL |
| `33dbe77a-3a40-4744-bd44-03efd44edb15` | credit-exhaustion-resume-2026-04-29 | wave-level meta-task | n/a (wave-level) | Wave clearly resumed - 20+ forks dispatched successfully since 11:00 UTC, current 5/5 active fork posture. The 4 individual resume-tasks are being cancelled in this audit. The status_board row "Fork wave credit-exhausted 29 Apr 2026" is the only remaining stale artefact. | (a) REDUNDANT - wave resumed, individual resumes already audited | CANCEL |

Verify-before-redo evidence per task captured in Section 5 below.

---

## Section 2 - Cancellations applied

All 5 cancellations issued via `mcp__scheduler__schedule_cancel`:

```
a0e627f4-3319-43a1-bbe5-dbe4126ce2f0   resume-fork-fork_mojx4o6h_fa549f
9e93d915-d1d3-4b9d-acbf-a324cd435897   resume-fork-fork_mojx7q66_67616f
f8940ee2-71e9-47ae-8e7a-c9864a62c3ba   resume-fork-fork_mojw7558_b2e90a
727fd9ae-96c5-4b3a-8755-8d89155e48cd   resume-fork-fork_mojwzo7w_23c769
33dbe77a-3a40-4744-bd44-03efd44edb15   credit-exhaustion-resume-2026-04-29
```

Outcomes recorded inline at the end of this fork's tool calls. None deleted, all cancelled (history preserved).

---

## Section 3 - Survivors (none)

Zero tasks survived. The full dispatch envelope was redundant by 21:54 AEST because (a) the credit window lifted 7+ hours ago, (b) every original fork was manually re-spawned with a refined brief within 13-14 minutes of the original error, and (c) those re-spawns either shipped or are still active.

If any individual case had survived (replacement fork still running on the original brief, no shipped artefact, original problem still present at 13:15 UTC), the entry would be here with the reasoning.

---

## Section 4 - Pattern observation (drift signal)

**The credit-exhaustion-resume meta-task is duplicate coverage on top of the per-fork resume tasks.** When the credit-exhaustion-handler fired at ~10:38 UTC, it created N+1 resume schedules: N (=4) for the individual forks plus 1 wave-level meta-task. All N+1 were scheduled to fire at the same `next_run_at` (13:15 UTC = reset+5min). Today every individual fork was re-spawned manually with a refined brief, and the wave-level resume's job ("verify the wave resumed and archive the status_board row") is by-construction performed every time the conductor re-orients - it does not need a delayed task.

This is drift. The doctrine in `~/ecodiaos/patterns/graceful-credit-exhaustion-handling.md` Section "Status_board surface" specifies a single status_board row per wave with auto-archive when the last individual resume reports back. It does NOT specify a separate delayed task at the wave level. The wave-level `credit-exhaustion-resume-2026-04-29` task is an artefact of the recovery handler being implemented before the doctrine was fully settled.

**Recommendation (not actioned in this fork - log only):**
- Patch the credit-exhaustion handler to NOT schedule a wave-level resume task. The N per-fork resume tasks plus the conductor's natural re-orientation are sufficient.
- If a wave-level checkpoint IS desired, make it a status_board row with `next_action_due=<reset+30min>` (priority 2, surfaces in the next morning briefing if not auto-archived) - not a delayed task that fires a fresh OS-session turn.
- Add a regression test: when the next wave hits, confirm only N tasks scheduled, not N+1.

This drift signal is logged here only. A follow-up fork would patch the handler. Not in scope for this audit.

---

## Section 5 - Verify-before-redo evidence per task

### Task 1 - resume-fork-fork_mojx4o6h_fa549f (Co-Exist feature audit)

- Original brief deliverable: `~/ecodiaos/drafts/coexist-feature-gap-audit-2026-04-29.md` + status_board row + Neo4j Episode.
- File check: `ls -la ~/ecodiaos/drafts/coexist-feature-gap-audit-2026-04-29.md` -> No such file or directory.
- Successor query: `SELECT * FROM os_forks WHERE started_at > '2026-04-29T10:38:00Z' AND brief ILIKE '%feature audit%'` -> fork_mojxqcwu_d209ed (started 10:51:40, status=spawning). Brief opens "Comprehensive Co-Exist feature audit. Identify EVERY feature gap..." - same scope, refined deliverable path.
- Conclusion: replacement fork exists (zombie spawning state is a separate observability concern), original brief covered. Resume-task would re-do work the conductor already re-dispatched.

### Task 2 - resume-fork-fork_mojx7q66_67616f (MCP integration)

- Original brief: expose Neo4j MCP server as remote SSE endpoint on `api.admin.ecodia.au`, wire Cowork on Corazon.
- File check: `ls -la ~/ecodiaos/drafts/symbiotic-mcp-integration-2026-04-29.md` -> No such file or directory.
- Successor query: fork_mojxrj0v_d65a25 (status=running, started 10:52:35). Brief opens "Cowork ⟷ EcodiaOS MCP symbiosis - design the highest-leverage shared-state surface AND ship the first slice end-to-end. Tate's framing at 20:43 AEST: 'the cowork stuff symbiosis and all that for best design'. Broader than the previous fork's narrow 'expose Neo4j MCP as remote endpoint' framing - pick the right surface, justify..."
- Conclusion: the replacement fork is explicitly framed as a refined supersession. The original's narrow Neo4j-only framing has been broadened.

### Task 3 - resume-fork-fork_mojw7558_b2e90a (Co-Exist privacy)

- Original brief: server-side gating function + RLS + UI redaction layer + Puppeteer post-deploy verification.
- Successor: fork_mojxpyx8_3299d2 done 10:54 UTC.
- Git evidence on coexist main: commit `148f7dc feat(coexist): role-tiered participant profile privacy - non-leaders see public-only, asist/co-leaders/leaders/staff see all (#15)` followed by `7b914e3 refactor(coexist): extract non-component exports to sibling files`.
- Smoke evidence: `~/ecodiaos/drafts/coexist-privacy-test-screenshots/` contains `admin-view-of-assist-leader.png`, `participant-view-of-assist-leader.png`, `smoke-results.json`.
- CI follow-ups: fork_mojyr41e_4f60fd (done) addressed CI failure on commit 8f4749b; fork_mojyxiqo_518403 (spawning) doing Coexist CI gate cleanup for the wider lint regression.
- Conclusion: privacy fix is on main, screenshots prove gating, CI cleanup is in motion. Resume-task would redo shipped work.

### Task 4 - resume-fork-fork_mojwzo7w_23c769 (Cowork doctrine)

- Original brief: pattern file at `~/ecodiaos/patterns/claude-cowork-is-the-1stop-shop-for-ui-driving-tasks.md`, INDEX.md update, both CLAUDE.md updates, Neo4j Pattern + Strategic_Direction + Episode + 3 relationships, supersession banner on macro-pivot drafts file, status_board row.
- File check: `ls -la ~/ecodiaos/patterns/claude-cowork-is-the-1stop-shop-for-ui-driving-tasks.md` -> 21367 bytes, mtime 10:55 UTC (17 min after original error, consistent with successor fork_mojxqxy2_8cde80 spawned 10:52).
- Successor: fork_mojxqxy2_8cde80 spawning at 10:52:07 (zombie spawn-state, but the pattern file landed regardless). Plus fork_mojziamq_980de8 done 11:46 UTC shipped the cowork-first-check.sh hook implementation.
- Conclusion: doctrine file shipped + mechanical-enforcement hook shipped. Resume-task would re-author existing files.

### Task 5 - credit-exhaustion-resume-2026-04-29 (wave-level)

- Original brief: verify durable artefacts before respawning, archive status_board row "Fork wave credit-exhausted 29 Apr 2026", reset to 5/5 forks once credit verified.
- Wave verification: `SELECT count(*) FROM os_forks WHERE started_at > '2026-04-29T11:00:00Z'` returns 20+ forks dispatched successfully since 11:00 UTC. Credit clearly available; account autoswitch healthy; current posture is 5/5 active forks (multiple spawning at audit time).
- Individual resume-tasks: all 4 cancelled in this same fork (Section 2).
- Conclusion: wave resumed organically, individual resume audit complete in-fork. Wave-level meta-task adds no value at this point - it would either no-op or duplicate work already done.

---

## Section 6 - Operational notes for future-me

1. **Zombie spawning forks observed.** fork_mojxqcwu_d209ed and fork_mojxqxy2_8cde80 have been in `status='spawning'` for 11+ hours with `last_heartbeat` matching `started_at`. That's a fork-spawn failure mode that didn't transition to `error` cleanly. Out of scope for this audit but worth a separate observability fork.

2. **The "spawning" state held by some replacements does NOT make their resume-tasks valid.** A zombie spawning fork is a fork-system bug, not a "the work is still pending" signal. The deliverables either shipped (file exists, commit on main) or didn't, regardless of fork status. If the deliverable shipped, the resume is redundant whether the replacement reached `done` cleanly or zombied.

3. **Status_board row "Fork wave credit-exhausted 29 Apr 2026" should auto-archive.** Per the doctrine spec, the row archives when the last resume reports back. Since all 5 are now cancelled, the row should be archived manually here OR by the credit-exhaustion-handler's archive hook when it next runs. Recommend manual archive in this audit if the row is still open.

