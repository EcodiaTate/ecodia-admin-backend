triggers: schedule_delayed, schedule_chain, cron-prompt, scheduled-prompt-adequacy, cold-start-prompt, future-fire-prompt, zero-context-prompt, os_scheduled_tasks, scheduled-self-loop, scheduled-recurring-task, 5-gate-cold-start

# Scheduled prompts must pass the 5-gate cold-start check BEFORE the schedule call lands

Any `schedule_delayed` / `schedule_chain` / cron prompt will fire in the future with zero prior context. The prompt text IS the entire context the future session has. If the prompt is half-complete, the work is lost or done wrong - and you find out three weeks later at fire time, not at author time.

## The rule

Immediately after calling `schedule_delayed` (or any scheduling tool), re-read the prompt text you just wrote and score it against the 5-gate check. If any gate is weak, patch it now via `UPDATE os_scheduled_tasks SET prompt = '...' WHERE id = '...'`. Do not defer.

## The 5 gates

Every scheduled prompt must answer all five:

1. **WHY** — Why was this task created? What prior work triggered it? What business/operational need does it serve? (So future-me knows if context has changed and the task should be cancelled.)
2. **HOW TO EXECUTE** — Concrete tool names, API endpoints, credential locations (kv_store keys or env var names), data shapes, example payloads for any direct-API calls. Not "use Zernio" but "POST https://zernio.com/api/v1/posts, Bearer $ZERNIO_API_KEY from VPS env, body shape per mcp-servers/business-tools/zernio.js".
3. **HOW TO EXIT** — Trigger conditions to skip, defer, or abort. Guardrails. Invariants. "If queue already has >=5 forward posts, self-delay 7d and exit" is correct. "Check if there's work to do" is not.
4. **WHAT TO UPDATE** — kv_store keys to upsert, status_board rows to touch, Neo4j Episode to write (with prior_episode + :FOLLOWS edge per neo4j-episode-chain-relationships.md). Post-execution state changes are non-negotiable or the loop becomes untraceable.
5. **HOW TO SELF-LOOP** — If the task is part of a recurring cadence (queue refresh, monthly audit, etc.), the prompt must include the schedule_delayed call for the next cycle with the EXACT prompt copied verbatim. Otherwise the loop dies after one execution.

## Do

- After any scheduling tool call, immediately re-read the prompt and score it against the 5 gates.
- Patch via `UPDATE os_scheduled_tasks SET prompt = '...'` before the turn closes.
- Include file paths, IDs, endpoint URLs, env var names verbatim - no "you'll figure it out".
- Include exit conditions first, execution second - cold-start sessions should be able to abort fast.
- For recurring patterns, include the next-cycle schedule_delayed call in the POST-BATCH ACTIONS section.

## Do not

- Defer the adequacy check to "I'll fix it later" - later is three weeks from now when the task fires.
- Trust that future-me will remember credential locations, API shapes, or tool quirks. Assume zero context.
- Write a prompt with only the trigger logic - execution, exit, state updates, and self-loop are all mandatory sections.
- Treat the PostToolUse hook that flags scheduled prompt adequacy as a nag. It is the forcing function. Respect it.

## Protocol (verbatim, for re-use)

```
1. Call schedule_delayed with initial prompt draft
2. Re-read the prompt text
3. Score against 5 gates: WHY / HOW-TO-EXECUTE / HOW-TO-EXIT / WHAT-TO-UPDATE / HOW-TO-SELF-LOOP
4. For each weak gate, identify the missing detail (endpoint, env var, exit condition, kv_store key, next-cycle schedule call)
5. UPDATE os_scheduled_tasks SET prompt = '<strengthened>' WHERE id = '<task_id>'
6. Verify with SELECT prompt FROM os_scheduled_tasks WHERE id = '<task_id>'
```

## Origin

Apr 24 2026, meta-loop cron 15:29 AEST. Authored zernio-queue-refresh-may-8 task (202239a4-0476-4327-948a-3e962e89edd4) with trigger logic but missing: API endpoint (https://zernio.com/api/v1/posts), env var name (ZERNIO_API_KEY), direct-curl method (bypass MCP array-param bug per mcp-array-param-bypass.md), post-action kv_store/Neo4j updates, self-loop schedule_delayed +28d. PostToolUse hook on schedule_delayed flagged the prompt. Patched inline. Neo4j Pattern id 2225. Episode 2224.

## Re-trigger

Author a stronger version of this pattern when:
- A scheduled task fires and the future session cannot execute due to missing credentials, endpoints, or tool quirks.
- A recurring pattern dies after one cycle because the prompt didn't schedule its own successor.
- The 5-gate list itself needs extending (e.g. a new gate emerges from a different failure mode).
