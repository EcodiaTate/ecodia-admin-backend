---
triggers: factory, approve-factory-deploy, commit_sha, deploy_status, push, origin-drift, cc_sessions, manual-reconcile, state-drift, approve-pipeline-bug
---

# Factory approve returns success but does not push or populate commit_sha

## The rule

`approve_factory_deploy` currently returns `{"success": true}` and sets `cc_sessions.deploy_status = 'deployed'`, but it does NOT push the local commit to origin and does NOT populate `cc_sessions.commit_sha`. The deliverable is genuinely landed in the local worktree and the service is restarted - but on any fresh clone, or any observability query that trusts `commit_sha`, the work looks like it never happened.

**Treat every `approve_factory_deploy` success as incomplete until you verify `git push` landed AND `commit_sha` is non-NULL on the cc_sessions row. If either is missing, manual reconcile: push, then `UPDATE cc_sessions SET commit_sha = '<short-sha>' WHERE id = '<session-id>'`.**

## Why this matters

- Git log `origin/main..HEAD` grows silently. At the time this pattern was written, 5 consecutive Factory approvals were local-only: 1e4cda2 (Tier-1 retrieval), e3ceb08 (Tier-2 wiring), bc08eb2 (Tier-3 extractor), plus two earlier infrastructure commits.
- Downstream automation that keys off `cc_sessions.commit_sha` (review-tool alignment checks, deploy dashboards, self-evolution learning feed) mis-classifies genuinely-deployed work as phantom. This erodes trust in the approve pipeline and makes real phantom sessions (ones where the file never existed) harder to distinguish.
- Any server restart that fetches from origin will silently regress - the local commits vanish if the disk is ever wiped or the repo is re-cloned.

## Symptom signature (how to recognise it)

```sql
SELECT id, status, commit_sha, deploy_status, pipeline_stage
FROM cc_sessions WHERE id = '<sessionId>';
```

Returns:
- `status = 'complete'`
- `pipeline_stage = 'complete'`
- `deploy_status = 'deployed'`
- `commit_sha IS NULL`   <-- the bug

Combined with:
```bash
git log origin/main..HEAD --oneline
```
showing the session's commit message in the local-only list.

If BOTH conditions hold, you are in this bug, not Mode 1 phantom and not Mode 2 cleanup-wipe. The work is real, just not reconciled.

## Protocol - manual reconcile after every approve

Run after EVERY `approve_factory_deploy` until the pipeline is fixed:

1. `cd ~/ecodiaos && git log origin/main..HEAD --oneline` - if empty, push already happened (or nothing to push). If non-empty, proceed.
2. `git push origin main` - pushes all queued commits, not just the one from this session. Check for upstream-ahead conflicts first if relevant.
3. Match commits to sessions: `git log --oneline -5` against the `recent` list from `get_factory_status`. The commit message prefix (`feat(...)`, `fix(...)`) usually maps 1:1 to the session task.
4. For EACH unpushed-then-pushed commit: `UPDATE cc_sessions SET commit_sha = '<short-sha>' WHERE id = '<session-uuid>'`.
5. Verify with a read-back: `SELECT id, commit_sha FROM cc_sessions WHERE id IN (...)` - all targeted rows should have non-NULL commit_sha.

## Proper fix (Tier-4 queue)

Dispatch a Factory session against `ecodiaos-backend` targeting the approve route (`src/routes/claudeCode.js` or `src/services/claudeService.js` - grep `approve_factory_deploy` / `approve` handler). The fix:

1. After the approve path commits locally, run `git push origin <branch>` as part of the pipeline. Fail the approve if push fails (do NOT leave local-only work while returning success).
2. Capture the local commit SHA (short form) and set it on `cc_sessions.commit_sha` in the same transaction as `deploy_status = 'deployed'`.
3. Test by dispatching a no-op Factory session, approving it, and verifying `commit_sha` is non-NULL AND the commit exists on origin.

This fix belongs in the same queue as the Factory review-tool `filesChanged=[]` false-positive (the review-tool bug that forces `force=true` on every recent approve). Both are approve-pipeline observability bugs.

## Do

- Run `git log origin/main..HEAD --oneline` after every approve.
- Push + update `commit_sha` manually until the pipeline is fixed.
- Cross-reference `cc_sessions.commit_sha IS NULL` with `git log origin/main..HEAD` to tell this bug apart from Mode 1 phantom.
- Write a pattern when you notice the same failure has hit 3+ sessions in a row - which is what happened here.

## Do not

- Trust `deploy_status = 'deployed'` alone as proof of deployment. It just means the approve path completed, not that the commit landed on origin or that tracking is correct.
- Reject a session with `commit_sha IS NULL` before checking `git log origin/main..HEAD`. The reject-cleanup path will wipe real work.
- Rely on the review tool's `filesChanged[]` array. It has been consistently empty on recent sessions even when the diff (shown separately in the review output) is rich and the work landed. Cross-check with `git log -1 --stat` and `ls <expected-path>`.

## Origin

Apr 22 2026, ~12:35 AEST. During Tier-1/2/3 retrieval-architecture work:

- Tier-1 (1e4cda2), Tier-2 (e3ceb08), Tier-3 (bc08eb2) all approved via `approve_factory_deploy`.
- Each returned `success: true`.
- After the third approve, spot-check revealed all three commits were local-only (`git log origin/main..HEAD --oneline` showed 5 commits ahead, including two earlier infra commits not from this session batch).
- All three `cc_sessions.commit_sha` fields were NULL despite `deploy_status = 'deployed'`.
- Manual reconcile: `git push origin main` pushed all 5, then `UPDATE cc_sessions SET commit_sha = 'bc08eb2' WHERE id = '75353cfe...'` (plus e3ceb08 and 1e4cda2).
- Cost: would have looked like infrastructure regression on next fresh clone or observability audit. Caught before any downstream automation tripped on the NULL.

Related patterns:
- `factory-phantom-session-no-commit.md` - this bug is NOT a phantom session; the work is real. The two patterns together give the full disambiguation: Mode 1 (filesChanged populated from drift, target never existed), Mode 2 (reject-cleanup wipe), Mode 3 (this: work real, push+tracking missing).
