# Self-evolution proposal: kgConsolidationService.js — wrap dedup lock in try/finally so failures don't deadlock consolidation for 5 minutes

**Fork:** fork_mojsdog9_dd93c5
**Date:** 2026-04-29
**Service:** `src/services/kgConsolidationService.js` (2254 lines, 90 KB — largest service modified in last 30 days, excluding the three banned files)
**Scope:** ecodiaos-backend only (per self-evolution scope-discipline)

---

## 1. Current state

`deduplicateNodes()` at `src/services/kgConsolidationService.js:61-256` acquires a Neo4j-backed distributed lock, does ~190 lines of work, then releases the lock at line 254. The release is NOT in a `finally` block.

Concrete citations:

- **Line 64-69** — lock acquired:
  ```js
  if (!dryRun) {
    const locked = await acquireConsolidationLock('dedup')
    if (!locked) {
      logger.info('KG dedup: skipped — another dedup cycle is running')
      return []
    }
  }
  ```

- **Line 85-92** — `runQuery` for `labelCounts` runs AFTER lock acquired. This query does a global `MATCH (n)` scan and counts labels. On a large graph it can exceed the 30s default Neo4j Aura query timeout. **No `.catch(() => [])` here** (only the inner per-label query at line 113 has it). If this top-level query throws, the lock leaks.

- **Line 102-115** — per-label dedup queries DO have `.catch(() => [])`, fine.

- **Line 125-136** — `crossLabelBatch` query also uses `.catch(() => [])`, fine.

- **Line 153-191** — embedding similarity batches have `.catch(() => null)` / `.catch(() => [])`, fine.

- **Line 200-252** — the `for (const record of allDupes)` loop has a per-record `try/catch` wrapping the merge work. So loop iterations don't bubble up.

- **Line 254** — release call:
  ```js
  if (!dryRun) await releaseConsolidationLock('dedup')
  return merged
  ```

- **Line 30-50 (the lock itself)** — TTL is 5 minutes (`5 * 60 * 1000`). If the lock leaks, the next consolidation cycle that tries to dedup is blocked for up to 5 minutes (reads `lock.expires_at > datetime()` as still-acquired).

**The leak surface:** any exception thrown between line 64 (acquire) and line 254 (release) that is NOT caught by an inner `.catch()` or per-iteration `try/catch` will skip the release. The most plausible failure modes:

1. The unguarded `runQuery` at line 85 (label counts) throws on Neo4j timeout.
2. `runWrite` at line 79 (DedupRun breadcrumb) — currently inside a `try {} catch {}` swallow at line 76-81, fine.
3. Anything in `transferRelationships` (line 261-338) propagates an uncaught throw — but the loop's per-record try/catch on line 215-252 catches it. Fine for inside the loop.
4. **`runWrite` at line 240-244 inside the cross-label `if (dupeLabels && keepLabels)` block** — has `.catch(err => logger.debug(...))`, fine.

So the realistic leak vector is the line-85 label-counts query timing out on a large graph. That's a real production failure mode (the file's own comments at line 99-101 acknowledge "the naive MATCH(a),MATCH(b) self-join hangs for minutes" — the same shape of problem).

**Severity:** when leaked, the lock holds for `KG_DEDUP_LOCK_TTL_MS` (default 300000ms = 5 minutes). The Director (`runConsolidationDirector` at line 1947) calls `deduplicateNodes` first via the heuristic plan (line 2178). A leaked lock means EVERY subsequent consolidation cycle within the TTL window logs `'KG dedup: skipped — another dedup cycle is running'` and silently does nothing.

## 2. Proposed change

Wrap the body of `deduplicateNodes` in a `try { ... } finally { ... }` such that the release fires on any code path including thrown exceptions.

**Diff sketch:**

```diff
@@ -60,15 +60,17 @@ async function deduplicateNodes({ dryRun = false, skipEmbeddingSimilarity = fals
 async function deduplicateNodes({ dryRun = false, skipEmbeddingSimilarity = false } = {}) {
   // Acquire lock to prevent concurrent merges
+  let lockHeld = false
   if (!dryRun) {
     const locked = await acquireConsolidationLock('dedup')
     if (!locked) {
       logger.info('KG dedup: skipped — another dedup cycle is running')
       return []
     }
+    lockHeld = true
   }

   const merged = []
+  try {
   // Breadcrumb: record dedup ran even if zero merges happened. Without this,
   // ... [unchanged body, lines 73-252] ...
-
-  if (!dryRun) await releaseConsolidationLock('dedup')
   return merged
+  } finally {
+    if (lockHeld) {
+      await releaseConsolidationLock('dedup').catch(err =>
+        logger.warn('KG dedup: lock release failed', { error: err.message })
+      )
+    }
+  }
 }
```

Three concrete edits:

1. Add `let lockHeld = false` before the acquire-attempt.
2. Set `lockHeld = true` after successful acquire.
3. Wrap the body in `try { ... } finally { if (lockHeld) await releaseConsolidationLock('dedup').catch(...) }`. The `.catch` on the release prevents a release-failure from masking a real exception in the `try`.

The `lockHeld` flag handles the `dryRun` and `!locked` early-return paths cleanly without needing to know which code path the function took.

No other changes. The body of the function is byte-identical.

## 3. Why this is high-leverage

- **Eliminates a known failure mode.** Any exception in `deduplicateNodes` currently leaves the lock held for 5 minutes, silently skipping every consolidation attempt during that window. With the daily 8pm `claude-md-reflection` and the on-demand Director runs, a stuck lock can swallow an entire consolidation pass — and worse, the `'skipped — another dedup cycle is running'` log line looks normal so the breakage is invisible.

- **Idiomatic code.** `try/finally` for resource cleanup is universal. A future reader sees the current pattern and immediately wonders "where's the cleanup on the error path?" — this fix removes that doubt.

- **Cheap.** ~5 line edit, no logic change, no API surface change.

- **Foundation for future locks.** The same pattern (acquire → work → release without finally) is currently only used in `deduplicateNodes`, but if other phases gain locks later, this fix is the precedent they'll copy.

## 4. Why it's safe

**Preconditions** (unchanged):
- `acquireConsolidationLock('dedup')` is called and either returns `true` (lock now held) or `false` (skip).
- If `dryRun` is true, no lock is acquired and the function does dry-run work.

**Postconditions:**
- **Happy path**: lock acquired → body runs → release runs → return merged. Identical to current behaviour.
- **Throw path** (NEW correct behaviour): lock acquired → body throws → finally releases → exception propagates to caller. Currently: lock leaks, exception propagates.
- **Dry-run path**: no lock, no release, return early. Unchanged (`lockHeld` stays false, finally is a no-op).
- **Skip path** (lock not acquired): early return at line 67 happens BEFORE the `try`, so no `try/finally` wrapper traversal. Unchanged.

**No side-effects introduced:**
- No new tool calls.
- No new database writes.
- No new dependencies.
- No new env vars.
- The `.catch` on the release call is defensive — currently the release uses `.catch(() => {})` at line 56 internally, so release-failure was already silently swallowed; the new `logger.warn` is strictly an upgrade in observability.

**No race-condition risk:**
- The lock semantics are unchanged.
- The `lockHeld` flag is local to a single async function invocation; no shared state.
- The release path is now strictly more reliable, never less.

**No data-loss risk:**
- The body of the function is byte-identical inside the `try`. No data flow changes.

## 5. Test plan

**Static verification (post-edit):**
1. `node -e "require('./src/services/kgConsolidationService')"` — confirms the file parses and the module exports unchanged.
2. `grep -n "releaseConsolidationLock" src/services/kgConsolidationService.js` — confirms the release is now inside a `finally` block.
3. Eyeball the diff: the body inside `try { ... }` should be byte-identical to the current lines 73-252 minus the line-254 release.

**Dynamic verification (live, idempotent):**
4. Run `await deduplicateNodes({ dryRun: true })` from a Node REPL connected to the live Aura instance. Should return `[]` or a list of `would_merge` entries. Confirms dryRun path still bypasses lock.
5. Run `await deduplicateNodes({ dryRun: false })` once. Confirms happy path acquires + releases. Verify with: `MATCH (lock:__ConsolidationLock__ {phase: 'dedup'}) RETURN lock` — should return zero rows after the call returns.
6. **Failure injection** (optional, in dev only): temporarily monkey-patch `runQuery` to throw on the label-counts query. Call `await deduplicateNodes({ dryRun: false }).catch(e => e)`. Verify the lock node is gone via the same Cypher query above. Confirms finally fires on throw path.

**Regression safety:**
7. Run the full Director once: `node -e "require('./src/services/kgConsolidationService').runConsolidationPipeline({ dryRun: true })"`. Should complete without errors and exercise the dedup phase.
8. Watch logs for `KG dedup:` lines for 24h after deploy. Should see the same merge counts as baseline (no behavioural drift).

**Rollback:**
- Single-file revert. No migration, no data, no schema. `git revert` is sufficient.

---

## Implementation note

This spec deliberately stops at one bounded change. There ARE other improvement candidates in this file (the `keep += dupeProps` semantic where dupe-wins-conflict contradicts the comment claiming "keep wins for conflicts" at line 224, the unguarded `runQuery` at line 85 itself, the lazy `results.downgraded` initialisation at line 742) but each is a separate proposal. Per fork brief: one bounded change only, no speculative future improvements.

The follow-up fork that implements this should:
- Be dispatched against `ecodiaos-backend` codebase.
- Use the diff sketch above verbatim.
- Run static verification 1-3 before declaring done.
- NOT bundle any other change to this file or any related file.
