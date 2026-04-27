---
triggers: scheduled-task, redispatch, factory-redispatch, queued-retry, schedule_delayed, stale-doctrine, parallel-path, ccbe84bd, scheduler-trio, kv_store-prompt, ground-truth-check, factory-no-op-prevention
---

# Scheduled redispatch tasks must verify the work has not shipped via another path before firing

## The rule

A scheduled task whose job is to redispatch or redo work (Factory redispatch, retry-after-failure, follow-up build) is stale by default. Between the moment it was queued and the moment it fires, the work may have landed through a parallel path: Tate's manual commit, another cron, a different Factory session, an out-of-band fix.

**Before any scheduled task that says "redispatch X" or "rebuild Y" or "redo Z" calls `start_cc_session`, verify the deliverable has not already shipped. The check costs one `git log` / `git show` / `db_query`. The cost of skipping it is one wasted Factory dispatch plus the rebuild churn it produces.**

## Do

- For Factory redispatch tasks: `git log --oneline -20 <target-files>` and `git show --stat <suspected-commit>` against the target codebase BEFORE `start_cc_session`. If the spec'd changes are present in HEAD, abort the dispatch and archive the corresponding `status_board` rows.
- For status-board-archival tasks: `SELECT id, archived_at FROM status_board WHERE id IN (...)` BEFORE acting. If `archived_at IS NOT NULL`, the work shipped; record an Episode noting the saved redundant cycle and exit.
- Cross-reference the `recent_doctrine` block in the system prompt — if it mentions the work landing, treat that as a constraint, not as background. Verify on disk to confirm.
- When aborting a stale redispatch, log a brief Neo4j Episode: which task fired, what it was supposed to redo, what shipped instead (commit/path), and the cost saved. Future-me needs the trail to trust the abort decision.

## Do not

- Do not blindly call `start_cc_session` because the kv_store prompt body says to. The prompt is correct for the moment it was authored; the world moved.
- Do not assume "queued behind another session completing" still implies the work is needed. The blocking session may have completed and the work taken a different path.
- Do not delete the kv_store prompt key or cancel the scheduled task chain without first confirming the work shipped — false-positive aborts lose real work.
- Do not write paragraphs of self-criticism for a successful abort. The verification is the discipline; the abort is correct behaviour, not an error.

## Protocol

1. Scheduled task fires with prompt "redispatch X / rebuild Y".
2. Read the prompt verbatim from kv_store. Do not yet dispatch.
3. Identify the deliverable: which files, which commits, which status_board rows.
4. Verify on disk:
   - `cd <codebase> && git log --oneline -20 <target-files>`
   - `git show --stat <suspected-commit>` if the commit hash is in recent_doctrine or recent commits
   - `SELECT archived_at FROM status_board WHERE id IN (<rows the task was meant to close>)`
5. If shipped: write Neo4j Episode (name shipping commit, archive timestamp, doctrine source), audit `os_scheduled_tasks` for paired follow-up review tasks and cancel them, exit.
6. If not shipped: dispatch as the prompt instructs.

## Origin

Apr 27 2026, 08:08 AEST. Scheduled task `redispatch-scheduler-trio-clean-worktree` fired with a verbatim prompt body in `kv_store.ceo.scheduled.redispatch-scheduler-trio.prompt`. The prompt was authored when phantom session ccbe84bd was rejected and the redispatch was queued behind peer-monitor session 5037e5e7. Between queue and fire, the scheduler trio fix landed via commit a329566 (Tate co-author with Sonnet 4.6) — exactly the two spec'd files (schedulerPollerService.js, osSession.js), all three fixes (self-stamp gate, ESSENTIAL_CRON_NAMES, +60s requeue). All three status_board rows archived at 21:29:51 UTC the same commit window. The recent_doctrine block at top of the system prompt explicitly named the trio fix landing as the #5 entry. I read it on the first pass, ran `git show --stat a329566` to verify, aborted the dispatch, archived a Neo4j Episode (2597). Cost saved: one Factory dispatch + the no-op rejection cycle that would have followed. Counter-example logged: same morning's Pinnacle FE failure (Episode 2596) where the structured-dashboard-bias pattern's warning was read as history rather than constraint — same pattern, opposite outcomes, same session.
