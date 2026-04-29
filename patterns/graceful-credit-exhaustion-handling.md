---
triggers: credit-exhausted, credit-exhaustion, rate-limit, rate_limit, quota-exhausted, quota_exhausted, autoswitch, account-autoswitch, fork-error, session-limit, resume-fork, resumable-fork, out-of-extra-usage, resets-utc, claude-code-error, claude-max-quota, dispatch-flood, fork-credit-flood
priority: high
canonical: true
---

# Credit-exhaustion is a recoverable state, not a fork failure - detect, mark resumable, schedule auto-resume, and back off the dispatch rate

## Rule

When a fork's spawn returns an `abort_reason` matching `out of extra usage`, `rate.limit`, `quota.exhausted`, or any equivalent vendor-quota signal, classify it as a `credit_exhaustion` failure class - distinct from a real fork failure. The fork's brief is intact, the work was scoped correctly, the only thing that broke is the underlying account credit window. The doctrine here is that this state is recoverable and must be handled gracefully:

1. **Detect** the credit-exhaustion abort_reason class (separate from logic errors / tool failures / brief mismatches).
2. **Mark the fork resumable** in `os_forks` with the original brief snapshot and the parsed reset timestamp.
3. **Schedule auto-resume** as a one-shot delayed task, gated on the parsed reset window plus a small jitter.
4. **Back off the dispatch rate** when N consecutive forks hit credit_exhaustion within X minutes - pause spawn_fork or autoswitch the account before the conductor floods the next account.
5. **Emit telemetry** to the Phase B dispatch_event surface so the architecture can track frequency and tune the back-off thresholds.
6. **Surface visibly** - status_board P2 row "N forks pending credit-reset resume - fires at HH:MM AEST" auto-archives once the resumes complete.

The handling gap is not "the fork errored" - it is "the fork errored, the brief was lost, no resume context exists, no telemetry was emitted, and the conductor kept dispatching into the same dead account."

## Why it matters

Without graceful handling, credit exhaustion looks identical to a real failure - 5 forks errored, no in-flight artefacts, no resume hint, no Neo4j Episode of what each got partway through. The conductor wastes the dispatch envelope (5 forks worth of token budget burnt to no progress), the original work is forgotten unless it is re-derived from the brief, and the autoswitch (if it works) only saves the NEXT wave - the original 5 are still gone.

The recovery cost is cheap when the doctrine is in place (re-spawn with `RESUME of fork_X` preamble + the original brief). The cost when there is no doctrine is the entire dispatch wave evaporating into telemetry that says "errored" with no actionable signal.

## Detection rules

A fork is in `credit_exhaustion` state if its abort_reason matches any of:

- `Claude Code returned an error result: You're out of extra usage`
- `resets HH:MM (UTC)` substring (any case, any leading prefix)
- `rate.limit` token in the error body
- `quota.exhausted` token
- HTTP 429 with `x-ratelimit-reset` header on the SDK transport layer
- `credit balance is too low` or equivalent billing-tier signal

When matched, the dispatch_event row gets `failure_class='credit_exhaustion'` (NOT `failure_class='fork_error'`). The downstream review pipeline must treat these two classes differently - credit_exhaustion is not a learning input, it is an account-state signal.

## Recovery flow

1. Parse the reset timestamp from the abort_reason. Format observed: `resets 8:10am (UTC)` -> normalise to UTC HH:MM, store as `next_run_at` on the resume schedule. Convert to AEST for any text emitted to Tate.
2. Snapshot the original brief into `os_forks.resumable_brief` (or equivalent column - if the column does not exist yet, the implementation tracker carries the schema add).
3. Set `os_forks.resumable=true` and `os_forks.credit_reset_at=<UTC timestamp>`.
4. Schedule a delayed task: `schedule_delayed name="resume-fork-<original_id>" run_at="<reset+5min>" prompt="RESUME of <original_id>: verify the work is not already in another fork or in main, then re-spawn with the original brief snapshot. Apply verify-before-redo discipline."`
5. The resume prompt MUST include verify-before-redo - the original brief may have partially completed via autoswitch or main, and re-running blind would duplicate side effects.
6. On successful resume, the original os_forks row gets `resume_fork_id=<new_id>` and `resumed_at` populated. The status_board row archives.

## Anti-flood rules

- If 3+ consecutive `spawn_fork` calls return `credit_exhaustion` within 5 minutes, the conductor MUST pause its spawn loop until either (a) the reset window passes, or (b) the autoswitch shifts to a healthy account.
- Account-state signal goes into kv_store `forks.account_health.<account>` with the reset timestamp. The conductor reads this BEFORE spawn_fork, not after.
- Autoswitch is the autonomous remedy when one account is dry but another is healthy. The conductor doctrine: trust autoswitch for the NEXT wave, but mark the failed wave for explicit auto-resume.
- A single credit_exhaustion is not a flood - 1 fork erroring on the last credit before reset is normal. The threshold is N consecutive (3+).

## Telemetry hooks

A `credit_exhaustion_event` row goes into the Phase B `dispatch_event` table whenever the detection fires. Required columns:

- `fork_id` - the original fork that hit the wall
- `account` - which Claude Max account was exhausted (tate@ vs code@)
- `reset_at_utc` - parsed from abort_reason
- `consecutive_count` - how many in this wave
- `autoswitch_kicked_in` - bool, did the next dispatch land on the other account
- `resumed_at_utc` - populated when the resume schedule fires
- `resume_outcome` - `success` / `noop_already_done` / `failed`

The `/api/telemetry/decision-quality` panel adds a `credit_exhaustion_panel` showing wave frequency, account-balance trend, and resume success rate. Patterns whose `consecutive_count` regularly exceeds 3 trigger a status_board P3 drift signal: `credit-exhaustion-frequent-extra-usage-needed`.

## Status_board surface

When a credit_exhaustion wave hits:

```sql
INSERT INTO status_board (entity_type, name, status, next_action, next_action_by, next_action_due, priority, context)
VALUES ('infrastructure',
        'N forks pending credit-reset resume',
        'credit_exhaustion_wave',
        'Auto-resume fires at HH:MM AEST when reset window passes - verify-before-redo applied',
        'ecodiaos',
        '<reset+5min>',
        2,
        'Forks: <list of fork IDs> | Account: <tate@ or code@> | Autoswitch: <yes/no>');
```

The row auto-archives when the last resume in the wave reports back. Tate sees one P2 row, not 5 mysterious errors.

## Do

- Match abort_reason against the detection patterns BEFORE writing the fork outcome - the classification is upstream of the failure log.
- Parse the reset timestamp deterministically and store as UTC. Convert to AEST only when emitting to Tate.
- Always include verify-before-redo in the resume prompt. The autoswitched fork may have already shipped the work.
- Emit the `credit_exhaustion_event` even if only one fork is affected - the per-event row drives the consecutive-count back-off.
- Update kv_store `forks.account_health` so the conductor's spawn-time read sees the dead account before re-dispatching into it.

## Do not

- Do not classify credit_exhaustion as `failure_class='fork_error'`. That pollutes the learning corpus with non-signal.
- Do not re-spawn the same brief inside the same dispatch wave when credit is exhausted. Schedule the resume; do not retry inline.
- Do not assume autoswitch will save the original 5 forks. It only routes the NEXT wave - the originals need explicit resume.
- Do not log the full abort_reason text to Tate without translating reset_at to AEST. UTC alone is alien (per the temporal-output rule in CLAUDE.md).
- Do not silently lose the original brief. If `os_forks.resumable_brief` cannot be populated for any reason, fall back to writing the brief into kv_store `forks.resume.<fork_id>.brief` so the resume prompt can rehydrate it.

## Cross-references

- `~/ecodiaos/patterns/no-symbolic-logging-act-or-schedule.md` - logging "credit exhausted, will resume" without a scheduled resume task is symbolic. The schedule IS the log.
- `~/ecodiaos/patterns/decision-quality-self-optimization-architecture.md` - credit_exhaustion_event is a Phase B dispatch_event extension. The architecture's drift-signal layer consumes the consecutive-count metric.
- `~/ecodiaos/patterns/scheduled-redispatch-verify-not-shipped.md` - verify-before-redo on resume. The work may have completed via autoswitch or main while the original was credit-blocked.
- `~/ecodiaos/patterns/recurring-drift-extends-existing-enforcement-layer.md` - if credit_exhaustion becomes a recurring drift mode (3+ waves per fortnight), extend the existing dispatch_event hook rather than building a parallel monitor.
- `~/ecodiaos/patterns/check-pre-kill-commits-before-redispatch.md` - same family of doctrine: never re-dispatch without checking what already shipped.
- `~/ecodiaos/patterns/factory-quality-gate-over-cron-mandate.md` - credit-exhaustion is one signal that the dispatch rate may be miscalibrated. Anti-flood thresholds tune the dispatch envelope.

## Origin

29 Apr 2026, 17:00-17:19 AEST. Conductor dispatched 5 forks in an 11-minute window:

| Fork ID | Time | Brief |
|---|---|---|
| mojpge0a | 16:59 AEST | macros recon |
| mojpo6w5 | ~17:05 | Phase A |
| mojpoybs | ~17:07 | Phase G |
| mojpqzkd | ~17:09 | Phase C |
| mojpue4x | 17:10 | Phase E |

All 5 returned `Claude Code returned an error result: You're out of extra usage  resets 8:10am (UTC)` (= 18:10 AEST). The autoswitch between tate@ecodia.au and code@ecodia.au accounts handled the NEXT dispatch wave correctly, but the original 5 errored hard with:

- No in-flight telemetry on what each fork got partway through
- No resume hint or `resumable=true` flag in os_forks
- No status_board row signalling the wave
- No Neo4j Episode capturing the wave shape
- No automatic re-spawn after the reset window

5 resume forks were dispatched manually at 17:24-17:26 AEST after the conductor noticed the wave shape. Tate's directive at 17:19 AEST (verbatim):

> "Yeah we hit the session limit on one of the accounts but i think autoswitch worked perfectly so should be fine to resume them, need to handle that more gracefully next time."

The "more gracefully next time" is this doctrine. The 5-fork wave is the originating event. The doctrine ships in this fork; the mechanical implementation (detection in spawn_fork's downstream, schema add for `os_forks.resumable_brief` / `resumable` / `credit_reset_at`, the dispatch_event extension, the anti-flood spawn-time check, the auto-resume scheduler hook) is logged as a status_board P2 implementation tracker for a follow-up dispatch.

This file IS the codification - per the codify-at-moment-stated rule in `~/CLAUDE.md`, the rule does not exist for future sessions until the file lands. The mechanical layer follows.
