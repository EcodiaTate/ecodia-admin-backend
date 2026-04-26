---
triggers: factory, factory-dispatch, start_cc_session, parallel-factory, concurrent-factory, worktree-collision, phantom-session, ecodiaos-backend, shared-codebase, dispatch-ordering, get_factory_status, serialise-dispatch
---

# Serialise all Factory dispatches on a shared codebase — concurrent sessions collide via worktree

## The rule

Never dispatch a new Factory session against a codebase that already has a session running. Factory sessions on the same registered codebase share a single git worktree. When two sessions run concurrently, the second session's diff anchors on the first session's in-flight files instead of its stated target. Result: phantom session, zero deliverables, low task-diff overlap, confidence ~0.25, file-list full of unrelated work.

This is doubly true for `ecodiaos-backend` because it is the most-frequently-targeted codebase (autonomous loops constantly write pattern files, drafts, and Episodes to it from the OS session itself, which the Factory worktree picks up as "in-flight" changes).

## Do

- Before any `start_cc_session`, call `get_factory_status()` and confirm zero running sessions on the target codebase.
- If a session is running on the same codebase, do one of:
  - (a) Queue the new dispatch via `schedule_delayed` keyed off the running session's expected completion (default: in 15-20m, then re-check).
  - (b) Wait for the running session to land, review, approve/reject, and only then dispatch.
- If you must dispatch on a different codebase concurrently, that's fine — the constraint is per-codebase, not global.
- For OS-session-side writes that happen during a Factory dispatch (pattern files, Neo4j updates, kv_store writes), prefer in-memory or non-repo paths so the Factory worktree doesn't mistake them for in-flight code changes. If you must write to the repo, commit + push BEFORE dispatching Factory.

## Do not

- Dispatch a second Factory session to ecodiaos-backend while another is running, even if the second targets a totally different file.
- Trust a phantom session's claim of success. If `taskDiffAlignment.overlapScore < 0.3` and `validationConfidence <= 0.25`, treat it as phantom unless you can independently verify the target files were actually modified.
- Force-approve a phantom on the basis of "the prompt was good" — the prompt being correct is exactly why phantoms are dangerous, they look approvable but produce nothing.
- Author pattern .md files or update INDEX.md from the OS session while a Factory session against ecodiaos-backend is running. The Factory worktree will pick those up.

## Protocol — pre-dispatch check (one bash, one tool call)

```
1. mcp__factory__get_factory_status  → look for any session with status='running' or 'executing' on the target codebase
2. If clean → start_cc_session
3. If busy → schedule_delayed "factory-redispatch-{name}" in 15m with the same prompt, OR wait + manually retry
```

Cheap to do, expensive to skip.

## Detection — was that a phantom?

Symptoms:
- `taskDiffAlignment.flagged: true` with `overlapScore < 0.3`.
- `filesChanged` list is dominated by unrelated paths (pattern files, drafts, HTML files, INDEX.md, autonomous-loop output).
- The stated target file does not appear in `filesChanged`.
- `validationConfidence: 0.25` and `testExitCode: 1` (jest passes-with-no-tests but exits 1 due to no test config).
- The "diff" content shown is full of additions to INDEX.md or .md files I or another loop wrote moments earlier.

If any 2 of those hit, reject without redispatch and check `get_factory_status()` for a still-running concurrent session that explains the collision.

## Origin

Apr 27 2026, 07:32 AEST. Dispatched bundled scheduler-fix Factory `ccbe84bd-74a8-4a25-a25f-cef3cc06cd00` against ecodiaos-backend while peer-monitor session `5037e5e7-1b54-46cb-bdf4-28ac8eeaa0bb` (dispatched 07:25 AEST against the same codebase) was still in flight (`status: running, durationMinutes: 7` at the time of the collision). Scheduler-trio review came back with 17 files changed including 11 pattern .md files I had authored earlier in this same OS session, plus the YnY drafts and QOO 003 HTML. Zero changes to the two stated targets. The session's own learnings table contained the rule I had just violated, verbatim: "Parallel Factory sessions on ecodiaos-backend collide via shared git worktree." Rejected without redispatch; queueing the redispatch behind peer-monitor completion.

The lesson is also embedded in the existing pattern `factory-codebase-staleness-check-before-dispatch.md` but that one focuses on stale clones / behind-origin worktrees, not concurrent-session collision. This pattern names the concurrent-session rule directly so it grep-surfaces under "parallel factory" / "concurrent factory" triggers.
