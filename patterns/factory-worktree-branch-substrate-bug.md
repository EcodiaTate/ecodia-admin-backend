---
triggers: factory, factory-dispatch, factory-rejection, files_changed-empty, taskDiffAlignment-overlap-zero, worktree-branch, dispatcher-substrate, coexist, ecodiaos-backend, factory-false-negative, branch-state-leak, dispatched-branch-vs-checked-out-branch
---

# Factory diff review compares against the worktree's currently-checked-out branch, not the dispatched branch's base

## The rule

Before rejecting any Factory session that reports `filesChanged: []` or `taskDiffAlignment.overlapScore: 0` against a non-trivial deliverable, run two checks on the codebase worktree:

1. `git branch --show-current` - if it is anything other than `main` (or the dispatched branch itself), the review's diff is wrong.
2. `git rev-parse <factory-branch-name>` - if Factory's stated branch exists locally, inspect THAT branch's diff against `origin/main`, not the worktree.

If Factory's branch contains the requested edit, the session shipped correctly and the review is a false negative.

## Why this happens

The Factory dispatcher leaves the worktree checked out on whatever feature branch it last ran on. The next dispatch creates a new branch correctly, makes its commits on that new branch, but the review's "files changed since dispatch" comparison runs against the worktree's currently-checked-out branch (the previous feature branch) instead of the new dispatched branch's base. If the previous branch is N commits ahead of main, those N commits show up as "the diff" - hijacking the review and making the new work invisible.

## Today's incident (2026-04-27)

Two consecutive Factory dispatches against `coexist` for the Byron Bay collective alias task. Both rejected as no-ops with diff showing only an unrelated em-dash flip in `src/pages/updates/create.tsx`. Reality: both dispatches succeeded - branch `fix/collective-alias-byron-northern-rivers` had `0bceac5 fix(excel-sync): resolve "Byron Bay" sheet alias to Northern Rivers collective` (24 inserts, 3 deletes to the correct file) and `e58f136 fix(excel-sync): replace em-dash with hyphen in collective-not-found error`. The "diff" the review reported was from the previously-checked-out branch `fix/updates-rules-of-hooks-2026-04-27` which was 2 commits ahead of main, including the em-dash comment flip.

The first rejection was symbolic loss - the work was already there. The second rejection was the same loss, double-counted.

## Recovery protocol if this has already happened

1. `cd <codebase>` and `git branch -a` to find the Factory-created branch by name (will match the prompt's "Branch:" line).
2. `git log <factory-branch> --oneline -5` to confirm the work is committed on that branch.
3. `git diff origin/main..<factory-branch> --stat` and inspect file paths.
4. If files match the deliverable spec, the work shipped. Push the branch (or hold for go-ahead per client doctrine). DO NOT redispatch.
5. Update the rejected status_board row to reflect actual state: shipped, not failed.
6. Reset the worktree to `main` (`git checkout main && git pull`) so the substrate bug does not poison the next dispatch.

## Substrate fix needed

The dispatcher should either:
- (a) Reset the worktree to `main` (or a known clean base) before each `start_cc_session` call.
- (b) Have the review tool compare against the dispatched branch's base (recoverable from the prompt's "Branch from:" line or `git merge-base`), not against the current worktree branch.

(a) is the cheaper fix - one `git checkout main && git pull` in the dispatcher pre-flight. (b) is the more correct fix and survives bad worktree state.

Until the substrate is fixed, every Factory dispatcher caller MUST run the verify-on-disk check above before accepting a rejection at face value. Treat the review's `filesChanged` field as a hint, not as ground truth.

## Do

- Verify Factory work on disk before rejecting. Use `git log <branch>` and `git diff <branch>` directly.
- Reset the codebase worktree to `main` after every Factory dispatch closes (success OR failure), as a pre-emptive fix until the dispatcher is patched.
- Cross-reference Factory's stated branch name (in the prompt) against actual branches in the worktree.

## Do NOT

- Do not trust `review_factory_session.diff` as ground truth when the codebase has any feature branch ahead of main.
- Do not call `reject_factory_session` based on `filesChanged: []` alone - if the prompt asked for non-trivial work and the branch exists, the work might be there.
- Do not redispatch an "obviously failed" session a third time without doing the on-disk check. The third dispatch is the first one that runs on a working substrate only if you fixed the substrate. Otherwise it just produces a third false-negative.

## Relationship to existing patterns

- Same family as `factory-cc-sessions-tracking-drift-fe.md` (FE flavour, authored earlier today). This is the BE / Edge Function flavour with the worktree-branch substrate cause identified.
- Same family as `factory-phantom-session-no-commit.md` (no-commit phantoms) - both are review-vs-reality drift, different roots.
- Connects to `substrate-before-doer.md`: this incident IS the same-shape-twice diagnosis pattern - the doer (Factory) was fine, the substrate (dispatcher worktree state) was broken.

## Origin

2026-04-27 ~20:20 AEST. Tate-live session, Tate's "PUSH IT" directive, two consecutive Factory rejections on coexist Byron Bay alias task. Diagnosed when checking the coexist worktree state per substrate-before-doer protocol: worktree was on `fix/updates-rules-of-hooks-2026-04-27`, which was 2 commits ahead of main and explained the entire "fake diff" Factory's review kept reporting. Real deliverable was on the Factory-created branch the whole time. Recovered by pushing the branch directly. Logged here to prevent the next session from making the same false-negative call.
