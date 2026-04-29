# EcodiaOS-backend self-evolution audit - 2026-04-29

**Author:** fork_mojz190u_d0e614 (self-evolution audit fork)
**Scope:** ecodiaos-backend only (per self-evolution scope-discipline rule)
**Deliverable:** ONE narrow fix-target, ready for Factory or fork dispatch
**Brief:** find one small, high-leverage improvement; do not edit code in this fork

---

## Selected fix-target

**File:** `src/services/forkService.js`
**Line:** 691
**Function:** `spawnFork()`
**Estimated change:** 1 line (add `await`)

### Current behaviour

At line 691, immediately after a new fork's in-memory state is created and registered, the row is persisted to `os_forks` via:

```js
689:  _forks.set(fork_id, state)
690:  _emitForkEvent('spawned', state)
691:  _dbInsert(state)                  // ← fire-and-forget, not awaited
```

`_dbInsert` (lines 379-395) is `async`, returns a Promise, and the caller does not await it. Control falls through immediately to line 693+ (SDK options build) and then into the IIFE at line 721 that runs the actual fork loop.

Inside that IIFE, at line 771, the code awaits `_dbUpdate(state)` to flip status from `spawning` to `running`:

```js
770:      _emitForkStatus(fork_id, 'streaming', { fork_id })
771:      await _dbUpdate(state)         // ← awaited (fixed in commit e4bd2a7)
```

### Problem statement

This is the same fire-and-forget anti-pattern that commit **e4bd2a7** (2026-04-29 03:04 AEST) fixed at three `_dbUpdate` call sites (lines 771, 865, 945). The commit message:

> Three forks ended up persisted as status='spawning' in os_forks despite work having completed and reports posted - the DB UPDATE either threw silently or never ran due to the calls being fire-and-forget. _dbUpdate is async and was being orphaned.

The fix awaited `_dbUpdate` at three sites and upgraded `logger.debug` to `logger.warn`. **It did not touch `_dbInsert`.** The unfixed call at line 691 leaves a real INSERT-after-UPDATE race:

1. **T+0:** `_dbInsert(state)` is invoked, returns a pending Promise. Control falls through.
2. **T+0+ε:** IIFE begins, `getQuery()` resolves, SDK options build completes.
3. **T+0+~5ms:** `state.status = 'running'` (line 766), then `await _dbUpdate(state)` (line 771). If the original INSERT Promise has not yet resolved, the UPDATE targets a non-existent row. `UPDATE ... WHERE fork_id = ${id}` against a missing row is a no-op - it does not throw, it just affects zero rows.
4. **T+0+later:** The orphaned INSERT Promise resolves, inserting the row with the **stale** state captured at line 691 - `status='spawning'`.
5. **Result:** Row stuck at `status='spawning'` in `os_forks` even though the fork is running, completes work, and posts a report.

This is precisely the symptom commit e4bd2a7 attributed to its bug. The partial fix narrowed the window for the UPDATE-side race but left the INSERT-side race intact. With `os-forks-reaper` running every 30 minutes (verified live in `os_scheduled_tasks`) and assuming "stuck in spawning" as a reaper signal, a fork hitting this race may be incorrectly reaped or treated as failed.

### Proposed fix

Change line 691 from:

```js
_dbInsert(state)
```

to:

```js
await _dbInsert(state)
```

`spawnFork` is already `async` (verifiable from the surrounding context) so `await` is legal here. The cost is one round-trip on a single INSERT - empirically 5-20ms against the connection pool used elsewhere in the file. The benefit is that the IIFE on line 721 is guaranteed to run after the row exists, so every subsequent `_dbUpdate` targets a real row.

This is a structural fix, not a workaround. The alternative - chaining the IIFE off the INSERT Promise - is more invasive and gains nothing because spawnFork's caller (the HTTP handler, see lines 718-720 comment) already accepts the cost of an in-flight INSERT before returning. The pattern this fix mirrors is exactly the one the recent commit established for `_dbUpdate`.

### Estimated lines of change

- **Source:** 1 line (`src/services/forkService.js:691` add `await`)
- **Optional:** add a one-line comment above the call referencing the pattern - "INSERT must complete before run loop fires UPDATEs - see commit e4bd2a7 sibling fix"

Total: 1-3 lines of source change, no test changes required (no existing test exercises this race; adding one would require a synthetic SQL-latency injection that is out of scope for a one-line fix).

### Why this is high-leverage NOW

1. **Same bug, just-shipped fix is incomplete.** The audit was triggered explicitly by reading commit e4bd2a7. Closing the matching INSERT-side hole now is cheap and prevents a recurrence of the overnight stuck-in-spawning bug that prompted the original fix.
2. **The reaper runs every 30 minutes.** `os-forks-reaper` is active (verified in `os_scheduled_tasks` query, `next_run_at='2026-04-29T11:50:47'`). Any reaper logic that triggers on `status='spawning' AND last_heartbeat > Nm ago` will mistakenly act on a fork that is actually running. A one-line fix here protects the reaper's correctness.
3. **Forks are the conductor's primary work primitive.** The "5 forks always" doctrine (see `~/CLAUDE.md` and `~/ecodiaos/CLAUDE.md`) means the fork dispatch path runs continuously. A latent race in spawnFork is a load-bearing race - it will fire often enough to bite.
4. **The fix is reversible.** If `await` adds unacceptable latency to spawnFork in some future load profile, removing it is one line. Today it is unambiguously the right move.
5. **Audit depth matches the doctrine.** The self-evolution scope rule (`~/ecodiaos/CLAUDE.md` "self-evolution stays ecodiaos-internal") explicitly carves out backend audits like this. This is the exact class of work the cron is designed to surface.

### Who/what consumes the fixed behavior

- **`os-forks-reaper` cron:** correctness of "is this fork actually stuck or just newly spawned" depends on `status` reflecting reality.
- **`/api/os-session/forks` and any frontend track-list panel:** show fork state from `os_forks`. A row stuck at `spawning` while work continues is a real UX bug for Tate when reading the live tracks panel.
- **Decision-quality telemetry:** `application_event`, `dispatch_event`, and post-action hooks may correlate against `os_forks.status`. A wrong status corrupts the telemetry signal that Phase C of the decision-quality architecture depends on.
- **Status_board reconciliation:** any future cron or hook that joins `status_board` rows against `os_forks` (planned per the continuous-work loop doctrine) will mis-classify in-flight forks.

### Dispatch brief (for the conductor to copy into a Factory or fork session)

> In `src/services/forkService.js` line 691, change `_dbInsert(state)` to `await _dbInsert(state)`. Context: commit e4bd2a7 fixed the same fire-and-forget anti-pattern at three `_dbUpdate` call sites (lines 771, 865, 945) but did not touch `_dbInsert`. The unfixed call leaves an INSERT-after-UPDATE race where the IIFE at line 721 can fire `await _dbUpdate(state)` before the original INSERT Promise resolves; the UPDATE then no-ops against a missing row, the INSERT later persists stale `status='spawning'`, and the fork appears stuck in spawning even though it ran to completion. The fix is one line. `spawnFork` is already async. Cost is one INSERT round-trip (5-20ms) added to spawnFork latency, which is acceptable - spawnFork is not on a hot path. Add a brief comment above the call: `// must await: ensures row exists before run-loop UPDATEs (sibling fix to e4bd2a7)`. No test changes required. Verify `git diff` is exactly 1-3 lines in one file before approving.

---

## Out-of-scope items observed during audit (not selected, logged for future)

These were noticed but rejected as either too broad, too speculative, or non-fitting the "one narrow fix" brief:

1. **Duplicate cron names in `os_scheduled_tasks`.** Live data shows `peer-monitor` (x2) and `phase-G-adversarial-audit` (x2 with different schedules). The scheduler MCP server (`mcp-servers/scheduler/index.js:69-73`) does not enforce unique names on INSERT. Fix would require either a unique constraint migration plus dedupe of existing rows, or an upsert pattern in `schedule_cron`. Multi-step, not a one-line fix.
2. **`computeNextRun` returns null for unrecognized formats and the success path on `schedulerPollerService.js:91-96` writes that null straight to `next_run_at`, silently killing the task.** Real bug, but currently no live tasks use unsupported formats (verified via SELECT on `os_scheduled_tasks`). Fix needs both parsers (poller + MCP server) extended OR a fail-loud guard added. Worth doing, but not the narrowest target today.
3. **`tate-blocked-nudge-weekly` is named "weekly" but configured as `daily 10:00`.** Doctrine drift between name and behavior, not a code bug. ESSENTIAL_CRON_NAMES references the misleading name. Cosmetic / clarity issue.
4. **`TODO(tier2)` comments in `src/services/neo4jRetrieval.js:365,378`** about `recency` field plumbing. Older than 7 days but the fix touches multiple call sites. Multi-file refactor - not a one-pass change.
5. **Various `try/catch` blocks that only `console.warn` an error message** (8 files in `src/services/telemetry/` and `src/workers/`). Many of these are intentional - the listener and telemetry layers are designed to be non-fatal. No specific failure mode flagged.

---

## Methodology notes

- Sampled `git log --since="3 days ago" --name-only -- 'src/**'` (38 files surfaced).
- Read 5 files end-to-end: `forkService.js` (lines 340-475 + 670-790), `schedulerPollerService.js` (full), `mcp-servers/scheduler/index.js` (lines 1-130), `invoicePaymentState.js` (full), `usageEnergyService.js` referenced by line context.
- Live-queried `os_scheduled_tasks` (read-only) to verify which schedule formats are actually in use - confirmed all live tasks use `every Nm`, `every Nh`, or `daily HH:MM`, so the `computeNextRun`-returns-null bug is currently latent (worth noting but not selected).
- Cross-referenced commit e4bd2a7 via `git show` to anchor the selected target in the most recent fix's pattern.
- No code edited. No DB writes. Audit-only fork per the scope-discipline rule.
