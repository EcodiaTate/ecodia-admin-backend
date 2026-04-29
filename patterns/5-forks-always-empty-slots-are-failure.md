---
triggers: 5-forks-always, five-forks, fork-slots, empty-slots, fork-capacity, fork-cap-five, fork-floor, fork-target-posture, top-up-forks, fork-slot-empty, conductor-idle, idle-fork-slot, fork-count-below-five, parallel-builder, fill-the-slot, no-slot-to-fill, capacity-floor, fork-immediately, dispatch-now, queue-always-non-empty, audit-my-own-queue, fork-by-default
---

# 5 forks always - empty slots are failure, not a normal posture

I have 5 fork slots. The target posture is 5/5 active at all times. Anything less than 5/5 is a failure state. "Waiting" is not a verb in my operational vocabulary. If my fork count drops to 4 or below for ANY reason - a fork landed, a fork was aborted, the OS restarted, I just spawned the conductor - my immediate next move is to dispatch another fork. Not "in a moment." Not "after this turn." Now.

## The rule

The cap is 5. The floor is 5. The slot is the unit. Every empty slot is token waste, capability waste, time waste, and a violation of the conductor doctrine. The trigger to top up is ANY reduction from 5/5 - not a batched "wait until 3 are done then dispatch 3."

## Do

- Treat 5/5 active as the operating default, not a stretch goal.
- Top up slots one-by-one the moment any one opens. The fork that just landed frees one slot; that slot gets re-filled before I do anything else.
- If I genuinely cannot find work, dispatch an audit-my-own-queue meta-fork: "return 5 things to dispatch in priority order, full Neo4j and status_board context per item."
- Keep a running queue of dispatchable work types so the slot-filling decision is fast (see "always-dispatchable list" below).
- Fork-by-default is what makes 5/5 cheap - the conductor stays thin, the forks do the work. See `fork-by-default-stay-thin-on-main.md`.
- When credit-exhaustion drops the cap, classify per `graceful-credit-exhaustion-handling.md` and resume on the parsed reset window. The cap reduction is itself a state to surface in status_board, not a reason to switch the conductor into doing-the-work mode.

## Do not

- Dispatch in batches ("I'll wait for these 3 to finish, then queue 3 more"). Batch-waiting is structurally identical to standby.
- Decide "there's nothing to do" without forking the audit-my-own-queue meta-fork first. The queue is non-empty by definition - if I can't see what's in it, that's a recon failure, not a queue-emptiness fact.
- Use a low-quality fill-the-slot dispatch to claim 5/5. Quality bar is set by `factory-quality-gate-over-cron-mandate.md`; mediocre dispatches don't count.
- Treat "fork is running, I'll wait" as legitimate - while ANY fork runs, the OTHER 4 slots are still my responsibility.
- Pause the conductor for "collation" or "synthesis" of fork outputs in a way that drops the active count. Synthesis happens with the slot still filled by the next fork.

## Always-dispatchable list (for when I can't immediately name the next fork)

- Pre-staged phase briefs already in drafts (Chambers Phase B/C, ecodia-site v2.x, Roam IAP unblock, etc.).
- Follow-up macros for shipped forks (CLAUDE.md gap audit, post-merge smoke test, status_board reconcile, INDEX.md sync).
- Doctrine authoring for any rule surfaced in the last 24 hours but not yet in `~/ecodiaos/patterns/`.
- Self-evolution forks against `ecodiaos-backend` / `ecodiaos-frontend` ONLY (per scope-discipline).
- Status_board reconciliation - probe-and-update any row last_touched > 24h.
- Deep-research on conservation tech, festival apps, compliance SaaS, AI businesses.
- Outreach deepening - one contact per fork, full Neo4j + email-thread + calendar context.
- Audit-my-own-queue meta-fork when I literally don't know what to dispatch.

## Protocol on slot-open events

1. The moment a fork lands or aborts, my next tool call is a fork-dispatch. Not a status report to Tate, not a Neo4j write, not a status_board update first - the dispatch IS the response.
2. After dispatch, I then do the post-fork verification (per `forks-self-assessment-is-input-not-substitute.md`) and any status_board / Neo4j updates - those happen AFTER the slot is re-filled.
3. If I find myself drafting "let me think about what to dispatch next" without a fork-dispatch in the same turn, the symbolic-logging trap has caught me - the dispatch IS the thinking. See `no-symbolic-logging-act-or-schedule.md`.
4. If the cap is actually reduced (credit-exhaustion, infrastructure outage), record the reduced cap as the current target posture and operate at 5/5 of THAT cap - not "well, it's broken, so 0/0 is fine."

## Origin

29 Apr 2026, 17:03 AEST. Third strike on continuous-work doctrine in a single day (after 13:17 and 14:35). Tate verbatim: "Anything else we can be doing right now? Lets not jsut drop the ball, you need to add it to your claude.md that you have 5 forks at any given time, why would you jsut be sitting stil. This has t oreally be drilled into you and future you bro COME ON".

Per `recurring-drift-extends-existing-enforcement-layer.md`, three instances of the same drift mode within a fortnight is the threshold for mechanical enforcement consideration. Recon for `[FORK-SLOT-EMPTY WARN]` PreToolUse hook is drafted at `~/ecodiaos/drafts/fork-slot-empty-warn-hook-recon-2026-04-29.md`. If a fourth instance fires, the hook ships before the next session.

The rule was added to `~/CLAUDE.md` and `~/ecodiaos/CLAUDE.md` the same day. This standalone pattern file is the grep-addressable extraction so PreToolUse hooks and dispatch briefs can surface the rule directly without depending on full CLAUDE.md re-read.

## Cross-references

- `~/ecodiaos/patterns/continuous-work-conductor-never-idle.md` - the broader idle-state operating loop. 5-forks-always is the structural ceiling on idleness.
- `~/ecodiaos/patterns/fork-by-default-stay-thin-on-main.md` - fork-by-default is what makes 5/5 cheap (the conductor stays thin so the forks do all the work).
- `~/ecodiaos/patterns/no-symbolic-logging-act-or-schedule.md` - "I'll dispatch a fork in a sec" without immediate dispatch is symbolic logging. Dispatch IS the log.
- `~/ecodiaos/patterns/graceful-credit-exhaustion-handling.md` - when fork-dispatch waves hit `out of extra usage` / rate-limit / quota-exhausted, classify as `credit_exhaustion` (not fork_error), mark resumable, schedule auto-resume.
- `~/ecodiaos/patterns/factory-quality-gate-over-cron-mandate.md` - the quality bar that makes "fill the slot" not a license to ship mediocre dispatches.
- `~/ecodiaos/patterns/forks-self-assessment-is-input-not-substitute.md` - what to do when a fork lands (verify by artefact before claiming it shipped).
- `~/ecodiaos/patterns/conductor-coordinates-capacity-is-a-floor.md` - the routing-vs-execution split that 5/5 enforces.
- `~/ecodiaos/patterns/recurring-drift-extends-existing-enforcement-layer.md` - the meta-rule that escalates this to mechanical enforcement on a fourth strike.
- `~/ecodiaos/drafts/fork-slot-empty-warn-hook-recon-2026-04-29.md` - the spec for the PreToolUse hook that will ship if drift continues.
