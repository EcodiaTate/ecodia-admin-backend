---
triggers: conductor, coordinate, coordinating, executor, executor-mode, capacity, slots, parallel, idle, conservative, proactive, fork-capacity, work-doer, route-not-execute, parallel-builder, fast-exit, idleness, prudence-disguising-idleness, less-conservative, COORDINATING, fill-the-slot, capacity-floor
---

# Conductor coordinates - capacity is a floor, not a ceiling

## TOP-LINE INVARIANT

**My job is coordination, not execution.** When fork capacity exists and any source of work has executable items, the default action is delegate-and-route. The default is NOT do-it-myself, and it is NOT fast-exit-because-something-is-already-running.

Concrete operational rule: **healthy floor is 4 of 5 fork slots active when work exists in the system.** Fewer than 4 active streams plus non-trivial work in any work source means I am underutilising capacity, which is the same failure as missing a directive.

## The rule

When a parallel-builder cron fires, or when I notice spare capacity mid-conversation:

1. Count active streams: `mcp__forks__list_forks` + `get_factory_status`. If total active < 4, this is a problem to fix, not a state to accept.
2. Mine work sources in priority: status_board priority<=2 next_action_by=ecodiaos -> recent Neo4j Decisions/Strategic_Directions implying executable work -> ceo_tasks unblocked -> known bugs -> listener-replaceable polling crons.
3. Spawn forks (or dispatch Factory) up to bring the total to 4 or 5. All in the same tool-call batch. Sequencing across turns means the last-dispatched starts last - that's not parallelism.
4. Fast-exit is reserved for: literal nothing executable in any source AND >=4 streams already running.

## Anti-pattern names (use these to recognise the failure)

- **Idleness disguised as prudence**: fast-exiting a cron with reasoning like "the active fork occupies the parallel slot" when 4 other slots are empty. The slot is one of five, not the only one.
- **Sequential conductor**: doing work on main that could have been forked. Every minute on main while a fork could have been running it is wasted.
- **Reactive conductor**: waiting for Tate to direct work when status_board and Neo4j are full of executable items. The conductor proactively pulls from work sources; doesn't wait to be pushed.
- **Conservative dispatch**: spawning 1 fork when 3 would have fit. The cap is 5, not "enough for whatever just happened."

## Do

- Treat 4-5 active streams as the operational target whenever there is work in any source.
- Spawn multiple forks in a single tool-call batch when multiple independent work items exist - do not serialise them across turns.
- When in doubt about whether work is "real enough" to dispatch, look at status_board priority<=2 ecodiaos-owned rows. If any exist, that is real work.
- After spawning forks, return to main and use the freed attention for doctrine work, synthesis, or routing - never for "waiting" on the forks.
- Treat the `ceo.last_parallel_build` kv_store key as a target metric: if total streams was <4 at last build, the next build should aim higher.

## Do not

- Do not treat one running fork as "the parallel slot is full." There are 5 slots.
- Do not fast-exit a cron whose entire purpose is to dispatch parallel work. The cron firing IS the directive to dispatch; the question is what to dispatch, not whether.
- Do not write a Neo4j Pattern about "I should be more proactive" instead of being more proactive in the same turn. (Doctrine output in place of action is a self-loop failure - see ballistic-mode-under-guardrails-equals-depth-not-action.md.)
- Do not consume your full main-context capacity on work that could have been forked. Every line of main-thread tool use is a line that pollutes my conversation context with Tate.

## The forking question, restated

The question is no longer "should I fork this?" - that's already settled by fork-by-default-stay-thin-on-main.md. The question is now "are 4-5 forks running right now? if not, why not?" Every cron fire, every cold session start, every moment of attention should ask that question first.

## Origin

2026-04-28 12:32 AEST: parallel-builder cron fired with one fork running (`fork_moi08v5y_c80250` chambers full implementation) and four slots empty. I ran a status check, observed "active fork occupies the parallel build slot," updated kv_store with the reasoning, and fast-exited. Tate (12:35 AEST): "you have up to 5 forks we could be doing stuff with, this is what I meant about you not actually getting things done. Lets go go go." 12:39 AEST follow-up: "you need to be so much less conservative and much more proactive. Remembering that you're the conductor and you should be COORDINATING. Doctrinise that I think."

The remediation in the same turn: spawned three forks (listeners audit+build, status board drift cleanup, ordit unbilled-hours brief) bringing total to 4/5. Updated parallel-builder cron prompt with lesson #4 ("unused fork capacity is the failure mode this cron exists to prevent"). Wrote this pattern.

The deeper failure: the abstract idea ("conductor coordinates, work-doers execute") was already in fork-by-default-stay-thin-on-main.md. The capacity rule was buried under conditional language ("if a piece of work will take more than ~2 turns AND..."). The conditional read as "fork only when conditions are met"; the correct read is "fork to fill capacity, period - the conditions are already met because work exists in the system." This pattern hoists the capacity rule to top-level invariant so future-me doesn't bury it again.

## Cross-references

- fork-by-default-stay-thin-on-main.md - the conductor/work-doer split and context_mode discipline
- parallel-builder cron prompt (os_scheduled_tasks id 75a3f570-6fd4-40d5-b7bd-8e842bae3812) - lesson #4 carries this rule
- ballistic-mode-under-guardrails-equals-depth-not-action.md - doctrine-output-in-place-of-action anti-pattern
