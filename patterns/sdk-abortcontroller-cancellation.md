triggers: sdk-abort, AbortController, sdk-cancellation, query.close, sdk-tool-timeout, undici-fetch, mcp-transport, per-tool-watchdog, turn-watchdog, inactivity-timeout, osSessionService, active-query, sdk-process-exit, pm2-respawn-sdk

# SDK cancellation must use AbortController, not q.close()

Every `query()` call against `@anthropic-ai/claude-agent-sdk` MUST be created with a turn-scoped `AbortController`. Cancellation MUST flow via `controller.abort(reason)`. `q.close()` is for stream teardown only and does NOT propagate cancellation into in-flight built-in tools (WebFetch/undici fetch), MCP stdio transports, or Bash subprocesses. Pair every watchdog abort with a 30s grace timer that escalates to `process.exit(1)` so PM2 respawns the process if a tool is truly wedged at the syscall level.

## Why

The SDK's `query()` object exposes `close()`, which is documented as stream teardown. It does not propagate an abort signal into running tool executors. When a per-tool watchdog (60s), inactivity timeout (90s), or global turn watchdog (8/15min) fires and calls `q.close()`, the tool (e.g. a WebFetch blocked on a DNS lookup, or an MCP stdio transport waiting for a dead process) keeps running. The for-await loop stays pinned. The next turn queues behind it forever. PM2 never sees an exit because the process is technically alive.

`AbortController` passes a real cancellation signal into the SDK Options (`options.abortController`), which the SDK distributes to its tool runners and undici fetch calls. This is the correct cancellation path.

The 30s grace timer is the last resort for truly wedged native syscalls (libc DNS, fs lock, native stream) that don't respect the abort signal. After 30s, `process.exit(1)` lets PM2 bring the process back clean.

## Do

- Create `new AbortController()` at EVERY `query()` call site (in `_sendMessageImpl`). Store it as `activeAbort` alongside `activeQuery`. Keep them in lockstep - set together, cleared together.
- Pass `abortController: turnAbort` in the `options` object passed to `queryFn({ prompt, options })`.
- In `_abortActiveQuery(reason)`: call `ac.abort(reason)` FIRST, then `q.close()` as belt-and-braces.
- Schedule `_scheduleAbortGraceTimer(reason)` at the end of `_abortActiveQuery`.
- In `_scheduleAbortGraceTimer`: set `_abortInProgress = true`, schedule a 30s `setTimeout`. In the callback: if `_abortInProgress` is still true, call `process.exit(1)`. Use `.unref()` so the timer does not prevent clean process exit.
- Clear `_abortInProgress` and the grace timer on natural turn completion (both the success path and the catch path in `_sendMessageImpl`).
- Clear `activeAbort = null` anywhere `activeQuery = null` is set outside of `_abortActiveQuery` (mid-turn retry paths, stale-resume throw paths).

## Do NOT

- Rely on `q.close()` alone for cancellation - it is fire-and-forget and does NOT stop in-flight tools.
- Catch the AbortError and swallow it without logging the reason.
- Forget the grace timer - without it, a wedged native syscall can pin a process indefinitely despite a clean abort call.
- Schedule the grace timer for `new_turn_starting` or `priority_preempt` reasons - these abort one query only to immediately start the next, so `_abortInProgress` would fire incorrectly on the healthy new turn.
- Pass `priority: true` on `/api/os-session/message` to "preempt" - that is a separate queue-management concern, not a cancellation fix.
- Set `options.abortController` after calling `queryFn` - it must be set before the SDK receives options.

## SDK option name (verified)

The SDK option is `abortController?: AbortController` in `Options` type (sdk.d.ts line 891 in `@anthropic-ai/claude-agent-sdk@^0.2.92`). Not `signal`. Pass the full controller, not just the signal.

```js
// Correct
const turnAbort = new AbortController()
options.abortController = turnAbort
const q = queryFn({ prompt: finalPrompt, options })
activeQuery = q
activeAbort = turnAbort
```

## Grace timer exemptions

Only watchdog and manual abort reasons should arm the grace timer:
- Schedule: `tool_watchdog`, `inactivity_timeout`, `turn_watchdog`, `manual_restart`, `explicit_abort`, `handover_watchdog`, `handover_prep`
- Skip: `new_turn_starting`, `priority_preempt`, `compact_deprecated`

## Origin

Apr 23 2026. Per-tool watchdog (60s) and global turn watchdog (8/15min) both fired correctly during a WebFetch hang but the turn stayed pinned because `_abortActiveQuery` called `q.close()` without an AbortSignal. Tate experienced three turn-pin failures in one afternoon. Fix: wired `AbortController` end-to-end in `osSessionService.js` + added `_scheduleAbortGraceTimer` 30s process-recycle backstop. Unit tests added at `tests/sdkAbortController.test.js` (13 tests, all passing).
