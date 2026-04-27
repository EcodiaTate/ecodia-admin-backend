---
triggers: scheduler, schedulerPollerService, isTateActive, defer, deferred, cron-defer, cron-skip, cron-not-firing, scheduler-defer, scheduler-active-window, tate-active-gate, pre-gate, queue-vs-fire, idle-initialise, cron-initialisation
---

# Scheduler must not pre-gate on isTateActive - trust /api/os-session/message to queue or initialise

## The rule

The scheduler poller (`src/services/schedulerPollerService.js`) must NOT defer scheduled tasks based on a "Tate has talked recently" heuristic. That decision belongs at the message endpoint, not the scheduler.

The correct architecture:
- Scheduler fires every due task by POSTing to `/api/os-session/message` with `source: 'scheduler'`.
- `/api/os-session/message` with `priority: false` queues behind any in-flight turn AND initialises a new turn when idle.
- The single decision point is the message endpoint. The scheduler is fire-and-trust.

## Why

The pre-gate `if (await isTateActive()) defer 20m` was designed to avoid interrupting Tate. But `/api/os-session/message` already handles non-interruption correctly:
- Mid-turn message arrives -> `_sendQueue` chain queues it behind the active query.
- Idle session message arrives -> initialises a turn.

The pre-gate adds nothing except false-defers. "Tate active" measured by "last message <15min ago" is a stale signal - it conflates "Tate is currently typing" with "Tate touched the chat 14 minutes ago and is now AFK". The latter is exactly when scheduled work should fire and initialise the OS to handle the cron.

Symptom of the bug: scheduled review tasks fire, get deferred 20min, and the OS sits idle through the deferred window because nothing else woke it. By the time Tate notices, the task has been pushed forward 20 minutes for no real-world reason.

## Do

- POST every due task to `/api/os-session/message` with `source: 'scheduler'`.
- Trust the message endpoint to queue behind in-flight turns or initialise an idle session.
- Use the in-process `_isQueueBusy()` check at MOST as a "skip this poll cycle and retry next 30s" gate, not as a 20-minute defer.
- If the SDK is genuinely streaming RIGHT NOW (not "talked 14min ago"), short defer is acceptable - but minutes, not double-digit minutes.

## Do not

- Do not check `isTateActive()` as a precondition to firing a scheduled task. That signal is wrong for this purpose.
- Do not defer 20 minutes on any signal weaker than "the SDK literally cannot accept a new turn right now."
- Do not assume Tate's recent activity means the scheduler should stand down. The scheduler's whole point is to wake the OS at the right moment, including (especially) when Tate has gone idle.

## Verification

- A scheduled task should fire within 30-60s of its `next_run_at`.
- `last_deferred_at` should be NULL or rare (genuine streaming-in-progress collisions only).
- An idle OS session (no Tate input for >5min, no in-flight Factory) should receive scheduled task POSTs immediately and initialise.
- Querying `os_scheduled_tasks` after a quiet hour should show `last_run_at` close to scheduled times, not pushed forward by deferral.

## Origin

Apr 27 2026, 13:23-13:29 AEST. Scheduled review task `review-fork-send-message-factory-a3288300` fired at 13:23:54 AEST and got deferred 20 minutes to 13:43:54 because `isTateActive()` returned true (Tate had messaged at 13:13 and 13:19, both <15min before the scheduled fire). The Factory session being reviewed had completed at ~13:29. The OS sat idle from 13:21 to 13:29 (Tate's next message), and the cron that was supposed to initialise me did not fire because of the pre-gate.

Tate's directive (13:29 AEST): "you need to ACTUALLY be getting a message sent to you if you're inactive when a cron triggers.... at 1:23 you should've been checking on it, but instead since you werent working on anything, nothing happened, this needs to be conventionalised so that it doesntinterupt you during a turn, but does intiialise you if youre inactive yk?"

That's exactly what `/api/os-session/message` with `priority: false` does. The scheduler pre-gate breaks it. The fix is to remove the pre-gate and trust the queue.
