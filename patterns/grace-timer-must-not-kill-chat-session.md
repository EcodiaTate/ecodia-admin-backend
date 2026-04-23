triggers: grace-timer, process-exit, pm2-respawn, abort-grace, empty_sdk_stream, inactivity_timeout, turn-pin, restart-loop, chat-kill, SDK_ABORT_GRACE_EXIT_ENABLED, scheduleAbortGraceTimer

# Grace-timer process.exit MUST be opt-in, not default

The 30s abort-grace backstop that calls `process.exit(1)` when an SDK abort does not propagate within 30s MUST be disabled by default. It may only be enabled behind an explicit env flag (`SDK_ABORT_GRACE_EXIT_ENABLED=true`) after abort-propagation has been independently proven to work on empty-stream and inactivity-timeout codepaths. Otherwise it converts every recoverable turn failure into a Tate-chat-session-killing PM2 restart.

## Why

The backstop is intended for the rare case where a native syscall (libc DNS, fs lock, native stream) ignores AbortController and genuinely wedges the process. But SDK empty-stream events and inactivity-timeouts are NOT wedges - they are recoverable turn failures where:
- The turn's retry logic nulls ccSessionId and retries
- If retries also return empty, it returns `{ code: 1, text: Error }` cleanly
- `_recordTurnOutcome(false, ...)` fires
- The process is perfectly healthy; only the turn failed

BUT if `_abortActiveQuery` was called along the way (which inactivity_timeout at line 1364 and tool_watchdog at 1335 both do), the grace timer was armed. 30s later, if the SDK's internal await didn't cleanly settle in that window, `process.exit(1)` fired, PM2 restarted the process, and Tate's live chat session died mid-response.

Observed frequency: every 3-14 minutes on a bad afternoon. `os_incidents` showed the signature: `inactivity_timeout after 2 retries` → `turn_failure` → PM2 restart of `ecodia-api`. Tate's explicit Prio 1 on 2026-04-23: "you keep timing out over and over and over".

## Do

- Keep grace-timer behind `SDK_ABORT_GRACE_EXIT_ENABLED` env flag. Default FALSE.
- Log-only mode: `logger.warn('SDK_ABORT_GRACE_EXPIRED — exit suppressed')`, clear `_abortInProgress`, continue.
- Before ever turning the flag to true, reproduce a genuine wedge (a syscall that ignores AbortController) in a test environment, prove the abort does not propagate, AND confirm the process is not serving any live chat.
- On any inactivity_timeout / empty_sdk_stream / turn_watchdog event, the turn-level recovery (retry with fresh session_id, context_reset breadcrumb, auto-wake) MUST be the primary path. Process recycle is a nuclear last resort, not a default.
- Run PM2 with restart counter visible - if `ecodia-api restarts` climbs by >2 per hour, assume the grace timer or another exit path has re-armed itself. Investigate immediately.

## Do NOT

- Re-enable `SDK_ABORT_GRACE_EXIT_ENABLED=true` globally. If a specific tool class truly wedges, add a targeted fix, not a blanket process kill.
- Trust a grace timer to "only fire on real hangs". Empty-stream and inactivity-timeout trigger abort on healthy turns; the grace timer cannot distinguish these from real wedges.
- Ship a backstop behaviour that can kill live user chat without a test proving the failure mode it targets is real in production.
- Mistake "frequent process recycles" for "the SDK is doing its job". If PM2 is restarting `ecodia-api` every few minutes, user sessions are dying and they notice.

## Verification after any change to _scheduleAbortGraceTimer

1. `grep -n "process.exit" src/services/osSessionService.js` - count exits, check each is gated.
2. Deploy, watch `pm2 jlist` for 30 minutes. Restart count MUST be stable.
3. Trigger a synthetic inactivity_timeout (e.g. send message during a known slow tool call). Confirm: turn fails, process stays alive, next turn works.
4. Only then consider changing the default.

## Origin

2026-04-23. `_scheduleAbortGraceTimer` (added via commit 4750bbc, pattern doc `sdk-abortcontroller-cancellation.md`) armed the 30s grace timer on every abort reason except the three explicit exemptions. In practice, `inactivity_timeout after 2 retries` and `empty_sdk_stream` were firing repeatedly against a healthy process - the SDK abort was not propagating in 30s because the underlying CLI subprocess had already exited cleanly and there was nothing to abort. The grace timer then killed the node process, PM2 respawned it, Tate's chat restarted, context was lost. Every 3-14 minutes. Tate said Prio 1: "No distractions.... fix this". Hotfix commit `902b797` gated `process.exit(1)` behind `SDK_ABORT_GRACE_EXIT_ENABLED=true` (default false). Restart loop stopped immediately. Root cause (why abort does not propagate on empty-stream) remains open but the damage is contained.
