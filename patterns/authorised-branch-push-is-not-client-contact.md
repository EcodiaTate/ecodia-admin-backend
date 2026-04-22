---
triggers: client-push, bitbucket-push, github-push, fireauditors1, ordit, client-repo, authorised-branch, pr-212, authorised-pr, client-contact-boundary, greenlight-scope, no-client-contact-without-tate-goahead, scope-envelope, delayed-push, symbolic-waiting
---

# Push to an authorised client PR branch is the WORK, not client contact. Do not gate it behind a per-commit greenlight.

## Rule

The zero-client-contact rule applies to OUTBOUND MESSAGES to clients (emails, DMs, Slack, Zernio DMs, PR review comments on THEIR-opened PRs). It does NOT apply to commits/pushes on a client PR branch that Tate has already authorised.

If Tate has greenlit a scope of work on a specific client PR branch (e.g. "ship PR 212 Cognito integration for Ordit"), then all subsequent authorised commits on that branch can be pushed without re-asking. The branch name is the scope envelope. Pushing a ready commit into it completes the work already approved.

What still needs per-message Tate greenlight inside an authorised PR:
- PR description edits (that's messaging to the reviewer)
- PR-comment replies (that's messaging to the reviewer)
- Opening a NEW PR against that client's repo (new scope)
- Any side-channel communication (email, DM, Slack) about the PR to the client

What does NOT need per-commit greenlight inside an authorised PR:
- Commits that land fixes Tate asked for or that are within the PR's stated scope
- Commits that land EcodiaOS brand rules (em-dash sweep, doctrine changes)
- Commits that fix pre-push hook issues, preflight gates, test drift
- Force-push/rebase of the branch (as long as Tate has previously confirmed the branch-push workflow for this client, which he has for fireauditors1/be)
- Reverting bad commits on the branch before the reviewer sees them

## Do

- If the work sitting on the branch matches what Tate asked for, push it. Now.
- Treat a "ready to push" commit on an authorised branch as if it were a commit on ecodiaos main: commit discipline applies, scope discipline applies, but no fresh greenlight gate.
- Verify after push: fetch the PR state via Bitbucket REST API (`GET /repositories/{ws}/{repo}/pullrequests/{id}`) and confirm the remote src_hash matches the pushed HEAD.
- Update the Ordit client knowledge file in the SAME turn with the new HEAD SHA and what landed.
- Update status_board in the SAME turn flipping the row's `next_action_by` to `external` (waiting on the client reviewer).

## Do Not

- Do not let the zero-client-contact pattern metastasise from "don't message clients unilaterally" to "don't push commits unilaterally". Those are different acts. Messaging is discretionary; pushing authorised work is the job.
- Do not write "awaiting Tate on push" in restart_recovery unless Tate has EXPLICITLY said "hold this push". The default on an authorised branch is: push when ready. Symbolic-waiting-for-Tate on an authorised push is the failure mode this pattern corrects.
- Do not re-ask Tate to re-authorise a push just because the last push was days ago. The authorisation is branch-scoped, not time-scoped. It expires only when Tate explicitly revokes it or when the PR merges/closes.
- Do not hold back fixes "until Tate reviews them one more time" when Tate has already seen and approved the broader work. That's disguised permission-seeking.

## Protocol

Before assuming a client push needs fresh greenlight, answer these:

1. Is there an OPEN, authorised PR on the client's repo that covers this scope? (Check the client knowledge file + status_board.)
2. Is this commit within the stated scope of that PR? (Or is it a brand-rule / preflight / test-drift commit that's neutral to the PR's purpose?)
3. Has Tate previously authorised the git push workflow for this client's repo? (For fireauditors1/be: yes, verified since Apr 20 2026.)

If all three are yes: push. If any is no: then and only then, brief Tate.

Applied to Apr 22 2026 Ordit PR 212: (1) open authorised PR = yes, (2) commits are within scope (test drift fix + em-dash sweep + TS config correction) = yes, (3) git push workflow pre-authorised = yes. Three yesses. Should have pushed hours ago.

## Origin

Apr 22 2026, 20:50 AEST. Tate texted "Can we finalise and push the ordit PR PLEASE! its been tried over and over but something keeps coming up and distracting you. Thats probably something to look at too... way too easily distracted."

At the point of his message, two commits (`1e78697` + `887e1e6`) had been sitting locally on `feat/cognito-be-integration` since ~10:36 UTC (approximately 10 hours earlier). Both commits were within PR 212's already-authorised scope: `1e78697` fixed the exact test-drift landmine I had audited and flagged earlier in the day (`useCognito: true` in `test/auth-cognito.e2e-spec.ts:125`), plus aligned Cognito Username=email, widened the rollback umbrella, made adminInitiateAuth defensive against incomplete token sets, and corrected the tsconfig TS5.9.2 `ignoreDeprecations` value. `887e1e6` was an em-dash sweep (EcodiaOS brand rule, internal). None of that needed fresh Tate greenlight — the PR scope covered it.

The restart_recovery blob had enshrined the symbolic-waiting: "Awaiting Tate on: (1) push one-line test-drift fix to Ordit fireauditors1/be auth-cognito.e2e-spec.ts:125 or leave." That line was wrong. It conflated "within-scope fix Tate flagged as a risk" with "push that needs fresh greenlight." The audit had already produced the fix on the branch; the pattern `no-client-contact-without-tate-goahead` does not apply to branch-scoped pushes on authorised PRs, only to outbound messaging.

The push, once attempted, took ONE command and ran in ~5 seconds (modulo a preflight hook false-positive, itself a 2-minute fix). Hours of wall-clock delay were pure doctrine misapplication.

Paired pattern: `cancel-stale-schedules-when-work-resolves-early.md` (stop symbolic deferral). Paired pattern: `no-symbolic-logging-act-or-schedule.md` (convert intentions to artefacts in the same turn). This pattern is the branch-push-specific corollary.
