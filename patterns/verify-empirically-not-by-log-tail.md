---
triggers: pm2-logs, log-tail, log-capture, listener-audit, listener-loaded, empirical-verification, infrastructure-state, infra-audit, listeners-not-firing, listener-not-loaded, log-stopped, stdout-capture, trust-data-not-logs, system-state, audit-running-process
---

# Verify infrastructure state empirically, not by log-tail

## The rule

When auditing whether an in-process subsystem (listener, scheduler, bridge, cron, listener-trigger) is functioning, **trust DB-side artefacts and side-effects over log lines**. PM2 log capture, console buffering, file rotation, and stream piping all break silently in ways that make a working subsystem LOOK broken. Empirical verification (kv_store keys it would have written, message_queue rows it would have enqueued, DB rows that prove its trigger fired, SYSTEM messages it would have emitted into the OS conversation, prod-state probes via the actual API) cannot be wrong - the subsystem either left a footprint or it didn't.

## Why

Tonight (2026-04-28 22:30-22:55 AEST), pm2 stdout capture for ecodia-api silently froze at 12:30:14.843 UTC. The api process kept running normally for the next 25+ minutes, handling many requests, BUT no further log lines made it into `~/.pm2/logs/ecodia-api-out.log`. A naive read of "only 2 listener: loaded lines visible at startup" led me to conclude the 5 Wave B/C listeners hadn't loaded. Empirical verification proved the opposite:
- forkComplete listener: 2 hits in `message_queue` with `source LIKE 'fork:%'` from today.
- statusBoardDrift listener: kv_store key `ceo.status_board_drift_alerts` last updated 14:21 UTC.
- invoicePaymentState listener: kv_store key updated 14:35 UTC.
- factorySessionComplete: presumed working (no Factory CLI activity today to trigger it).
- Plus: I had been receiving "Source: forkComplete listener (sourceEventId=...)" SYSTEM messages on every turn since the supposed silence began - the listener was clearly firing.

Re-running `registry.loadListeners()` in a fresh node REPL also confirmed all 7 listener modules export valid shapes - but this is just the loader's potential, not the running process's actual state. The empirical artefacts are the actual state.

## Do

1. Identify what the subsystem WRITES (kv_store keys, DB rows, message_queue entries, files, headers, SMS sends, status_board rows).
2. Query the writes directly. If recent timestamps exist for the expected workload, the subsystem is alive.
3. Use the side-effect chain to back-derive working state:
   - "Did fork_X complete?" -> `os_forks.status='done'` and the fork_report SYSTEM message I received.
   - "Did the listener fire?" -> the side-effect kv_store / message_queue row exists.
   - "Did the trigger fire?" -> a row appeared in the watched table with the expected timestamp.
4. For listeners specifically: verify three layers
   - The trigger exists in `pg_trigger` (not just declared in a migration file).
   - The migration is in `_migrations` table (or trigger live anyway via out-of-band apply).
   - The producer for the watched table is wired (a listener with no producer is "dark" and must be flagged separately).

## Do NOT

- Pull `~/.pm2/logs/*.log` and conclude state from line counts. Log files are evidence of WRITES, not evidence of EXECUTION.
- Trust `pm2 logs --lines N --nostream` for completeness. The output is windowed and may miss multi-day-old startup lines OR stop short due to capture breakage.
- Assume listener-loaded log lines are reliable. The registry's `logger.info()` after a successful require can fail silently if logger transport is broken without raising errors.
- Re-run `registry.loadListeners()` and conclude the running process loaded the same listeners - the running process loaded what it loaded at its boot time, with the modules then on disk and the logger then working. Snapshots of "right now in a fresh REPL" only verify the LOADER's potential.
- Treat "listener didn't fire" as proof of "listener didn't load". Listeners can be loaded but dark (trigger source unproduced).

## Protocol when auditing a listener subsystem

1. Run `registry.loadListeners()` in fresh node to confirm modules ARE loadable. Captures: are file shapes valid?
2. Query `pg_trigger` directly for the listener-related triggers. Captures: are DB-side triggers in place?
3. Query the WATCHED tables for recent row activity (last 24h). Captures: does the trigger source see traffic?
4. Query each listener's expected SIDE-EFFECT artefact (kv_store key, message_queue rows, status_board updates, etc.) for recent timestamps. Captures: did the listener actually run?
5. For any listener with no recent side-effect artefact AND no recent trigger source activity: classify as DARK and flag to status_board.
6. For any listener with side-effect artefacts: classify as ACTIVE regardless of what the log file says.
7. PM2 log silence is its own diagnostic issue - record as separate status_board row, do not let it confound the listener audit.

## Origin

2026-04-28 22:30-22:55 AEST. Tate asked: "Did the listeners from earlier today actually get implemented, and explain if/how they're working." Initial check via `pm2 logs ecodia-api --lines 200 --nostream` showed only `smoke` and `ccSessionsFailure` loaded after the 12:30:14 restart, with the file ending at line 1524 (the `dbBridge skipped` warning). Misleading conclusion: "only 2 of 7 listeners loaded." Reality: pm2 stdout capture had silently stopped writing 25 minutes earlier; all 7 listeners ARE loaded and 4 of 5 testable ones HAD fired today (only emailArrival is dark, separately because no producer writes to email_events). Wasted ~5 minutes chasing the wrong fault before pivoting to empirical artefact checks. Lesson codified to prevent the loop.

## Cross-references

- Pattern: `pre-stage-fork-briefs-before-session-killing-ops.md` (sibling pattern for handling restart-resilience).
- status_board row "PM2 stdout log capture stopped at 2026-04-28T12:30:14Z" (the diagnostic gap to fix separately).
- status_board row "emailArrival listener is dark - trigger wired, table never populated" (the only genuinely-dark listener found).
