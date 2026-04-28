---
triggers: pm2-restart, pm2_restart, ecodia-api restart, session-restart, restart-needed, kill-session, infra-fix, fork-orphan, orphaned-fork, kv_store handoff, post-deploy fork dispatch, sequenced fork, follow-up fork, ship-then-restart, restart-kills-session, compaction-fix, sdk-bump, osSessionService restart, parent-child fork, child-process-orphan
---

# Pre-stage fork briefs in kv_store before any session-killing operation

## The rule

When a high-leverage operation will kill the live OS session (PM2 restart, system update, deploy that touches `osSessionService.js`, `forkService.js`, or any module loaded into the api process), the work that must run AFTER the session comes back is at risk. The new session boots cold and may not know what to do beyond the handoff state. Solution: pre-stage every follow-up fork brief in `kv_store` under key `forks.staged.<context>` as JSON BEFORE the kill, then save handoff state pointing to that key.

## Why

Forks are children of `ecodia-api`. When the api process restarts, in-flight forks orphan with `status='spawning'` or hung mid-tool. Briefs you intended to dispatch "after the fix lands" are lost if you kept them only in your in-context turn state. The new session reads the staged JSON and dispatches in a single message via `mcp__forks__spawn_fork` x N - zero re-thinking, zero context-loss.

## Do

1. Before triggering the kill: write all follow-up briefs into kv_store as one JSON value under a descriptive key.
   - Key naming: `forks.staged.<context>` (e.g. `forks.staged.next_dispatch`, `forks.staged.post_compaction_fix`).
   - Value shape: `{"fork_a": {"name": "...", "brief": "..."}, "fork_b": {...}, "context": "why these are sequenced"}`.
2. Save a handoff state via `POST /api/os-session/save-state` that explicitly points to the kv_store key. The `active_plan` field should say "Read kv_store key X. Spawn forks A and B in a single message via mcp__forks__spawn_fork with context_mode=brief."
3. Trigger the kill (merge, restart, deploy).
4. New session wakes, reads handoff, reads the staged briefs, dispatches.
5. After consumption: `DELETE FROM kv_store WHERE key = '<the key>'` so a future unrelated session does not fire stale briefs.

## Do NOT

- Keep follow-up briefs only in your turn-context. They die with the session.
- Forget the cleanup `DELETE` after the new session consumes them. Stale staged briefs can mis-fire if the same key is reused later.
- Pre-stage briefs that depend on data not yet written. The staged brief is read verbatim by the next session - any TODO placeholders will be passed through unfilled.
- Use this for trivial follow-ups that can re-derive themselves from status_board. Reserve it for work where the EXACT brief matters and the new session would need full context to recreate it.

## Protocol when applying

1. Decide the kill operation is necessary (e.g. PM2 restart to load new SDK).
2. Write the follow-up briefs in full, INCLUDING the explicit `DEPLOY VERIFY` header where applicable (the brief-check hook is enforced even on staged briefs when the new session dispatches them).
3. Insert into kv_store:
   ```sql
   INSERT INTO kv_store (key, value, updated_at)
   VALUES ('forks.staged.next_dispatch', $${"fork_a": ..., "fork_b": ...}$$::jsonb, NOW())
   ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW();
   ```
4. Save handoff:
   ```bash
   curl -X POST http://localhost:3001/api/os-session/save-state -d '{"current_work":"...","active_plan":"On wake-up: read kv_store forks.staged.next_dispatch and dispatch both forks in parallel.", ...}'
   ```
5. Execute the kill operation.
6. New session wakes -> reads handoff -> reads kv_store -> dispatches forks -> deletes kv_store key.

## Origin

Apr 28 2026 22:24-22:30 AEST. Compaction-fix (PR #2 ecodiaos-backend, SDK 0.2.92->0.2.121 + `[1m]` suffix on `OS_SESSION_MODEL`) required a PM2 restart of `ecodia-api` to land. Earlier in the same session, 4 forks had been orphaned by a prior api restart at 12:20 UTC (2 errored at spawn with exit-1, 2 hung in `spawning` state). To avoid losing the next round of work, pre-staged Jess-collective-bug + 3-PR-visual-verify briefs in `kv_store.forks.staged.next_dispatch` before the merge+restart. New session woke at 22:30 AEST, read the key, dispatched both in a single message within the first turn. Zero re-thinking. Doctrine codified into Pattern node 3603 and this file.

## Cross-references

- `kv_store.session.handoff_state` - the existing per-session handoff (different key, different lifecycle, complementary not duplicate).
- `src/services/sessionHandoff.js` `readHandoffState()` - the consumer.
- Decision 3592 (visual-verify-as-merge-gate, ecodiaos-internal merges authorized).
- Decision 3598 (brief-check Check 3 negation guard fix - sequenced via this pattern).
- Pattern: `neo4j-first-context-discipline.md` (the new session must read Neo4j on wake to verify what kv_store says).
