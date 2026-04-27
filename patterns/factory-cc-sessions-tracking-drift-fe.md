---
triggers: cc_sessions, tracking-drift, factory-fe, factory-frontend, files_changed-empty, confidence-misleading, factory-review, ordit-fe, coexist-fe, fe-worktree, phantom-vs-real, dispatcher-hard-gate, factory-attribution
---

# cc_sessions tracking drift on Factory FE dispatches — confidence + files_changed are unreliable. Inspect the worktree.

## Rule

When reviewing a completed Factory session against a client codebase, especially a frontend worktree, do NOT trust `cc_sessions.confidence_score`, `cc_sessions.files_changed`, or `get_session_progress()` output as ground truth. Multiple FE dispatches have logged confidence ~0.4 and `files_changed=[]` while the actual branch HEAD had advanced and the code on disk was clean and in-scope.

The cc_sessions tracking-drift signature: real commit landed, `commit_sha` populated, branch HEAD advanced, but post-run attribution lost so confidence and files_changed look like a phantom run.

## Do

- Pull `commit_sha` and `branch` from cc_sessions, then `cd` to the actual worktree and run `git show --stat <sha>` and `git log <branch>`. The worktree is ground truth.
- Read the diff in full against the original prompt scope and the relevant client patterns.
- Treat cc_sessions confidence as input, not output. Low confidence on an FE dispatch may mean the work is fine and tracking dropped attribution.
- Approve/reject based on what is actually on the branch.
- Write a Decision node in Neo4j with both the cc_sessions row figures AND the worktree truth, so future-you can spot the same drift fast.

## Do Not

- Do NOT mark a Factory session "phantom" or "rejected for no commit" based purely on cc_sessions row figures when `commit_sha` is populated. Inspect the worktree first.
- Do NOT escalate dispatcher hard-gate work as urgent on the framing that "FE phantoms are producing nothing." Sometimes the work is landing and the tracking is lying. Diagnose attribution loss first.
- Do NOT re-dispatch a Factory session to "redo the FE work" without checking whether the prior session's branch already has the work.

## Protocol when reviewing any FE Factory session

1. `SELECT id, commit_sha, branch, codebase_id, confidence_score, files_changed FROM cc_sessions WHERE id = '<sid>'`
2. Resolve codebase_id to a worktree path (`~/workspaces/<slug>/fe`).
3. `cd <path> && git fetch origin --quiet && git show --stat <commit_sha>` — if this prints a real commit with files, the work landed.
4. Read the full diff: `git show <commit_sha>`.
5. Make the approve/reject decision against the prompt scope and client patterns.
6. If the worktree shows real work but cc_sessions logged it as low-confidence empty, log a Pattern instance to track drift frequency.

## Origin

Apr 27 2026. Reviewing Ordit Cognito follow-up dispatches `df377081` (BE) + `d5b4a36e` (FE). BE row had confidence 0.80 and files_changed populated — matched reality (8-line env-var toggle on `a871a32`). FE row had confidence 0.45 and `files_changed=[]`. Initial read suggested the FE was a phantom. Inspecting `feat/fe-cognito-poc` HEAD `f0ad844` showed 304 lines of clean POC code: new `/internal/cognito-poc` page (noindex, banner explicitly NOT customer-facing login), isolated `cognito-poc/client.ts` + `api.ts` services intentionally not coupled to legacy axiosBaseQuery, graceful degradation when env vars absent, sessionStorage state, oidc-client-ts dep added.

Fork `mogzk70n` audited prior "FE phantoms" (XML `19229e36`, UI-lag `3d78a398`) and confirmed the same signature — work landed, tracking lost attribution. This downgrades the urgency of the previously-stated dispatcher hard-gate work (Decision 2985), since the failure mode is post-run attribution loss inside cc_sessions writes, not pre-run codebase staleness causing phantom dispatches.

Paired patterns: `factory-phantom-session-no-commit.md` (genuine phantom mode where commit_sha is null), `factory-codebase-staleness-check-before-dispatch.md`, `factory-approve-no-push-no-commit-sha.md`.
