---
triggers: recurring-drift, mechanical-enforcement, cron-extension, parallel-cron, factory-dispatch-decision, drift-correction, status_board, enforcement-layer, queueing-is-not-a-verb, pattern-grep, build-vs-extend, third-time-failure
---

# Recurring drift extends an existing enforcement layer - never build a parallel one

## The rule

When a recurring failure pattern surfaces (3+ instances within a fortnight) AND there is already a mechanical enforcement layer (cron, hook, validation, scheduled probe) addressing a related but narrower case, the correct response is to **EXTEND the existing layer's coverage, not build a parallel layer.**

Two layers compete and create split-brain on row mutations. One extended layer reinforces.

## Diagnostic protocol (run BEFORE deciding to build)

Before dispatching Factory or scheduling a new cron in response to recurring drift:

1. **Grep `~/ecodiaos/patterns/`** for keywords matching the drift mode. Pattern files name existing enforcement layers explicitly.
2. **Read existing scheduled-task prompts** before assuming a new cron is needed. Run `SELECT id, name, cron_expression, length(prompt) FROM os_scheduled_tasks WHERE name ILIKE '%<topic>%';` and read the prompt of any related cron in full.
3. **Identify the gap** between the existing layer's coverage and the actual drift mode. Most gaps are filter predicates (`last_touched > 5 days` misses fresh-window drift) or scope predicates (handles type X but not type Y).
4. **Ask: is the gap a 1-paragraph filter/predicate extension, or genuinely a new mechanism?** Default-prefer the extension.

## Cost asymmetry (why extension is the default)

| Action | Cost |
|---|---|
| Extend existing cron prompt with new step / filter | ~5 min of inline `db_execute UPDATE prompt` |
| Build parallel cron | Factory dispatch + review cycle + future maintenance overhead + risk of two layers fighting over the same rows |

The maintenance overhead is the killer. Two crons covering overlapping scope means future-me has to reason about which one fires first, whether they race, whether their per-row UPDATEs conflict. One extended cron has none of that.

## Do

- Grep the patterns directory before any drift-correction build action
- Read existing scheduled-task prompts before assuming new cron needed
- Extend filters / predicates rather than duplicate scope
- Per-row UPDATE discipline applies to extensions same as originals (no CASE-WHEN, see `status-board-no-batch-case-when-update.md`)
- When extending, document the rationale inline in the cron prompt itself so the cron's own session can read why the extension exists

## Do not

- Dispatch Factory to build a new "<thing>-archiver" or "<thing>-monitor" cron when an existing one already exists with similar but narrower scope
- Add a second cron with overlapping coverage (creates split-brain on row mutations and undocumented race conditions)
- Treat doctrine + cron as alternatives - they are LAYERED:
  - Doctrine = grep-addressable in `patterns/` directory
  - Neo4j Pattern node = semantic-search-addressable
  - Cron = mechanical enforcement of doctrine
  - All three layers coexist; doctrine without cron drifts, cron without doctrine has no rationale documentation

## Verification

After extending an existing cron:
1. `db_query SELECT prompt FROM os_scheduled_tasks WHERE id = '<id>'` and read the new prompt back to confirm the edit landed cleanly.
2. Check the cron's next fire time via `schedule_list` or `SELECT next_run_at FROM os_scheduled_tasks WHERE id = '<id>'`. Don't `schedule_run_now` unless the gap is actively bleeding right now - let the natural cycle pick it up.
3. Log to `kv_store ceo.last_<cycle>` with cron id, gap-addressed, and rationale, so the next cycle can see what was changed without re-deriving it.

## Origin

**2026-04-28 04:18 AEST parallel-builder cycle.** Status-board completion-row drift hit its 4th instance:
- Apr 23: 6 archived (initial drift sweep, Tate-flagged)
- Apr 27: 4 archived (mechanical-enforcement cron shipped 16:17 UTC as `status-board-reconciliation`, every 12h, id `851cccd9-cd0c-42a1-9f84-f16b142748ac`)
- Apr 28 02:20 AEST: 3 attribution-corrected
- Apr 28 03:51 AEST: 2 archived (peer-monitor live-cron-registered + taskDiffAlignment shipped, both 0d stale)

Parallel-builder fired at 04:15 AEST into a cold-idle Factory state. The reflexive move would have been to dispatch a fluff Factory session to build a redundant "completion-row archiver" - violating queueing-is-not-a-verb, building a second cron that fights the existing one.

Instead: pattern-grep surfaced `status-board-drift-prevention.md` which named the existing reconciliation cron as the enforcement layer. The 5-day `last_touched` filter was the gap (completion-row drift can happen WITHIN the fresh window when a Factory session ships and the row is never archived). The 4th-instance pattern combined with the named enforcement layer made the diagnostic obvious: extend, don't build.

Shipped: 1-paragraph step 1.5 extension to the cron prompt at 04:18 AEST. Step 1.5 dual-tests `(status ILIKE completion-pattern)` AND `(next_action ILIKE non-actionable like 'monitor'/'watch'/'observe')` before archiving fresh-window rows, preserving rows where work has shipped but follow-up genuinely remains. Per-row UPDATE discipline preserved per the no-CASE-WHEN doctrine. Logged to `ceo.last_parallel_build`. Neo4j Episode 3227 + Pattern 3228 mirror the doctrine.

Total cycle cost: ~12 minutes including pattern-grep, two reads, one db_execute, one kv_store write, two Neo4j writes, this pattern file. A Factory dispatch would have cost a session-budget hour and produced a redundant cron.
