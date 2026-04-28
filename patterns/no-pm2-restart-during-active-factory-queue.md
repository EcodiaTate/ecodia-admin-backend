---
triggers: pm2-restart, ecodia-api, factory-queue, cleanup-on-shutdown, listener-subsystem-deploy, infrastructure-restart, factory-session-killed
---

# Never PM2-restart ecodia-api while Factory sessions are running or queued

**Rule:** Before issuing `pm2_restart ecodia-api`, check `mcp__factory__get_factory_status`. If `activeSessions > 0` OR there are `queued` / `awaiting_review` sessions in `recent`, do NOT restart. Wait for the queue to drain, OR explicitly accept the cost and re-dispatch after.

**Why:** `cleanupOnShutdown()` in the Factory dispatcher marks every active and queued cc_sessions row as `status='error'`. The Factory worker process inside ecodia-api is killed mid-flight. Whatever code Factory was about to commit is lost. Re-dispatching pays the same context-build + diff-generation cost again.

**The cost is not theoretical.** On 2026-04-28 14:05 AEST I issued multiple pm2_restart cycles to load the Wave A listener subsystem. Three Factory sessions were running or queued at the time:
- `cc:81c760a9` chambers v2 marketing site (~30 min in)
- `cc:370214f4` chambers branding addendum 3 (~50 min in)
- `cc:264d6395` Wave B listener triplet (~60 min in)

All three transitioned to `status='error'` at `completed_at='2026-04-28T04:05:13.170Z'` — the exact second of my last pm2_restart. ~140 min of Factory time torched. Each will need re-dispatch and full context re-build when Tate is back.

**Do:**
1. Run `mcp__factory__get_factory_status` BEFORE any pm2_restart of ecodia-api.
2. If queue is non-empty: wait, OR cancel/redispatch as a deliberate decision (not as collateral damage).
3. If you must restart with active sessions, log the cost in status_board ("X sessions killed, re-dispatch when Tate available").
4. Plan listener-subsystem deploys for windows when the queue is naturally empty (e.g. directly after a Factory session completes and before dispatching the next).
5. Verify dbBridge / new infrastructure via ground truth (e.g. `pg_stat_activity` for LISTEN connections) instead of pm2_logs alone — winston log capture can be incomplete. The DB does not lie.

**Do not:**
1. Cascade multiple pm2_restart calls in quick succession to "make the new code take effect." One restart is enough; if the change doesn't appear, debug, don't repeat.
2. Read pm2 logs as the only source of truth for whether a subsystem started. Logs are async-buffered and capture is windowed. Cross-check via the actual side effect (open connection, registered subscription, etc.).
3. Treat a stable PM2 restart_count as confirmation nothing crashed. The count from the previous day is preserved across the new restarts; look at uptime and recent log timestamps instead.

**Verification protocol after a listener-subsystem-style deploy:**
1. `pg_stat_activity` shows the expected `LISTEN "channel_name"` row with a recent `backend_start`.
2. Health check (`/api/health`) returns 200.
3. No accelerating restart_count climb after the initial restart.
4. Trigger the side effect (write a test row, watch the listener handle it via its own log line or status update).

**Origin:** 2026-04-28 14:05 AEST. Wave A listener subsystem deploy. Three Factory sessions killed at PM2 cleanup-on-shutdown when I cycled `ecodia-api` to load the new dbBridge. Verification of dbBridge via `pg_stat_activity` later showed it WAS listening — the cycling was unnecessary after the first restart, and the second/third/fourth restarts were the ones that took out the queued sessions. Cost: ~140 min Factory time + re-dispatch overhead.

**See also:**
- `factory-metadata-trust-filesystem.md` — when Factory metadata disagrees with on-disk evidence, trust on-disk.
- `factory-quality-gate-over-cron-mandate.md` — never sacrifice Factory work for a scheduled tick.
