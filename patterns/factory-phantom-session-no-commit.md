---
triggers: factory, factory-dispatch, cc-session, approve-deploy, phantom-session, files-changed, commit-sha-null, deploy-status-deployed, ecodiaos-backend, worktree-drift, deliverable-verification
---

# Factory phantom sessions: never trust filesChanged or deploy_status without verifying the file on disk

## The rule

A Factory session reporting `status='complete'` and `pipeline_stage='failed'` (or even `deploy_status='deployed'`) does NOT mean the target file was created or committed. The session can hand back a `filesChanged[]` array populated entirely from the previous commit's diff (worktree drift) while having authored nothing. `commit_sha = NULL` in `cc_sessions` is the smoking gun: Factory thinks it deployed, but never made a commit.

**Before approving any Factory session on `ecodiaos-backend` (or any codebase), verify the deliverable exists on disk via `ls` or `Grep`. If `commit_sha` is NULL after deploy, the deploy was a no-op and the file is gone.**

## Why this matters

Factory sessions snapshot the worktree at dispatch time. If a recent commit landed seconds before, the snapshot diff includes everything from that commit, and the session's `filesChanged[]` reports those committed files as its own work. The session can then exit cleanly with no actual edits and the review tooling has no way to distinguish "claimed work" from "real work" without a disk check.

The downstream failure: `approve_factory_deploy` runs the deploy pipeline, finds nothing to commit, but still marks `cc_sessions.deploy_status = 'deployed'`. The reject path is worse: it `git stash`es or cleans the worktree, deleting any actual file the session DID write. So a phantom-session approval silently loses real work AND a phantom-session rejection silently loses real work.

## Three failure modes (all involve `commit_sha = NULL`)

**Mode 1 — Worktree drift phantom (Apr 21, session 4989b582):** `filesChanged[]` populated from a commit that landed seconds before dispatch; target file never existed on disk; session produced nothing.

**Mode 2 — Cleanup-path wipe (Apr 21, session a44af212):** file was on disk at review time, `approve_factory_deploy` ran the cleanup logic on a NULL-commit-sha session, file was wiped post-approve.

**Mode 3 — State-drift (real work, broken tracking) (Apr 22, session 9dbf39ce):** Factory did the work correctly, made a real commit locally, triggered PM2 restart, live endpoints serve the fix — BUT cc_sessions.commit_sha/deploy_status never populated AND the commit was never pushed to origin. The deliverable is real; only the tracking row and the push step failed. This looks identical to Mode 1/2 on a quick scan of cc_sessions, so the disk/commit verification below is the only way to tell them apart.

> **Mode 3 closed at source (Apr 22 2026, commit 818ca1e, Tier-4c session 47ca1767).** `src/services/deploymentService.js` `no_changes` branch now reads the current HEAD SHA, push-syncs the branch to origin, and `UPDATE cc_sessions SET commit_sha/deploy_status/pipeline_stage` on the no-changes path. The fix self-demonstrated on its own `approve_factory_deploy` call — 47ca1767 went through the fixed path and produced a valid commit_sha. Mode 3 should no longer occur for newly approved sessions; keep the manual-reconcile protocol (step 4) as a safety net for any pre-818ca1e session that still drifts, and in case of regression.

**Mode 4 — Review-tool wrong-diff (Apr 22 2026, session 92062dd6):** Factory committed the correct work (commit `00da85a`, 5 target MCP server files, +103/-12, exactly the 11 specified sites), but `review_factory_session` returned a completely unrelated diff showing files from concurrent in-flight work in the worktree (sessionAutoWake.js, scheduler/index.js os_signal_handoff additions, app.js messageQueue wiring, server.js sweep poller boot — none of which were part of 92062dd6's scope). `taskDiffAlignment.flagged=true` with 0% keyword overlap correctly warned but pointed at the wrong cause. If I had trusted the review tool and called `reject_factory_session`, the cleanup path would have wiped the uncommitted message-queue feature that was in progress in the worktree — and that feature had just delivered a live queued message to the running OS session. The review tool's diff is unreliable when there is concurrent uncommitted work in the repo; trust `git log` and `git show --stat <expected-sha>` instead.

> **Mode 4 protocol addition (Apr 22 2026):** before calling `reject_factory_session` on any session flagged by `taskDiffAlignment`, run `git log --oneline -10` and look for a commit whose message matches the task's stated commit title (e.g. `fix(mcp-servers): preventative object/array-param coerce...`). If that commit exists and `git show --stat <sha>` matches the session's stated scope, this is Mode 4 — the review tool lied, the session succeeded. Do NOT reject. Reconcile manually: `UPDATE cc_sessions SET commit_sha=<sha>, pipeline_stage='complete', deploy_status='deployed', confidence_score=0.95 WHERE id=<sessionId>`.

## Protocol

Before EVERY `approve_factory_deploy` or `reject_factory_session` on a session against `ecodiaos-backend`:

0. **(Mode 4 gate) If `taskDiffAlignment.flagged=true` OR the review diff looks unrelated to the stated task, run `git log --oneline -10` and grep for the task's stated commit title BEFORE doing anything else.** If a matching commit exists, this is Mode 4 — do NOT reject, reconcile cc_sessions manually. Rejecting Mode 4 wipes any uncommitted concurrent work in the worktree.
1. **Verify the actual deliverable exists on disk.** Use `ls -la <expected-target-path>` (NOT just the `filesChanged` array from `review_factory_session`). For migrations: `ls src/db/migrations/ | tail -3`. For new modules: `ls <expected-path>`. For tests: `ls tests/ | grep <feature>`.
2. **Verify a new commit landed.** `git log --oneline -3` and check the top commit is genuinely new (compare timestamps to the session's `started_at`).
3. **Cross-check `commit_sha`.** Query `SELECT commit_sha, deploy_status FROM cc_sessions WHERE id = <sessionId>`. If `commit_sha IS NULL` and `deploy_status = 'deployed'`, the deploy was a no-op OR a state-drift (see step 4 to differentiate). The session may or may not have produced real work.
4. **Check push state.** `git fetch origin main && git log origin/main..HEAD --oneline` — if the top local commit is ahead of origin AND it matches the session scope AND the file is on disk, you are in **Mode 3 (state-drift)**: the work is real, but not pushed and not tracked. Do NOT run `approve_factory_deploy` (cleanup path risk). Do NOT run `reject_factory_session` (wipes uncommitted work if any). Instead: **manual reconcile** — `git push origin main`, then `UPDATE cc_sessions SET commit_sha='<short-sha>', deploy_status='deployed' WHERE id=<sessionId>`, then functional verification (curl the affected endpoints).
5. **Live functional check.** For API/route changes: curl the affected endpoints with proper auth (`TOK=$(grep MCP_INTERNAL_TOKEN ~/ecodiaos/.env | cut -d= -f2); curl -s -H "Authorization: Bearer $TOK" <url>`). If the response matches the fix spec, the deployment is live regardless of what cc_sessions says.
6. **If the file is in the diff but not on disk:** Mode 1 phantom. Recover by either (a) re-dispatching with `git status` and `git log -1 --stat` required as the final shell command in the session prompt, or (b) reconstructing the file from the diff in `review_factory_session.diff` and committing it manually.
7. **If `filesChanged[]` matches the previous commit's `git show --name-only HEAD`:** confirmed Mode 1 phantom. Reject with reason `phantom-no-deliverable` and re-dispatch on a clean worktree.

## Dispatch hardening to prevent recurrence

Every `start_cc_session` prompt against `ecodiaos-backend` should end with this verification block:

```
## Final-step verification (mandatory)
Before marking the session complete, run these commands and include their output verbatim in your last message:

  ls -la <expected-deliverable-path>
  git log -1 --stat
  git status --short

The session is INCOMPLETE until these three commands have been run AND their output appears in the response.
```

This forces Factory to confirm its own delivery on the actual filesystem instead of trusting its in-memory diff state.

## Do

- `ls` the expected deliverable file BEFORE every approve/reject
- Check `commit_sha` in `cc_sessions` is non-NULL before approving
- Reject phantom sessions with explicit reason text so the failure pattern is captured
- Bake `git log -1 --stat` into the session prompt's acceptance criteria
- Stash uncommitted local changes (`git stash` or commit) before dispatching a Factory session against `ecodiaos-backend`

## Do not

- Trust `filesChanged[]` or `deploy_status='deployed'` as proof of delivery
- Approve a session whose `commit_sha` is NULL
- Reject a session whose target file DOES exist on disk (you'll lose the work via the cleanup-on-reject path)
- Dispatch concurrent Factory sessions on the same codebase (this is a separate failure mode but compounds the phantom-session problem)

## Origin

Apr 21 2026, ~15:30 AEST. Two consecutive Factory sessions on `ecodiaos-backend` exhibited the phantom-deliverable pattern in the same hour:

- **Session 4989b582** (ASC API server-side client): dispatched with 8 acceptance criteria targeting `src/services/appStoreConnect.js`. Returned `status='complete'`, `confidence=0.72`, `filesChanged=[25 files]`. Disk check showed `appStoreConnect.js` did not exist. The 25 listed files were all from commit `431cb60 patterns: seed grep-addressable doctrine dir` which landed minutes before the session started. Rejected with `requeued=false`.
- **Session a44af212** (`laptop-agent/tools/asc.js` Puppeteer scaffold): dispatched ~20 minutes later. Returned `status='complete'`, `confidence=0.717`, `filesChanged=['laptop-agent/tools/asc.js']`. The file was confirmed present on disk (132 lines, syntax-valid) at review time. Approved via `approve_factory_deploy`. Post-approval check: `commit_sha=NULL`, `deploy_status='deployed'`, file gone from disk. The approve path's cleanup logic wiped the file without committing.

Cost: ~30 minutes of investigation, lost a working stub that has to be either re-dispatched with stricter gates or hand-reconstructed from the spec. Trust hit on the Factory pipeline. Pattern logged so future-me checks `ls` before trusting any Factory deliverable claim.

Related patterns:
- `factory-dispatch-scope-verification.md` (referenced in INDEX.md but file not present - drift to be fixed)
- The `learnings` array on session 4989b582 includes `Factory worktree snapshot was taken AFTER git commit 431cb60 landed, so the session's baseline diff included all files from that commit` - this pattern formalises that learning.
