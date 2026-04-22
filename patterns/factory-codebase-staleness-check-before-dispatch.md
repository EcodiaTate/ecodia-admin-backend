---
triggers: factory, factory-dispatch, start_cc_session, codebase-staleness, worktree-stale, behind-origin, divergent-base, fe-dispatch, frontend-factory, ecodiaos-frontend, rebase-conflict, unmergeable-commit, stale-clone, codebases-registry
---

# Factory codebase-staleness check before dispatch

## The rule

Before dispatching any Factory session against a codebase, the worktree Factory will operate on MUST be fresh against `origin/<base-branch>`. If it is N commits behind, Factory branches off stale code and produces a commit that cannot rebase onto current main. Result: a phantom-with-local-commit (Mode-1 phantom variant) where the work is real but unlandable.

The cost of skipping this check: the entire Factory session is wasted, the diff is unrecoverable, and the work has to be re-dispatched on a fresh clone. Often the only forensic trail is a local commit on the VPS that conflicts with origin in non-obvious ways (deleted files, package-lock drift).

## Do

- Before any `start_cc_session` against a codebase whose worktree lives on the VPS, run `git fetch origin <base> && git status` and abort if HEAD is behind origin.
- For codebases Tate edits directly (e.g. `ecodiaos-frontend` from Corazon, where commits like `ddhfdh` land daily), default to `git fetch origin main && git reset --hard origin/main` before dispatch when the working tree is clean.
- For codebases where the VPS clone is the only writer, a behind-status is itself a bug to investigate (something is force-pushing or someone else is committing).
- After Factory completes, before approving deploy, run `git log --oneline origin/<base>..HEAD` to verify the new commit cleanly rebases. If it does not, do not approve - reject and re-dispatch.

## Do not

- Trust that the codebases registry path is auto-fresh. The registry stores the VPS path; nothing in the dispatch pipeline currently fetches before clone.
- Accept a "complete" Factory session at face value when its `commit_sha` is local-only and origin has moved. The work is phantom-shipped, not real-shipped.
- Try to manually resolve rebase conflicts in code Factory wrote. Cherry-picking across deleted files and package-lock drift is exactly the situation we delegate to Factory in the first place. Re-dispatch on fresh base is cheaper and safer.

## Protocol when a stale-base session is discovered

1. Verify it is genuinely Mode-1 stale-base (not just the FE-divergence pattern of Tate's manual commits) by running `git log --oneline origin/<base>..HEAD` in the Factory worktree.
2. Reject the session with `reject_factory_session` and a reason that names the stale base + commit count.
3. If the work was valuable and the base was simply stale (not the spec being wrong), re-dispatch the same prompt against a fresh clone. Use `redispatch: true` with the original prompt verbatim.
4. Log the discovery to `status_board` so the codebase staleness gets fixed at the registry / dispatcher level, not just patched per-session.
5. Add a corresponding `Pattern` node in Neo4j with the same name as this file so semantic search finds it too.

## Origin

Apr 22 2026, 16:25 AEST. Reconciling phantom Factory sessions during MCP harness audit. Factory FE session `60726daf-fb4b-418e-9dea-a49a84d3c6ad` (message-queue v1 frontend) reported `status=complete` but the cc_sessions row showed `commit_sha=null, pipeline_stage=executing`. Investigation showed the work landed as commit `b5877b70` in the local FE worktree at `~/workspaces/ecodiaos/fe`, but that worktree was 95 commits behind `origin/main`. Tate had been pushing FE commits directly from Corazon (mostly `ddhfdh` WIP commits) including deletions of `src/pages/KGExplorer/index.tsx` and `src/pages/Momentum/index.tsx` - both files Factory's b5877b70 modified. Rebase produced a 4-way conflict (modify/delete on both deleted pages, content conflict in `src/pages/Cortex/index.tsx`, content conflict in `package-lock.json`). Aborted rebase, rejected session, scheduled re-dispatch on fresh clone.

The deeper bug is that the dispatcher does not fetch before clone, so the registry path is silently stale whenever the human is editing the same codebase from elsewhere. Until that is fixed at the dispatcher level, any FE-codebase Factory dispatch must be preceded by a manual fetch+reset.
