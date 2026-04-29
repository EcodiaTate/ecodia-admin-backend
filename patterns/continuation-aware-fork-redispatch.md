---
triggers: continuation-check, redispatch, fork-resume, fork-orphan, in-memory-state-loss, api-crash, partial-deliverables, work-resume, fork-lost, sibling-fork-recovery, redispatch-no-duplicate, check-existing-deliverables, file-mtime-check, kv_store-deliverable-check, status_board-deliverable-check, neo4j-deliverable-check, git-commit-deliverable-check, post-crash-redispatch, conductor-redispatch
---

# Continuation-aware fork redispatch - check existing deliverables before duplicating

## Rule

When redispatching a fork whose original was lost mid-flight (api crash, network failure, abort, pm2 restart, sdk timeout, in-memory state loss), the redispatch brief MUST instruct the fork to **check for existing deliverables on disk / kv_store / status_board / Neo4j / git BEFORE re-doing the work**. The fork must classify its starting state into one of three buckets and act accordingly:

- **All deliverables present and verified** -> verify, surface what already exists, exit clean. Do NOT re-do.
- **Partial deliverables present** -> complete only the missing pieces. Do NOT rebuild what is already there.
- **No deliverables present** -> do the full work as originally briefed.

Naive redispatch with the original brief on a fork whose work partially or fully shipped before the crash will:
- Burn fork token budget on no-op or duplicate work.
- Cause file conflicts (overwriting committed sibling-fork files).
- Trigger numbered-resource collisions (duplicate migration numbers, duplicate kv_store keys, duplicate status_board rows).
- Surface FORK_REPORT claims of "shipped" for work that was actually shipped pre-crash by the original fork (false-attribution drift).
- Risk regressing already-merged work on a now-stale baseline.

## The 5-substrate continuation check

Before doing any briefed work, a continuation-aware fork runs these probes in order. Each probe answers "did the prior fork already land this deliverable here?" The redispatch brief MUST list which substrates the deliverable touches and instruct the fork to check them.

| # | Substrate | Probe | Signal |
|---|---|---|---|
| 1 | Filesystem | `ls -la <expected_file>` and `stat -c %Y <file>` | File exists with mtime within the prior fork's window -> already done. |
| 2 | kv_store | `SELECT value, updated_at FROM kv_store WHERE key = '<expected_key>'` | Key exists with `updated_at` in prior-fork window -> already done. |
| 3 | status_board | `SELECT status, last_touched, context FROM status_board WHERE entity_ref = '<ref>'` | Row exists with `last_touched` recent and `context` references the prior fork id -> already done. |
| 4 | git commits | `cd <repo> && git log --oneline --since="<window>" --grep="<deliverable>"` (or by author/path filter) | Commit exists matching the deliverable -> already done. |
| 5 | Neo4j | `MATCH (n:<Label> {name: '<expected_name>'}) RETURN n.created_at, n.fork_id` | Node exists tagged with prior fork id -> already done. |

Not every fork touches all 5 substrates. The redispatch brief specifies which substrates apply and provides the exact probes the continuation-fork should run before acting.

## What the redispatch brief must contain

A redispatch brief that is continuation-aware includes, BEFORE the original task description:

```
CONTINUATION CHECK FIRST. The original fork (id: <original_fork_id>) was lost at <approx_time> due to <crash_cause>. Before doing any work in this brief, check for prior deliverables:

1. <substrate-1 probe with exact command and what to look for>
2. <substrate-2 probe with exact command and what to look for>
3. <substrate-N probe>

If ALL deliverables are present AND verified consistent: STOP. Surface what was found in [FORK_REPORT] with the prior fork's commit_sha / kv_store updated_at / status_board row id, and exit clean. Do NOT re-do the work.

If PARTIAL: complete ONLY the missing pieces. List what was found and what was missing in [FORK_REPORT]. Do NOT rebuild the present pieces.

If NONE present: proceed with the original brief below.

[Original brief follows]
```

The conductor pre-fills the substrate probes because the conductor knows what the original brief asked for. The fork follows them mechanically; the fork is not asked to "intuit" what to check.

## Do

- Pre-fill the 5-substrate probe list in the redispatch brief based on the original deliverable's substrates.
- Tell the fork what `prior_fork_id` to look for in author fields, fork-id stamps, kv_store row metadata, status_board context.
- Specify the time window (`since=<original_fork_dispatch_time>`) so the fork can filter to only the prior fork's mtime / commit window.
- Require the fork to surface what it found (or didn't) in `[FORK_REPORT]` so future-me can reconcile.
- Stamp the redispatch fork id in any new artefacts (so a future continuation-check can distinguish original vs continuation work).
- When deliverables are partial, instruct the fork to commit completion work as a SEPARATE commit referencing the original fork id (so blame / recovery is clean).

## Do NOT

- Do NOT redispatch the original brief verbatim without the continuation check. This is the failure mode this pattern exists to prevent.
- Do NOT trust the conductor's narration that "the original fork didn't get to step N before crashing" - check the substrates. Narration is unreliable per `verify-deployed-state-against-narrated-state.md`.
- Do NOT assume "fork crashed -> nothing landed". Forks commit incrementally; an abort at minute 8 of a 10-minute task may have shipped 80% of the deliverable already (parallel to the pre-kill-commit pattern: `check-pre-kill-commits-before-redispatch.md`).
- Do NOT treat status_board's last_touched as ground truth without cross-checking - status_board can be stale even when the deliverable shipped (per `status-board-drift-prevention.md`).
- Do NOT redispatch without verifying the original fork actually crashed vs. was just slow - check `mcp__forks__list_forks` for the original fork's terminal state first.
- Do NOT pick the next sequential number for migrations / numbered resources without re-reading the numbered space at write-time (per `parallel-forks-must-claim-numbered-resources-before-commit.md`) - the original fork may have committed N before crashing, and the redispatch must claim N+1.

## Protocol the conductor runs before redispatching

```
1. Verify the original fork is genuinely lost (not just slow):
   mcp__forks__list_forks status=any
   - If terminated/aborted/timeout: continuation-redispatch is appropriate.
   - If still running: do not redispatch; wait or send_message.

2. Identify what the original brief was supposed to deliver:
   - File paths.
   - kv_store keys (exact).
   - status_board entity_ref / row id.
   - Git branch + expected commit signature.
   - Neo4j node names + labels.

3. For each deliverable, write the exact probe the continuation-fork should run.

4. Compose the redispatch brief with the CONTINUATION CHECK FIRST block at the top, listing each probe and the action ladder (all-present / partial / none).

5. Pre-tag the brief with [APPLIED] continuation-aware-fork-redispatch.md because <reason>.

6. Dispatch. The fork will surface in [FORK_REPORT] which bucket it landed in.

7. After the redispatch lands, reconcile substrate state if drift is found (e.g. status_board still says "blocked" but the deliverable was found shipped pre-crash).
```

## Origin

30 Apr 2026, 24:01 AEST (00:01 AEST 30 Apr in absolute time). The ecodia-api process crashed mid-conversation, taking down 5 in-flight forks: `mok4h3r2`, `mok4hdfa`, `mok4hk0o`, `mok4jtfu`, `mok4khat`. PM2 respawned the api, but the in-memory fork state was lost - the forks themselves had been doing real work and some had committed partial deliverables before the crash.

Naive redispatch with the original briefs would have caused: duplicate migration numbers, duplicate kv_store keys, file overwrites of sibling-fork commits on shared branches, and false-attribution of work to the redispatch fork that was actually done by the crashed original.

The conductor instead composed 5 redispatch briefs each pre-pended with a CONTINUATION CHECK FIRST block listing the 5-substrate probes for that deliverable. Each redispatch fork ran the probes, surfaced what it found, and either exited clean (when prior work was complete), completed only the missing pieces (when partial), or did the full work (when nothing landed).

All 5 redispatches landed cleanly without duplicating prior work. The protocol was validated empirically. Codified at the moment per `codify-at-the-moment-a-rule-is-stated-not-after.md`.

Codified by fork_mok57rx9_308d21 at 24:19 AEST 30 Apr 2026.

## Cross-references

- `~/ecodiaos/patterns/check-pre-kill-commits-before-redispatch.md` - sibling pattern for pm2_restart-killed Factory sessions; same root rule different substrate (cc_sessions metadata vs git branch).
- `~/ecodiaos/patterns/factory-metadata-trust-filesystem.md` - filesystem is the source of truth for code state, not the metadata table.
- `~/ecodiaos/patterns/verify-deployed-state-against-narrated-state.md` - narration is unreliable; probe before propagating.
- `~/ecodiaos/patterns/distributed-state-seam-failures-are-the-core-infrastructure-risk.md` - the meta-rule; continuation-aware redispatch is one specific seam-failure recovery protocol.
- `~/ecodiaos/patterns/parallel-forks-must-claim-numbered-resources-before-commit.md` - companion rule for when the redispatch needs the next number after the prior fork's commit.
- `~/ecodiaos/patterns/stash-and-clean-when-finding-sibling-fork-unsafe-state.md` - sibling pattern for the working-tree case (uncommitted sibling-fork state on a shared branch).
- `~/ecodiaos/patterns/no-symbolic-logging-act-or-schedule.md` - "the protocol works" without writing the pattern is symbolic; this file is the act.
- `~/ecodiaos/patterns/codify-at-the-moment-a-rule-is-stated-not-after.md` - the meta-rule that triggered this file's authoring.
