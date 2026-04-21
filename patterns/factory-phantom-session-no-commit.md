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

## Protocol

Before EVERY `approve_factory_deploy` or `reject_factory_session` on a session against `ecodiaos-backend`:

1. **Verify the actual deliverable exists on disk.** Use `ls -la <expected-target-path>` (NOT just the `filesChanged` array from `review_factory_session`). For migrations: `ls src/db/migrations/ | tail -3`. For new modules: `ls <expected-path>`. For tests: `ls tests/ | grep <feature>`.
2. **Verify a new commit landed.** `git log --oneline -3` and check the top commit is genuinely new (compare timestamps to the session's `started_at`).
3. **Cross-check `commit_sha`.** Query `SELECT commit_sha, deploy_status FROM cc_sessions WHERE id = <sessionId>`. If `commit_sha IS NULL` and `deploy_status = 'deployed'`, the deploy was a no-op. The session produced nothing real.
4. **If the file is in the diff but not on disk:** the session authored it in its own scratch space but the commit hook failed. Recover by either (a) re-dispatching with `git status` and `git log -1 --stat` required as the final shell command in the session prompt, or (b) reconstructing the file from the diff in `review_factory_session.diff` and committing it manually.
5. **If `filesChanged[]` matches the previous commit's `git show --name-only HEAD`:** confirmed phantom session. Reject with reason `phantom-no-deliverable` and re-dispatch on a clean worktree.

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
