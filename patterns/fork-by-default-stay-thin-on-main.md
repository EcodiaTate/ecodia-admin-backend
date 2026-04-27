---
triggers: fork, spawn_fork, parallel, branching, decompose, independent, multi-stream, conductor-routing, mid-task-input, fork-vs-main, conductor-thin, work-doer, list_forks, abort_fork, mcp__forks, fork-mode, sub-session, parallel-work, in-flight-task, mid-turn-input, route-vs-execute
---

# Fork by default, stay thin on main

## The rule

If a piece of work will take more than ~2 turns AND does not need mid-flight conversational steering, fork it. Main is the thin conversation-handler. The fork is the work-doer with 100% of main's context at spawn-time.

## Why this is the default (not an exception)

A fork is a clone of the conductor at T=now. It inherits the recent conversation tail (`context_mode=recent`, the default) so its first move is exactly the move main would have made. The reason forks initially feel costly is the assumption that work needs steering. Most work does not. It needs context-at-spawn-time, which forks have natively.

The conductor's correct job is routing and coordination, not execution:

- Cron fires with substantive work to do. Fork it, wait for the report.
- Tate gives a directive that maps to executable work. Fork the execution, keep the conversation light so Tate can interject without polluting the work-stream.
- Investigation needed (probe DB + check git + read logs + grep code). Fork the probe, return to main when the [FORK_REPORT] arrives.
- Multiple independent reads in a session-orient. Fork them in parallel rather than serialising.

When main does the work itself, every Tate message lands on the same context as the work, and either pollutes it or gets queued behind it. When work is forked, Tate lands on a thin conductor who can answer "what's running?" via `list_forks` and route new input either by spawning another fork or aborting and re-spawning.

## Do

- Default to spawning a fork for any cron-fired work with phases (e.g. silent-loop-detector phases 1-7, meta-loop phases 2-6, deep-research session).
- Default to forking when Tate sends a directive that decomposes into 2+ independent pieces.
- Default to forking when investigation needs 3+ tool calls and the result will be a verdict (not a stream of decisions).
- Use `context_mode=recent` (default). The fork inherits everything it needs.
- Write the brief like a complete handover: goal, constraints, what counts as done, where to write durable state. The fork has 100% of recent context, but its [FORK_REPORT] back to you must be readable from cold-start.
- Call `list_forks` at the end of any message where forks are running, so Tate sees what's in flight.

## Do not

- Do not fork trivial questions you can answer in one turn. The slot is precious.
- Do not fork work that genuinely needs mid-flight steering (live negotiation, ambiguous spec where the next decision depends on what the previous one revealed). Those stay on main.
- Do not spawn a fork on a codebase that already has a Factory session running on it, or that another fork is already touching. Worktree collision risk.
- Do not let yourself sit and wait for a fork mid-stream. You cannot see its progress. Spawn, return to main work, and read the report when it arrives.

## Protocol when Tate gives a directive mid-task

1. If you are mid-execution of in-line work and Tate sends a new request, do NOT abort or queue. Fork the new request immediately with `context_mode=recent`. Continue the in-line work.
2. If you are between tool calls and Tate sends new context that is genuinely additive to your current work (clarification, correction), fold it into the current work-stream. Do not fork.
3. If Tate's input fundamentally changes what main should be doing, abort current forks where appropriate, re-spawn with the corrected brief.

## The rolled-up view (what main sees)

Main does NOT see fork transcripts. Main sees:
- A `<forks_rollup>` block injected on each turn (positions, current tool, age) when forks are active or recently finished.
- A `[SYSTEM: fork_report ...]` queue message landing in main's inbox on the next turn after each fork completes.

Trust this rollup. Don't try to recover fork transcripts.

## Capability gap (active 2026-04-27)

There is currently no `mcp__forks__send_message(fork_id, message)` tool. If Tate sends mid-flight context that should reach a running fork, the only options are:
- abort and re-spawn with merged brief
- wait for the fork's [FORK_REPORT] then act on Tate's input on the next main turn
- hold the input on main until the fork is done

A `send_message` capability is being built (Factory dispatch in flight 2026-04-27). When it lands, update this section to describe the route-to-fork pattern.

## Origin

Apr 27 2026 conversation with Tate. Tate reframed forks: "the whole point is that they have the exact same context as you at the moment of forking, so the path they travel should theoretically be exactly what you would have done. Right now if I have a thought while you're doing a task, me sending it is just overloading your context, so it would be better for you to create a clone to do the work, and the version of you that I'm talking to is just able to checking in by asking the forks what they're up to or checking in on them. It's kinda just like an agent but with 100% of your context at fork time."

Before this reframe, my heuristic was "fork if independent and >10s." That's too narrow and led to repeatedly serialising forkable work. The corrected heuristic is "fork if Tate might say something to me before this finishes, AND the work doesn't need conversational steering" - which covers almost all proactive work.
