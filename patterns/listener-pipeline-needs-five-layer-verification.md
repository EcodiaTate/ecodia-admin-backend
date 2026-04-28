---
triggers: listener, listener-subsystem, dbBridge, pg_notify, pg_trigger, eos_listener_events, listener-not-firing, dark-listener, wired-but-dark, end-to-end-verification, producer-trigger-listener, subsystem-audit, emailArrival, forkComplete, statusBoardDrift, factorySessionComplete, invoicePaymentState, listener-shipping
---

# Listener pipelines need 5-layer end-to-end verification, not just any single layer

## The rule

A listener subsystem in EcodiaOS has FIVE distinct layers, each of which can fail or be missing independently. When shipping a new listener (or auditing an existing one), verify ALL FIVE empirically:

1. **Producer** — code that actually inserts rows / updates state in the watched table (e.g. gmail polling code → `INSERT INTO email_events`).
2. **Trigger** — `pg_trigger` row that fires `pg_notify('eos_listener_events', ...)` on the producer's write.
3. **Bridge** — `dbBridge.js` LISTEN connection routing pg_notify into wsManager broadcast (`db:event` channel).
4. **Listener** — the module in `src/services/listeners/` that exports `{name, subscribesTo, relevanceFilter, handle, ownsWriteSurface}` and is loaded by the registry.
5. **Side-effect** — the handler's actual output (kv_store key written, message_queue row enqueued, status_board updated, OS session woken via POST /api/os-session/message, SMS sent, file written, etc.).

Skipping any layer leaves the pipeline partially-wired or fully-dark. The most subtle failure is "wired but dark": layers 2-5 are all correct, but layer 1 (producer) doesn't exist OR doesn't write to the watched table.

## Why

Tonight (2026-04-28 22:55 AEST), `emailArrival` listener audit revealed:
- Layer 2 (trigger): `trg_email_events_insert_notify` exists in `pg_trigger` ✓
- Layer 3 (bridge): `dbBridge.js` is LISTENing on `eos_listener_events` ✓
- Layer 4 (listener): `emailArrival.js` loads cleanly, exports valid shape, registry registered it ✓
- Layer 5 (side-effect): handler is wired to POST `/api/os-session/message` with the wake-message ✓
- **Layer 1 (producer): ZERO rows in `email_events` ever.** No code in the codebase writes to that table. The existing email-triage cron polls Gmail API directly and bypasses the table entirely.

So the listener has been technically "shipped" since 2026-04-28 04:46 AEST, but has fired exactly 0 times because nothing produces the events it watches for. That's 18+ hours of dark time hidden under "wired correctly." A single-layer audit (e.g. "is the listener loaded? yes. ✓ ship it.") would never catch this.

## Do

When shipping a new listener:

1. **Producer first.** Identify or write the code path that produces rows in the watched table. If no producer exists, decide BEFORE shipping whether you'll add one or accept the listener will be dark. Don't ship a dark listener and call it done.
2. **Trigger second.** Confirm via `SELECT * FROM pg_trigger WHERE tgname LIKE '<expected_name>'`. Migration file existing on disk is not enough — the migration must actually be applied. Check `_migrations` table for the filename.
3. **Bridge third.** Confirm `dbBridge` is in the loaded-listener list at startup (or that `listener subsystem: started with N listeners + db bridge` shows up in startup logs).
4. **Listener fourth.** Confirm registry loaded it: `node -e "const r=require('./src/services/listeners/registry'); r.loadListeners().forEach(l=>console.log(l.name))"` — your listener should appear in the output. Also confirm the running api process loaded it (check side-effect artefacts, NOT log files — see `verify-empirically-not-by-log-tail.md`).
5. **Side-effect fifth.** Trigger a synthetic event (insert a test row matching the trigger condition) and verify the handler ran (kv_store key updated, message_queue row appeared, OS session received the wake message). Clean up the synthetic data.

When auditing an existing listener:

1. Query the watched table for recent activity. If empty over the expected timeframe, the producer is likely missing or broken — go check layer 1 first.
2. Check the listener's expected side-effect artefact for recent timestamps. If absent, walk back through layers 2-4.
3. If you only check "is the file there + does it export correctly" you have NOT audited the listener. That's a 1-layer check.

## Do NOT

- Ship a listener and only verify it loads. Loading is necessary but not sufficient.
- Treat a green migration file as proof the trigger is live. Migrations can fail silently mid-run, or be on disk but unapplied.
- Use `pm2 logs --lines N` as listener-firing evidence. Log capture can break silently. Use empirical artefacts (DB rows, kv_store keys, message_queue entries) — see `verify-empirically-not-by-log-tail.md`.
- Conclude "listener didn't fire" means "listener didn't load." It often means "producer doesn't exist OR no events came in to fire on."

## Protocol when authoring a new listener

```
[ ] LAYER 1 PRODUCER:
    file: ___________________
    operation: INSERT INTO ___ / UPDATE ___ ON ___
    triggered by: ___ (HTTP request? cron? webhook? backfill?)
    if no producer exists: STOP. Add producer in same PR or defer the listener.

[ ] LAYER 2 TRIGGER:
    migration file: ___________________
    pg_trigger name: ___________________
    table: ___________________
    fires on: INSERT / UPDATE / DELETE / WHEN clause: ___
    confirmed in pg_trigger: YES / NO

[ ] LAYER 3 BRIDGE:
    dbBridge running: YES / NO
    LISTEN channel: eos_listener_events (default)

[ ] LAYER 4 LISTENER:
    file: src/services/listeners/___________________
    exports: name + subscribesTo + relevanceFilter + handle + ownsWriteSurface
    relevanceFilter conditions: ___
    handler does: ___

[ ] LAYER 5 SIDE-EFFECT:
    expected artefact: kv_store key '___' OR message_queue source='___' OR status_board insert OR ...
    smoke test: insert synthetic row matching trigger → expected artefact appears within N seconds → cleanup synthetic
```

If any row is incomplete, the listener is not ready to ship.

## Origin

Apr 28 2026 22:55 AEST. Listener audit during Tate's "fully utilise listeners" directive. emailArrival found dark — layers 2-5 correct, layer 1 absent. Decision 3611 followed: dispatch fork_moin0lrp to wire the producer (gmail polling → email_events insert) so the listener becomes load-bearing. The audit also surfaced that other 4 listeners (forkComplete, statusBoardDrift, invoicePaymentState, factorySessionComplete) had producers in place AND fired today, validating the 5-layer model in the negative direction (when all 5 layers are present, the listener works).

## Cross-references

- Pattern: `verify-empirically-not-by-log-tail.md` (use empirical artefact checks, not log tails, for layer-5 evidence).
- Pattern: `pre-stage-fork-briefs-before-session-killing-ops.md` (when shipping a listener that requires PM2 restart, sequence the restart safely).
- Doctrine: `~/ecodiaos/CLAUDE.md` "scheduler" + "listener subsystem" sections.
- Files: `src/services/listeners/registry.js`, `src/services/listeners/index.js`, `src/services/listeners/dbBridge.js`.
- Migration template: `src/db/migrations/063_listener_triggers.sql` (the canonical reference for trigger shape).
