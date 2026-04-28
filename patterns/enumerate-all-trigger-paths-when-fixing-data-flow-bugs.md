---
triggers: data-flow-bug, sync-bug, task-not-clearing, multiple-paths, trigger-coverage, enumerate-paths, source-table, partial-fix, missed-path, forms-canonical, app-canonical, sheet-sync, excel-sync, surveys, leader-tasks, event_impact, multiple-producers, fix-coverage
---

# Enumerate ALL trigger paths when fixing data-flow bugs, not just the obvious one

## The rule

When a data-flow bug surfaces ("X isn't happening when Y occurs"), enumerate **every code path that could produce condition Y** before writing the fix. The user's reported scenario is usually ONE of N paths, and a fix that only covers that one path leaves the bug live for the other N-1 paths. The user comes back with the same complaint plus loss of trust.

For data-pipeline bugs specifically, the paths typically include:
- The user-facing happy path (form submission, button click).
- Sync/import paths from external systems (sheet sync, webhook, ETL).
- Backfill / migration paths.
- Admin / direct-DB paths.
- Future-proofed paths (currently unused but architecturally exposed).

## Why

Tonight (2026-04-28 23:02 AEST), Tate flagged that PR #8 (the survey-task-clearing fix) was incomplete:

> "But the input came from the microsoft form and is in the sheet now, which should then sync to the db and remove the task shouldnt it? I dont think it is right now."

PR #8 added a SQL trigger on `survey_responses` INSERT/UPDATE that mirrors the JS `syncSurveyImpact` server-side. That covers the survey-via-link path and any future direct survey-row writes. But the actual originating user scenario was Forms→sheet→DB→event_impact via jobid 9 (excel-from-sync Edge Function). That path doesn't write to `survey_responses` — it writes to `events` and `event_impact` directly. The leader_task gate (`usePendingImpactFormTasks`) checks for `event_impact` existence. So the from-excel path SHOULD have cleared the task, but apparently isn't.

Two failures in one bug:
1. **My fix only covered ONE of TWO trigger paths.** survey_responses path was covered; event_impact path was not.
2. **The audit in PR #8's own body explicitly named the three paths** ("survey response comes in OR leader fills the impact form OR from-excel sync writes the row") but the trigger I shipped only fired on the first. I had the enumeration in front of me and still missed the fix-coverage gap.

The survey-link path was effectively untested (zero `survey_responses` rows existed in 90 days of non-test events), so my "fix" closes a future-state hole while leaving the actual-state bug live.

## Do

Before writing a data-flow fix:

1. **Enumerate every path that produces the trigger condition.** Be exhaustive:
   - User happy path.
   - Sync / import / ETL paths.
   - Webhook / external-system paths.
   - Backfill / one-shot migration paths.
   - Admin / direct-DB paths.
   - Test-only paths (might want to bypass).
2. **For each path, write the source table or function name in the brief.** Don't say "the survey path" — say "INSERT INTO survey_responses" OR "Edge Function from-excel writing INSERT INTO event_impact for Forms-canonical events."
3. **Decide which paths the fix covers.** A trigger on table X only covers writes to table X. If the data flows through multiple tables, the fix needs to either:
   - Hook the LATEST common table all paths land in (e.g. trigger on `event_impact` instead of `survey_responses` if both feed into event_impact).
   - Add multiple triggers (one per source).
   - Refactor producers to converge on one canonical write path.
4. **Verify the LATEST-common-table approach where possible.** Triggering on a downstream table that all producers write to is more robust than shadowing each producer.
5. **State the path coverage explicitly in the PR body.** "This fix covers paths A and B. Path C is not yet covered — tracked in row X." So the reviewer (Tate, future-you) can see the coverage map.

## Do NOT

- Treat the user's reported scenario as the only path. They reported the symptom they noticed, not necessarily the only cause.
- Ship a fix that closes path A while leaving path B (which the user actually used) open.
- Skip enumeration because "the obvious fix is on table X." The obvious fix is often on the wrong table.
- Bury the path-coverage decision in commit messages. Put it in the PR body where the reviewer reads it.

## Protocol when applying

For any "X isn't happening when Y occurs" bug:

```
WHO PRODUCES Y? List every path:
- Path 1: <file:line>, writes to <table>
- Path 2: <file:line>, writes to <table>
- Path 3: <file:line>, writes to <table>
...

WHERE is the gate that should detect Y?
- Hook: <table or event>, condition <X>

DOES THE GATE CATCH ALL PATHS?
- Path 1 -> writes to <gate_table>: YES / NO
- Path 2 -> writes to <gate_table>: YES / NO
- Path 3 -> writes to <gate_table>: YES / NO

If any path is NO: either move the gate to a downstream-common table, or add per-path triggers.

PR BODY MUST STATE:
- Paths covered: ___
- Paths NOT covered: ___
- Why those uncovered paths are acceptable / queued / blocked: ___
```

## Origin

Apr 28 2026 23:02 AEST. Tate flagged that PR #8's survey-task-clearing trigger only fired on the survey_responses path, not the Forms→sheet→DB path that was the actual origin of Jess's reported issue. Fork fork_moin0874 dispatched to fix the gap by either (a) extending the trigger to fire on event_impact INSERT instead, or (b) adding a separate trigger covering the from-excel path. The doctrine-correct fix is (a): hook on the latest-common-table, so any path that produces event_impact clears the task.

## Cross-references

- Pattern: `excel-sync-collectives-migration.md` (the doctrine on Forms-canonical vs app-canonical paths).
- Pattern: `listener-pipeline-needs-five-layer-verification.md` (sibling: 5-layer audit catches missing producers).
- PR #8 (survey_responses trigger): merged f7a6096, partial coverage.
- Fork fork_moin0874_ef62a3 (Forms→sheet→DB→task-clearing fix): in flight at time of authoring.
