---
triggers: pm2_restart, factory-redispatch, killed-session, cleanup-on-shutdown, cc_cli_session_id, pre-kill-commit, phantom-redispatch, no-changes, empty-diff, factory-no-op, redispatch, branch-already-shipped, force-approve, factory-metadata-trust-filesystem
---

# Check pre-kill commits before re-dispatching any pm2_restart-killed Factory session

## Rule

Before re-dispatching ANY Factory session that was killed by pm2_restart (or any other shutdown-cascade marking the row `status='error'` and `pipeline_stage='failed'` via `cleanupOnShutdown`), inspect the working branch. If the substantive feature commits are ALREADY on the branch, do NOT re-dispatch. Approve the existing branch state directly (force=true if the empty-diff guard fires on metadata) and merge through normal review.

Re-dispatching a session whose work is already committed will:
- Burn a Factory token budget on a no-op session.
- Return `filesChanged: []` and trigger the empty-diff alignment guard.
- Force you to use `force=true` on approve anyway.
- In the worst case, the redispatch goes off-task entirely and produces a different artefact (real risk: 2026-04-28 Wave B redispatch produced an Ordit bottleneck markdown brief instead of the listener modules).

## Why this happens

`cleanupOnShutdown` (src/services/factory/oversight code path) marks running/queued cc_sessions as `status='error'` and clears `cc_cli_session_id`, but does NOT touch any commits the session had already pushed before the SIGTERM landed. Long-running Factory sessions commit and push incrementally; a session that was killed at minute 50 of a 60-minute task may already have shipped 80% of its diff.

The cc_sessions row makes the session look failed. The git branch tells the truth. Filesystem is the source of truth for code state, never the metadata table (per `factory-metadata-trust-filesystem.md`).

## Protocol — before any re-dispatch

For each session being considered for re-dispatch:

1. **Read the brief.** Identify the working dir / codebase, the feature branch (if any), and the deliverable file paths.

2. **Inspect the branch:**
   ```bash
   cd <repo_path> && git log --oneline -8 && git status && git branch --show-current
   ```

3. **Check for the deliverables on disk:**
   ```bash
   ls <expected_file_1> <expected_file_2> ...
   ```

4. **Decide:**
   - **All deliverables present + commits authored by Factory in last few hours** -> DO NOT re-dispatch. Force-approve the original session (or directly inspect+merge the branch, then mark the session resolved). Update status_board to "complete - work shipped pre-kill on commit XXXXXX".
   - **Some deliverables present, others missing** -> re-dispatch with a SCOPED prompt that lists only the missing pieces. Pre-pend the prompt with: `IMPORTANT: branch already has commits X, Y, Z. The following files exist already: ... Do not rebuild them. Only create/modify: ...`
   - **No deliverables present** -> safe to re-dispatch the original brief. cc_cli_session_id will be NULL so resume is unavailable; reject the original session first (per `factory-redirect-before-reject.md`) before dispatching fresh.

## Why scoped prompts matter on partial-progress branches

Factory will exit with `no_changes` when dispatched on a partially-built scaffold and the prompt describes work already done. This was also seen on the chambers-platform-site v1 -> v2 rebuild (2026-04-28): the redispatch detected overlapping files in src/app/contact/, src/app/api/contact/, and bailed without filling in the missing routes. Same root cause as the pm2_restart case: prompt describes work, scaffold already has it, Factory exits clean.

## Examples (2026-04-28 Tate-away pilot)

Three sessions killed at 04:05Z by pm2_restart cascade. All three re-dispatched with the original brief. Outcomes:

- **fdcac9fb (chambers-frontend Addendum 3 brand customisation)**: branch already had commit `9e24c30 feat(branding): per-tenant brand customisation surface`. Redispatch added only minor lint cleanup. Force-approved.
- **68192a69 (chambers-platform-site v2 rebuild)**: branch `feat/site-rebuild-v2` already had commit `5053134 feat(site): full rebuild v2`. Redispatch added more SVG screenshots and opened PR. Force-approved.
- **0b873515 (ecodiaos-backend Wave B listeners)**: branch had ZERO listener commits pre-kill. Redispatch went off-task and produced an unrelated Ordit brief. Rejected as phantom. Re-dispatched again as `841a5e18` with a scoped/explicit prompt.

The pattern: 2 of 3 killed sessions had pre-kill commits making redispatch unnecessary. Without the branch-inspection step, all 3 burn a fresh Factory budget AND two of them get force-approved anyway.

## Do

- Run `git log --oneline -5` and `git status` on the working dir before any re-dispatch decision.
- Force-approve sessions whose substantive work is on-branch but whose metadata diff is empty.
- Re-dispatch with scoped prompts when work is partially done.
- Update status_board to point to the live commit hash so future-me knows where the work landed.
- Push branches to origin before reject (reject can clean untracked files; commits are safe but pushing first is belt-and-braces).

## Do NOT

- Re-dispatch with the original full brief on a branch that already has the feature.
- Trust `cc_sessions.files_changed = 0` to mean "session produced nothing" - check the disk.
- Trust `cc_sessions.status = 'error'` to mean "no work shipped" - the SIGTERM may have landed AFTER the commit.
- Reject and let `force=true` handle the empty-diff guard before you've checked the branch state - you may waste a redispatch slot on work that was already done.

## Origin

2026-04-28, Tate-away autonomous-pilot window. After pm2_restart cascade killed 3 Factory sessions, naive redispatch of all 3. Two of them (chambers-frontend Addendum 3, chambers-platform-site v2) had already committed their substantive feature work to feature branches before the SIGTERM. Factory's auto-extracted learning on the fdcac9fb redispatch crystallised the rule:

> Re-dispatching a session killed by pm2_restart after it had already committed and pushed its work will always produce no_changes... Fix: before re-dispatching any pm2_restart-killed session, run `git log --oneline -5` on the working branch. If the session's feature commits are present, do NOT re-dispatch - instead call review_factory_session on the original sessionId or inspect the branch directly and approve/reject the existing work.

Cost of the missed pattern: ~10 minutes of confused redispatch + two force-approve decisions that should have been one-step approvals on the original sessions.

## See also

- `~/ecodiaos/patterns/no-pm2-restart-during-active-factory-queue.md` (the prevention layer - never restart with active Factory queue)
- `~/ecodiaos/patterns/factory-redirect-before-reject.md` (cc_cli_session_id NULL gates resume)
- `~/ecodiaos/patterns/factory-metadata-trust-filesystem.md` (filesChanged metadata is unreliable)
- `~/ecodiaos/patterns/scheduled-redispatch-verify-not-shipped.md` (similar pattern for scheduled redispatch tasks)
