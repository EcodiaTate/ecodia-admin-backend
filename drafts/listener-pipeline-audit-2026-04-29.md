# Listener Pipeline Audit - 2026-04-29 (fork_mok3vxmt_3b4512)

**Audit window:** 23:43 AEST 29 Apr 2026 (cold-state probe).
**Audit fork id:** fork_mok3vxmt_3b4512 (audit-only; no implementation).
**Last wave shipped:** Wave C (invoicePaymentState, PR #6, commit 56008bd, Apr 28 22:55 AEST).

---

## Executive summary - the dominant finding

**5 of 7 listener modules are DARK in production despite shipped code.** The standalone `node -e "registry.loadListeners()"` loads all 7 modules cleanly. The PM2 `ecodia-api` production process consistently loads only `smoke` + `ccSessionsFailure` and then dies silently in the for-loop after the dbBridge.js skip. The "listener subsystem: registered/started" boot lines have NOT appeared in `ecodia-api-out.log` since `2026-04-28T01:30:33Z` - i.e. EVERY boot in the last 60 hours has booted with the listener subsystem half-loaded and `registerAll()` never reached.

This is the **same root cause flagged 28 Apr 2026** in Neo4j Episode "Listener registry only loads 2 of 7 in production process - root cause UNRESOLVED 2026-04-28" - now confirmed still unresolved 60+ hours later. The brief asks "what's the next listener to ship?" - the honest answer is **NO NEW LISTENERS until the load-loop bug is fixed**. Adding a Wave D listener to a registry that doesn't load 5/7 of the existing listeners is symbolic shipping.

---

## Section 1: Listener inventory

Live state of `~/ecodiaos/src/services/listeners/` (8 .js files + index + registry + bridge + smoke):

| File | name | subscribesTo | Producer-feed (table.action) | Loaded in production? | Last verified firing |
|---|---|---|---|---|---|
| _smoke.js | smoke | text_delta | (registry-pipeline noop, relevanceFilter always false) | YES | n/a (noop) |
| ccSessionsFailure.js | ccSessionsFailure | db:event | cc_sessions.UPDATE (status=error OR stage=failed/error) | YES | recent (cc_sessions_7d=86) |
| dbBridge.js | (LISTEN/NOTIFY bridge, not a listener) | n/a | LISTEN eos_listener_events | YES (skipped correctly with the documented "missing required fields" warn) | n/a |
| emailArrival.js | emailArrival | db:event | email_events.INSERT | **NO (load-loop dies before reaching it)** | never (email_events table = 0 rows historical) |
| factorySessionComplete.js | factorySessionComplete | db:event | cc_sessions.UPDATE (status=complete/rejected, stage in awaiting_review/complete) | **NO** | never in production (despite cc_sessions_7d=86) |
| forkComplete.js | forkComplete | db:event | os_forks.UPDATE (terminal status OR last_heartbeat>10m stale) | **NO** | never in production (despite os_forks_7d=245) |
| index.js | (boot entry, excluded by name) | n/a | n/a | n/a | n/a |
| invoicePaymentState.js | invoicePaymentState | db:event | staged_transactions.INSERT (amount_cents>0) | **NO** | never (staged_txn_7d=0, invoice_payment_matches_total=0) |
| registry.js | (loader, excluded by name) | n/a | n/a | n/a | n/a |
| statusBoardDrift.js | statusBoardDrift | db:event + 30min timer | status_board.INSERT/UPDATE + scheduled drift query | **NO** | never (timer never starts because index.js's start() loop never reaches it) |

**Loader contract:** `registry.js` requires every listener module export `{ name, subscribesTo, relevanceFilter, handle }` and rejects modules that import `osSessionService`. All 7 modules conform. The wake path is consistently `axios.post http://localhost:3001/api/os-session/message` - never a direct service import.

**Producer triggers verified via `pg_get_functiondef(eos_listener_notify_compact)`:**
- `trg_cc_sessions_status_notify` (UPDATE) - ✅ live
- `trg_email_events_insert_notify` (INSERT) - ✅ live (but writer not wired - see §3)
- `trg_os_forks_status_notify` (UPDATE) - ✅ live
- `trg_staged_transactions_insert_notify` (INSERT) - ✅ live
- `trg_status_board_notify` (INSERT and UPDATE) - ✅ live

The pg_notify channel is `eos_listener_events` and the payload is a per-table column-whitelisted compact JSONB (the 8KB pg_notify cap fix shipped in Wave A as `eos_listener_notify_compact()`).

---

## Section 2: Wave breakdown - what shipped, what's outstanding

**Wave A** (commit 8af4170, Apr 28 14:18 AEST, Episode "Wave A deploy + pm2_restart cascade post-mortem")
- Promised: registry/dbBridge/index foundation, ccSessionsFailure + factorySessionComplete listeners, cc_sessions + email_events triggers, eos_listener_notify_compact function (live-edit fix to 165KB payload bug).
- Shipped on disk: ✅ all of the above.
- Live in production: ⚠️ ccSessionsFailure only. factorySessionComplete is dark (load-loop bug, see §3).

**Wave B** (commit 4bf6aa0e, Apr 28 ~14:30 AEST, Episode "Wave B/C listener ship")
- Promised: emailArrival, statusBoardDrift, forkComplete + os_forks trigger (migration 064).
- Shipped on disk: ✅ all three modules + migration 064 trigger live.
- Live in production: ❌ NONE of the three load. statusBoardDrift `start()` timer never fires.

**Wave C** (PR #6 commit 56008bd, Apr 28 22:55 AEST, Episode "invoicePaymentState listener producer-feed wired")
- Promised: invoicePaymentState listener, refactored from kv_store-projection to direct invoices SELECT (the producer-feed-mismatch lesson). Migration 065 (invoice_payment_matches table) + migration 066 (staged_transactions trigger).
- Shipped on disk: ✅ module + both migrations applied. Field-name bug (`amount_cents_inc_gst`→`total_cents`) fixed.
- Live in production: ❌ does not load. Even if it did, staged_transactions_7d=0 (no bank imports in 7 days) so no real-world firings yet.

**Wave D** (not yet planned, dispatched, or scoped)
- This audit is the input that should produce the Wave D scope. See §5 for recommendation.

**The wave shipping pattern is healthy** (3 waves in 11 hours, code review on each, jest suites green). The wave OPERATING pattern is broken: 60+ hours of zero new listener firings in production despite three waves shipped.

---

## Section 3: Dark / orphan listeners

### P0 - The load-loop bug (5 dark listeners simultaneously)

**Symptom:**
- Standalone `node -e "require('./src/services/listeners/registry').loadListeners()"`: loads all 7 listeners, returns array of length 7.
- PM2 ecodia-api production process logs: `loaded smoke`, `loaded ccSessionsFailure`, `skipped dbBridge.js — missing required fields`, then NOTHING. No `loaded emailArrival`, no `loaded factorySessionComplete`, no `loaded forkComplete`, no `loaded invoicePaymentState`, no `loaded statusBoardDrift`.
- No `listener subsystem: registered N listeners` line on any boot since `2026-04-28T01:30:33Z`.
- No `listener subsystem: started with N listeners` line on any boot since `2026-04-27T23:52:12Z`.
- No `listener subsystem: failed to start` line either.
- `ecodia-api-err.log`: zero listener-related errors.

**Implication:** The for-loop in `loadListeners()` either throws silently after the dbBridge skip (on `require(emailArrival.js)` or later), OR the outer try/catch in `startListenerSubsystem` is swallowing an exception that the err-log isn't capturing, OR `startListenerSubsystem` is never being awaited at boot. The `node -e` test rules out a pure module-load throw - that test successfully requires emailArrival, factorySessionComplete, etc. So the failure is context-dependent (module cache state, async timing, or process-boundary).

**Effect:** Wave B AND Wave C are entirely dark in production. Wave A is half-dark (factorySessionComplete missing). Three waves of "shipped" listener work are functionally absent.

### Listeners present in registry, never fired in production - secondary effects

- **emailArrival** is doubly-dark: (1) load-loop bug, (2) `email_events` table has 0 historical rows. Even if the listener loaded, the producer-feed (Gmail-poll → email_events writer) is not wired. See coverage-gap C-2 below.
- **invoicePaymentState** is doubly-dark: (1) load-loop bug, (2) `staged_transactions_7d=0` - bank imports have been dormant for 7+ days; `invoice_payment_matches_total=0`.
- **statusBoardDrift** has a special structural issue: even when load-loop is fixed, its 30-minute timer is started by `index.js`'s `for...startListenerSubsystem` loop, which never completes in production. So the drift-detector half of the listener is structurally dependent on the load-loop fix.

### Orphan listeners (firing but no downstream)

None observed. Every loaded listener (smoke noop excepted) wakes the OS via `/api/os-session/message` and the OS treats those wakes as actionable. No listener fires-and-disappears.

---

## Section 4: Coverage gaps - producer surfaces without listeners

Tables that have an active producer feed AND lack a listener (sorted by historical write-volume - the largest gaps first):

| Producer surface | Total historical rows | 7d activity | Why it matters | Listener candidate |
|---|---:|---:|---|---|
| **vercel_deployments** | 178 | 0 (recent) | Production deploy failures go undetected unless the every-2h cron catches them. SLO-relevant. | `vercelDeployFailureListener` |
| crm_activity_log | 10 | 0 | Email/call/note signals not wired into status_board updates | `crmActivityListener` |
| pipeline_events | 2 | 0 | Pipeline stage transitions silent (no auto-status_board update) | `pipelineEventListener` |
| invoices | 1 | n/a | New-invoice creation, mark-paid, void/cancelled transitions all silent | `invoiceLifecycleListener` |
| application_event (Phase C) | n/a | n/a | Phase-C applied-pattern tag protocol - silent-majority drift detection | `patternSilentMajorityListener` |
| outcome_event (migration 069) | n/a | n/a | NEW table, no consumer | `outcomeClassificationListener` |
| episode_resurface_event (migration 072) | n/a | n/a | NEW table, no consumer | `episodeResurfaceListener` |
| macro_perf_event / primitive_perf_event | n/a | n/a | Macro replay perf telemetry - drift signal source | `macroPerfRegressionListener` |
| os_session ingress (Tate-typed) | n/a | n/a | Could detect urgency keywords ("asap", "now", "broken") and flag SMS-rate-limit override | `osSessionIngressUrgencyListener` |

Producer-feed gaps (tables that DON'T exist - listener would require wiring the writer too):
- Stripe webhook events (no `stripe_webhook_events` table - both ends missing)
- GitHub PR / CI webhooks (no producer feed)
- Bitbucket PR webhooks (no producer feed)
- SMS inbound (currently routes through a different path that doesn't write a row)

---

## Section 5: Chosen next listener

**The brief asks: "Pick ONE next listener to ship."** The honest first-priority answer is the load-loop fix, not a new listener. After that fix lands and the existing 5 dark listeners light up, the highest-leverage NEW listener is:

### `vercelDeployFailureListener`

- **Trigger event:** `db:event` for `vercel_deployments` INSERT or UPDATE.
- **Relevance filter:** `state IN ('ERROR', 'CANCELED')` AND `target = 'production'`.
- **Producer-feed:** `public.vercel_deployments` (already populated - 178 historical rows). Producer is the existing Vercel webhook + every-2h sync cron. Live ingestion path - no producer wiring needed.
- **Trigger migration needed:** YES - migration `068_vercel_deployments_listener_trigger.sql` adding `trg_vercel_deployments_state_notify` on INSERT and UPDATE, plus extending `eos_listener_notify_compact()` with the vercel_deployments column whitelist (id, project_id, state, target, git_branch, git_commit_sha, error_message, created_at).
- **Downstream actions:**
  1. Insert/upsert a status_board P1 row: `entity_type='infrastructure'`, `name='Vercel deploy failed: <project_name> <git_branch>'`, `next_action='Check error_message and roll back or fix'`, `next_action_by='ecodiaos'`, `priority=1` (production) or `priority=3` (preview/dev).
  2. SMS Tate via `mcp__sms__send_sms` IF target='production' AND state='ERROR'. Use the rate-limit + dedupe rules in `~/ecodiaos/patterns/sms-tate-segment-economics.md` (one segment, no greeting, format `Vercel prod fail: {project} {branch} - {error_message_truncated_120}`).
  3. Wake OS session via `/api/os-session/message` for triage.
- **Replaces:** the `vercel-deploy-monitor` every-2h cron. Eliminates 12 cron fires/day in favour of seconds-latency event-driven response. Cron decommission criterion: 7 days of clean listener firings without missed deploys.
- **Why this is the largest greenfield gap:** vercel_deployments has by far the highest write-volume of any unwatched producer surface (178 rows). Production deploy failures are SLO-relevant (client sites going down). The cron is currently the only safety net and runs at 2-hour granularity.
- **Why NOT crm_activity_log / pipeline_events / outcome_event:** all three are too low-volume (10, 2, n/a rows) to justify a listener as the highest-leverage next step. They become candidates after the volume-rich producer surfaces are covered.

**Brief for the next-dispatch fork (after the load-loop fix lands):**

> Build vercelDeployFailureListener (Wave D). Files: `src/services/listeners/vercelDeployFailureListener.js` matching the existing listener shape; `src/db/migrations/068_vercel_deployments_listener_trigger.sql` adding the trigger and extending the eos_listener_notify_compact() column whitelist for vercel_deployments (id, project_id, state, target, git_branch, git_commit_sha, error_message, created_at); jest tests in `tests/listeners/vercelDeployFailure.test.js`. Wake the OS via HTTP POST only - never import the session service. Decommission the vercel-deploy-monitor cron after 7 days of clean firings (do NOT decommission in this PR - separate follow-up). Apply migration 068 in the PR's pre-merge script. Reference the `eos_listener_notify_compact()` per-table column-whitelist pattern from migration 066 for the function-extension SQL. Status discipline: PR remains DRAFT until a real Vercel ERROR row is observed firing the listener and waking the OS in production logs.

---

## Section 6: Prioritised P1/P2/P3 to-do list

### P0 - immediate (ecodia-os internal infrastructure)

- **P0.1 Diagnose and fix the listener load-loop bug.** Production loads 2/7. This is the dominant blocker - fixes Wave B + Wave C and unlocks Wave D. Investigation steps: (a) add `console.log` (NOT logger) bracketing each iteration of the `loadListeners()` for-loop to bypass any winston async-buffer drop; (b) check whether `startListenerSubsystem` is actually awaited at boot in `src/index.js` or wherever it's called; (c) ensure the outer try/catch in `index.js` logs at error level not warn; (d) try replacing `fs.readdirSync` with an explicit allow-list array to rule out a directory-iteration corner case; (e) check Node version + postgres driver version match between standalone `node -e` and the PM2 process. Estimated cost: 1 fork, 30-90 minutes.

### P1 - after P0 lands

- **P1.1 Add boot-time assertion in index.js: throw if loaded listener count != expected count.** Make load-loop bugs visible at boot rather than 60h later. The expected count can come from a hard-coded list in registry.js or from `fs.readdirSync(__dirname).filter(...)` evaluated separately to the load step.
- **P1.2 Wire the email_events writer.** Without this, emailArrival is permanently dark even after P0. The producer-feed needs a Gmail-poll → email_events INSERT path (or a webhook subscription if Gmail Push is feasible). Owner: ecodiaos.
- **P1.3 vercelDeployFailureListener.** As scoped in §5. Largest greenfield gap.

### P2 - after P1.x

- **P2.1 invoiceLifecycleListener** - watch invoices INSERT/UPDATE for status transitions (paid, void, cancelled, sent). Pair with invoicePaymentState (which only watches the bank-import side). Producer-feed: `invoices` table.
- **P2.2 outcomeClassificationListener** - consume the `outcome_event` table (NEW from migration 069). Until a listener consumes this, the migration is decorative.
- **P2.3 episodeResurfaceListener** - consume `episode_resurface_event` (NEW from migration 072). Same problem as P2.2.
- **P2.4 patternSilentMajorityListener** - consume `application_event` rows where `tagged_silent=true` and roll up into `pattern_silent_majority` drift signals (per the Phase C tag-protocol doctrine). Producer-feed: `application_event`.

### P3 - lower priority / coverage-completion

- **P3.1 crmActivityListener** - low-volume producer (10 rows historical). Worth wiring once the high-volume gaps are closed because client interaction signals should auto-update status_board.
- **P3.2 pipelineEventListener** - 2 rows historical; pipeline stage transitions should auto-update status_board.
- **P3.3 macroPerfRegressionListener** - macro replay perf-degradation drift detection.
- **P3.4 osSessionIngressUrgencyListener** - flag urgency keywords in Tate-typed messages and override SMS rate-limits.

### Wave D operating discipline

- **Default `status='dark_until_observed_firing'` on every new listener PR.** A listener PR can ship to main, but the row in any tracking table (`listener_registry` if/when it exists, or in this audit's status_board language) starts in a dark state. Promotion to `live_observed` only after a real production firing is logged. This mirrors the macro-runbook `untested_spec` → `validated_v1` discipline (`~/ecodiaos/patterns/macros-must-be-validated-by-real-run-before-codification.md`) - applied to listeners.
- **Pre-merge smoke runner.** Each new listener PR must include a 5-layer smoke test (handler unit, relevanceFilter unit, end-to-end with mock pg_notify payload, end-to-end against live DB with a synthetic INSERT/UPDATE, end-to-end production with a real producer event observed). Wave C's PR #6 included the 5-layer pattern - keep it.
- **No more bulk waves until the load-loop is verified self-healing.** Three waves landed in 11 hours and 2/3 of the code is dark in production. Future waves are 1 listener per PR until the boot-assert (P1.1) is in place.

---

## Appendix A: probes and queries

**Listener load probe (standalone Node, run from `~/ecodiaos`):**
```
node -e "const r=require('./src/services/listeners/registry'); const l=r.loadListeners(); console.log('LOADED:', l.length, l.map(x=>x.name));"
```
Expected output: `LOADED: 7 [smoke, ccSessionsFailure, emailArrival, factorySessionComplete, forkComplete, invoicePaymentState, statusBoardDrift]`. Verified 2026-04-29 23:46 AEST.

**Production-process load count probe:**
```
grep "listener: loaded" /home/tate/.pm2/logs/ecodia-api-out.log | tail -20
```
Expected: 7 unique listener names per boot. Observed: 2 (`smoke` + `ccSessionsFailure`).

**Boot completion probe:**
```
grep "listener subsystem: registered\|listener subsystem: started" /home/tate/.pm2/logs/ecodia-api-out.log | tail -5
```
Expected: a `registered N listeners` and `started with N listeners` line on every boot. Observed: last appearance `2026-04-28T01:30:33Z`. 60+ hours of failed boots since.

**Producer trigger inventory:**
```sql
SELECT trigger_name, event_object_table, event_manipulation
FROM information_schema.triggers
WHERE trigger_schema='public' AND action_statement ILIKE '%listener%';
```

**Producer-feed activity probe:**
```sql
SELECT 'cc_sessions_7d' AS metric, COUNT(*) AS n FROM cc_sessions WHERE started_at > NOW() - INTERVAL '7 days'
UNION ALL SELECT 'os_forks_24h', COUNT(*) FROM os_forks WHERE started_at > NOW() - INTERVAL '24 hours'
UNION ALL SELECT 'staged_txn_7d', COUNT(*) FROM staged_transactions WHERE occurred_at > NOW() - INTERVAL '7 days'
UNION ALL SELECT 'email_events_total', COUNT(*) FROM email_events
UNION ALL SELECT 'vercel_deploys_7d', COUNT(*) FROM vercel_deployments WHERE created_at > NOW() - INTERVAL '7 days';
```

---

## Appendix B: cross-references

- Apr 28 audit Episode: "Listener audit + Wave A dispatch (fork_moi0lx9x_05c547, Apr 28 2026 13:00 AEST)"
- Apr 28 dark-listeners Episode: "Listener registry only loads 2 of 7 in production process - root cause UNRESOLVED 2026-04-28"
- Apr 28 Wave A post-mortem Episode: "Wave A deploy + pm2_restart cascade post-mortem 2026-04-28 14:18 AEST"
- Apr 28 Wave B/C Episode: "Wave B/C listener ship + pre-kill-commit doctrine + coexist lint dispatch (2026-04-28 14:30-15:00 AEST)"
- Apr 28 Wave C wiring Episode: "invoicePaymentState listener producer-feed wired (PR #6, fork_moj7v8mr)"
- Apr 28 invoice/payment listener Decision: "Status_board invoice/payment-state belongs to a listener, not human-toggled status text"
- Pattern: `~/ecodiaos/patterns/no-pm2-restart-of-ecodia-api-during-active-or-queued-factory-sessions.md`
- Pattern: `~/ecodiaos/patterns/macros-must-be-validated-by-real-run-before-codification.md` (the discipline this audit recommends mirroring for listeners)
- Pattern: `~/ecodiaos/patterns/context-surfacing-must-be-reliable-and-selective.md` (the 5-layer architecture that the listener layer should mirror)
- Pattern: `~/ecodiaos/patterns/piercing-uniquity-is-the-quality-bar-generic-ai-output-is-disqualifying.md` (why the chosen listener is named, scoped, and producer-feed-identified, not "build more listeners")

[APPLIED] ~/ecodiaos/CLAUDE.md self-evolution scope-discipline because target is ecodiaos-backend internal, no client codebases.
[APPLIED] ~/ecodiaos/patterns/context-surfacing-must-be-reliable-and-selective.md because the listener layer is the runtime equivalent of the doctrine-surfacing layer; the 5-layer architecture (file-per-thing, frontmatter triggers, grep-before-action, mechanical hook enforcement, semantic-search fallback) maps onto (listener-per-event, subscribesTo declaration, registry probe, boot-time assertion, production firing observation) and the audit calls out where the listener layer is missing the analogous boot-assert layer.
[APPLIED] ~/ecodiaos/patterns/piercing-uniquity-is-the-quality-bar-generic-ai-output-is-disqualifying.md because the chosen-next-listener is named (vercelDeployFailureListener), trigger-event-specific (state IN ('ERROR','CANCELED') AND target='production'), producer-feed-identified (vercel_deployments table, 178 historical rows, existing webhook+cron writer), downstream-action-named (status_board P1 + SMS Tate + OS wake), and replaces a specific cron (vercel-deploy-monitor every 2h with a 7-day clean-firing decommission criterion) - not "build more listeners".
[NOT-APPLIED] ~/ecodiaos/patterns/no-client-contact-without-tate-goahead.md because audit is internal infrastructure, no client contact.
[NOT-APPLIED] ~/ecodiaos/patterns/factory-approve-no-push-no-commit-sha.md because no Factory dispatch - audit only.

---

End of audit.
