---
triggers: parallel-builder, factory-dispatch, always-have-work-queued, dispatch-quality-gate, speculative-factory, mediocre-dispatch, idle-factory, cron-mandate, quantity-vs-quality, factory-slot, no-slot-to-fill
---

# Factory dispatch quality gate supersedes cron mandate to dispatch

The parallel-builder cron says "always have work queued. Idle Factory = wasted compute." That mandate is secondary. Factory slots are cheaper than the review effort for a rejected session plus the trust cost of shipping speculative churn. When the candidate list is thin, dispatch ZERO or ONE well-scoped sessions, not 1-3 speculative ones.

## The rule

Before dispatching any Factory session triggered by a scheduling mandate (parallel-builder, self-evolution, any cron that says "dispatch N sessions"):

1. Enumerate candidates from status_board + Neo4j + known bugs.
2. For each candidate, classify: **high-confidence / deferred / speculative**.
3. Dispatch only **high-confidence** candidates, up to the per-codebase serialisation limit (1 per codebase).
4. If zero high-confidence candidates exist, dispatch zero and log the reasoning. That is a legitimate outcome. The cron mandate does not override quality.

## Classification criteria

**High-confidence (dispatch):**
- Single file or small tightly-scoped set of files
- Clear acceptance test (pass/fail is obvious, not subjective)
- No client-code exposure or zero-client-contact gating
- No dependency on Tate-live decisions
- Worktree fresh vs origin (check per `factory-codebase-staleness-check-before-dispatch.md`)
- Unblocks downstream verification of already-shipped work (highest value)

**Deferred (do not dispatch this slot):**
- Requires Tate-live scoping, input, or sign-off
- Requires a fresh clone or repo state that is not currently prepared
- Part of a chain where an upstream step is still pending approval

**Speculative (do not dispatch at all under a cron mandate):**
- Pure analysis / investigation tasks (low Factory confidence historically)
- Research or "explore this area" framings
- Anything where the acceptance test is "produces a useful output" without concrete deliverable
- Attempts to fix a root cause without a reproducer

## Do

- Log every candidate considered, with classification, to the Neo4j Episode for the cron fire. Future sessions will see the reasoning, not just the outcome.
- Dispatch one scoped session when one is available, even if the cron says "1-3."
- Use the full cold-session review prompt protocol (`cancel-stale-schedules-when-work-resolves-early.md`, `factory-phantom-session-no-commit.md`, `factory-metadata-trust-filesystem.md`) on every dispatch.

## Do not

- Dispatch against a client codebase just to hit a parallel count.
- Dispatch analysis/investigation tasks to Factory because "the slot is empty."
- Dispatch against `ecodiaos-frontend` without explicit worktree reset if Tate has been active on Corazon (high staleness risk).
- Treat a zero-dispatch outcome as failure. Log it and move on.
- Let the cron's framing ("Idle Factory = wasted compute") override the meta-doctrine that mediocre output costs more than it produces (`ocd-ambition-refuse-mediocrity.md`).

## Protocol for thin-candidate nights

1. Enumerate, classify, pick highest-confidence single candidate.
2. If none qualify: write the Episode (with the candidate list), update `ceo.last_parallel_build` kv_store with `dispatched: []` and reasoning, and exit.
3. If one qualifies: dispatch it with full scope envelope, schedule cold-session review, document.
4. Never pad the slot to hit the cron's "1-3" target.

## Why this matters (the meta-doctrine)

A rejected Factory session costs:
- The compute of the original dispatch
- The context and tool calls of the review pass
- The rejection reasoning + Neo4j pattern write
- The re-dispatch scoping
- Trust cost if Tate sees the churn

A speculative Factory dispatch that happens to succeed is also a cost, because it accumulates code or infrastructure that nobody asked for, that nobody owns, and that future sessions have to read around.

The parallel-builder cron's mandate is a rough heuristic to prevent idle drift, not a rule. The quality gate on dispatches is the actual rule.

## Origin

2026-04-24 01:21 AEST. Parallel-builder cron fired. 0 active Factory sessions, 0 sessions needing review. Candidate enumeration showed: (a) three high-value items deferred by earlier explicit decisions pending Tate live (Canva autofill re-dispatch, Voice Engine scoping, NextBuild section 4.x); (b) two speculative items (MCP RCE audit, AbortController root cause investigation); (c) one high-confidence candidate (jest install in ecodiaos-backend devDeps to unblock listener registry tests). Dispatched the one high-confidence slot (session 56fe603c) and refused the rest. Neo4j Episode 2194 logged the decision. This pattern file exists because the tension between the cron mandate and the quality gate will recur every parallel-builder fire, and the decision should not be re-litigated each time.

See also:
- `ocd-ambition-refuse-mediocrity.md` (the quality bar for all output)
- `factory-phantom-session-no-commit.md` (what mediocre dispatches cost downstream)
- `factory-codebase-staleness-check-before-dispatch.md` (pre-dispatch gate)
- `cancel-stale-schedules-when-work-resolves-early.md` (review-prompt hygiene)
