---
triggers: factory, factory-running, worktree-contamination, diff-baseline, taskdiffalignment, contamination, doctrine-write, pattern-write, post-dispatch
---

# No doctrine writes to a worktree while Factory is running on it

## The rule

Once `start_cc_session` is dispatched against a codebase, do NOT write to that codebase's worktree (patterns/, drafts/, INDEX, docs, scripts, ANYTHING) until Factory completes and you have either approved or rejected. Doctrine writes during the Factory-running window inflate the diff baseline and trigger the `taskDiffAlignment` gate even when Factory's actual code change is correct.

## Why

`stage-worktree-before-factory-dispatch.md` says: commit pending files BEFORE dispatch so the worktree is clean. That covers the dispatch moment. But Factory takes 5-10 minutes. During that window, if you write Phase 5 documentation (pattern files, INDEX updates, drafts) into the same worktree, those writes are inherited by Factory's diff snapshot at completion time. The end-of-session diff now includes both Factory's code change AND your doctrine writes, and the alignment gate scores the union against Factory's task keywords - which doesn't mention "patterns/INDEX.md".

This is what happened on Factory 76d960a9 (sessionHandoff TEXT-vs-JSONB fix, 28 Apr 2026): Factory's diff was a clean 5-line cast fix. My Phase 5 writes (audit-low-confidence pattern, INDEX entry) added 2 unrelated files. Alignment scored 0.12, well under the 0.30 gate. Force-approval was correct (the code was right) but the gate fired on a noise signal I created.

## Do

- Treat the Factory-running window as a worktree freeze for that codebase
- Write doctrine to other locations during the window: Neo4j nodes, kv_store, drafts in a different repo, scratch files in /tmp
- Save pattern files and INDEX edits for AFTER you've approved/rejected the Factory session
- If you must capture an insight while Factory is running, write a Neo4j Episode immediately (no worktree touch) and queue the pattern file for after

## Do not

- Write into `~/ecodiaos/patterns/`, `~/ecodiaos/drafts/`, or any tracked file in the codebase Factory is operating on, while it is operating
- Edit INDEX.md or any other curated index during the window
- Justify alignment-gate failures as "false positives" without checking whether YOU contaminated the diff first

## Verification

When `taskDiffAlignment` flags a session, before claiming false-positive:
1. Check `git log --oneline ~/ecodiaos -n 3` for any commits during the Factory window
2. Check `git status ~/ecodiaos` for uncommitted writes that landed during the window
3. List the filesChanged from `review_factory_session` and ask: are any of these files I touched, not Factory? If yes, that's contamination, not Factory drift.

If contamination is confirmed, the correct response is `force=true` with explicit notes referencing this pattern, not silent override.

## Origin

2026-04-28 07:18 AEST. Factory session 76d960a9 (sessionHandoff TEXT-vs-JSONB second-attempt fix) shipped a correct 5-line cast fix. Alignment gate fired at 0.12, filesChanged showed 4 instead of 2. Investigation traced inflation to Phase 5 doctrine writes I made AFTER dispatch but BEFORE Factory completed: `patterns/audit-low-confidence-factory-commits-on-critical-path.md` (new file) and `patterns/INDEX.md` (1 row added). Factory's worktree snapshot at completion inherited both. Force-approved correctly because the code change was clean, but the gate signal was noise I generated.

This is distinct from `stage-worktree-before-factory-dispatch.md`, which I followed correctly at dispatch time (commit 3bdd14d cleaned the worktree pre-dispatch). The new failure mode is the post-dispatch, mid-Factory window.
