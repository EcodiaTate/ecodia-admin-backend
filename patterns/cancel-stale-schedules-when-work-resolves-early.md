---
triggers: schedule_cancel, stale-schedule-cancel, schedule-checkpoint-cancel, review-checkpoint, parallel-resolution-cancel, out-of-band-completion, os_scheduled_tasks-cancel, stale-review-task
---

# Cancel stale scheduled tasks the moment the work they track is resolved

## The rule

When work is resolved earlier than the scheduled checkpoint that tracks it - through a parallel workflow, an ad-hoc approve/reject, a cron completing it, or any out-of-band resolution - **immediately cancel the now-stale scheduled task**. Do not let it fire. Do not rely on it to "no-op gracefully." Scheduled tasks that fire against resolved state waste tokens, pollute the scheduler log with false "failure" signals, and degrade Tate's trust in autonomous scheduling.

**The discipline: every resolution action (approve_factory_deploy, reject_factory_session, crm_complete_task, archive_thread, post-deploy verification, payment clearing, etc.) MUST include a same-turn audit of `os_scheduled_tasks` for any pending delayed tasks referencing the resolved entity, and a `schedule_cancel` on each one found.**

## Why this matters

The scheduler is not free. Every delayed task:
- Holds a slot in the polling loop's next-run sort
- Fires a POST to `/api/os-session/message`, creating a turn, loading the system prompt, running orientation queries
- If the work is already resolved, produces a "check found nothing to do" response that looks identical to a genuine failure on inspection
- Contributes to the false perception that autonomous scheduling is unreliable

When Tate grepped `os_scheduled_tasks` for recent failures (Apr 22 2026), four of the five "failures" were actually stale reviews firing against already-deployed Factory sessions. The scheduler worked correctly. The callsite (me) did not clean up after itself.

This is the same class of mistake as symbolic logging: the work is recorded, the real action is not taken. A pattern file without a cancellation is worthless. A cancellation without a pattern file is a one-off. Both are required.

## Do

- After every `approve_factory_deploy` → query `os_scheduled_tasks` for `type='delayed' AND status='active' AND prompt LIKE '%<sessionId>%'` and cancel each result
- After every `reject_factory_session` → same audit, same cancel
- After completing any CRM task or email thread that has a delayed follow-up scheduled → audit and cancel
- After any ad-hoc resolution of work that was queued for later review → audit and cancel
- Keep the audit query tight and specific. Use the session ID, client slug, task ID, or other unique token from the resolved entity
- If you notice a stale task firing, cancel the task AND all its siblings in the same batch, not one at a time

## Do not

- Leave stale delayed tasks in place "because they'll just no-op"
- Rely on the scheduler's polling loop to clean up after you - it can't tell stale from fresh
- Cancel tasks speculatively without verifying the underlying work is actually resolved
- Write a pattern file about this and not do the cancellation in the same turn (that's the exact failure mode this file exists to prevent)

## Protocol

Every `approve_factory_deploy` or `reject_factory_session` call site should look like:

```
1. approve_factory_deploy(sessionId, notes) / reject_factory_session(sessionId, reason)
2. db_query: SELECT id, name FROM os_scheduled_tasks
             WHERE type='delayed' AND status='active' AND prompt LIKE '%<sessionId>%'
3. For each row: schedule_cancel(taskId)
4. If any were cancelled, log the fact in the action summary
```

For non-Factory resolutions (CRM task completion, thread close, payment received):

```
1. Do the resolution action
2. Query os_scheduled_tasks for delayed tasks mentioning the resolved entity's ID, slug, or unique token
3. Cancel each match
4. Log
```

## The audit query (general form)

```sql
SELECT id, name, next_run_at
FROM os_scheduled_tasks
WHERE type = 'delayed'
  AND status = 'active'
  AND (prompt ILIKE '%<unique-token>%' OR name ILIKE '%<unique-token>%')
ORDER BY next_run_at;
```

`<unique-token>` is typically a session ID, task UUID, client slug, invoice number, or thread ID - whatever uniquely identifies the resolved work.

## Origin

Apr 22 2026, ~13:10 AEST. Tate queried `os_scheduled_tasks` after seeing multiple "failed" scheduled tasks and asked "Oi why do your scheduled tasks keep failing..." Investigation showed four out of five recent late-firing delayed tasks were stale review checkpoints for Factory sessions that had already been approved and deployed via parallel workflow:

- `af6f9c30` - review-neo4jretrieval-tier1-fusion → session `7c9b5c12` deployed commit `1e4cda2`
- `1463a6d4` - review-ossession-wire-fused-retrieval → session `912f58e2` deployed commit `e3ceb08`
- `201f73a5` - review-tier4a-v2 → session `4537a71c` deployed commit `34eaa21`
- `f55b430f` - review-factory-c0bd85dc-taskdiff-v2 → session `c0bd85dc` deployed commit `d3b3c80`

My first response was "I'll start cancelling stale tasks going forward." Tate's reply at 13:14 AEST: "Are you actually going to start doing that or are you jsut saying that. Have you actually added it to your context/docs" - directly calling out symbolic logging. The real fix is: cancel the stale tasks NOW (done - same turn), codify the rule in this file (you are reading it), add a Neo4j Pattern node, and build the audit into every future approve/reject call site.

Related patterns:
- `factory-phantom-session-no-commit.md` - the ls-verification protocol before approve/reject (the companion audit for the other half of the approve flow)
- `neo4j-first-context-discipline.md` - end-of-turn durable writes (this pattern file is an example of end-of-turn write discipline)
