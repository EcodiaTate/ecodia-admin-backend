---
triggers: phantom_session, repeat_failure, substrate, infra_bug, same_shape, factory_phantom, scheduler_eat, mcp_route_mismatch, ladder_failed_twice, third_dispatch
---

# Substrate before doer - when failures repeat in shape, suspect the floor before the ceiling

## The rule

When the same kind of work keeps failing in the same shape, the bug is more often in the substrate the work runs on than in the work itself. After the **second** same-shape failure, stop retrying the work and audit the layer that runs it.

## Why

Retrying the doing is the path of least resistance. It feels like progress (you wrote a new prompt, you dispatched a new session). It is usually wrong because:

- A doer that fails twice on near-identical input is unlikely to succeed on the third identical input. The variance is in the substrate, not the doer.
- Every minute spent fixing the substrate compounds across every future invocation. Every minute spent on the doing pays back once.
- The failure mode hides at the layer above the work. Reading that layer with the failure mode in mind almost always finds the bug fast.

## Do

- After the **second** same-shape failure, freeze the work loop. Do not redispatch.
- Read the layer above (harness, route, scheduler, contract, instruction template) and grep for the failure shape.
- Fix the substrate. Deploy. Then re-run the original work, unchanged, against the fixed substrate.
- Record the substrate fix as a Pattern + the fixed-vs-broken commits, so the next person finds it.

## Do NOT

- Do not assume the doer (Factory, fork, client, contractor) is the bug after a same-shape repeat. They might be, but check the floor first.
- Do not rewrite the doing prompt as a coping move when the real bug is in the route that delivered the prompt.
- Do not let the third retry be the first time you read the harness layer. By then you have burned tokens, time, and trust.

## Concrete examples

| Same-shape failure | Real bug location | Fix commit |
|---|---|---|
| Factory a32be744 + a3288300 both phantom-rejected on ecodiaos-backend, identical prompts | Scheduler `isTateActive` pre-gate ate review fires (20min defers) AND MCP resume route accepted `{content}` while MCP server sent `{message}` | 4d98a546 (deploy 2026-04-27 13:46 AEST) |
| Once substrate fixed, ccb3b54e shipped first try with the same prompt | (substrate, not work) | 0a50a25 |

## Generalisation

The same logic applies outside Factory:
- Fork fails in shape X twice -> suspect the conductor (osSessionService, route, queue), not the fork.
- Client goes silent in shape Y twice -> suspect the engagement framing (scope, cadence, channel), not the client.
- LLM output reads generic across multiple drafts -> suspect the prompt/instructions/CLAUDE.md doctrine, not the model.
- Cron skips fires in same window -> suspect the scheduler poller, not the cron prompt.

## Protocol when you hit a same-shape repeat

1. Don't redispatch. Stop the loop.
2. Name the failure shape in one sentence ("Factory completes status=complete with filesChanged=0 and taskDiffAlignment overlap < 15%").
3. List the layer above the work: route, scheduler, contract, instruction template, MCP server.
4. Grep that layer for the failure shape's keywords.
5. Read the path the failure takes through that layer end-to-end.
6. Fix what you find. Deploy.
7. Re-run the original work with the original prompt against the fixed substrate.
8. If the third attempt also fails the same way, the bug is genuinely in the doer - now redesign the prompt or replace the doer.

## Origin

2026-04-27. Fork-send-message capability third-dispatch ladder. Two phantom-rejections (a32be744 nuked untracked pattern files, a3288300 had cc_cli_session_id NULL after status=complete). Diagnosed at the scheduler/MCP layer, not the prompt layer. Bundled fix landed via Factory 4d98a546. Identical prompt redispatched as ccb3b54e shipped first try (commit 0a50a25, 4/4 tests passing). Three attempts; the third was the first one running on a working substrate. Tate had been telegraphing this lesson for weeks ("be less passive", "make the ladder reflexive", "make crons wake idle") - same lesson three different ways.
