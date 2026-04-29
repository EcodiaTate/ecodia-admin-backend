---
triggers: stash-and-clean, unsafe-branch-state, sibling-fork-collision, defensive-git, parallel-fork-recovery, working-tree-clean, uncommitted-sibling-work, git-stash-attribution, parallel-fork-shared-branch, fork-collision-recovery, working-tree-dirty, mid-edit-crash, recoverable-stash, stash-with-attribution, fork-id-stash, sibling-fork-stash, never-discard-uncommitted-work, branch-already-modified, foreign-changes-on-branch
---

# Stash-and-clean when a fork finds a sibling-fork's branch in unsafe state

## Rule

When a fork starts work on a feature branch and finds **uncommitted changes from a sibling fork's interrupted work** (typical: api crash, network drop, abort mid-edit), the responsive action is:

```
git stash push -u -m "<my-fork-id>-stash-of-prior-uncommitted-work"
```

The `-u` flag includes untracked files. The message is keyed to the fork doing the stashing (NOT the sibling fork), so a future recovery operation can find "the stash created when fork X found dirty state".

After stashing, the fork proceeds on a clean tree, runs its own work, and surfaces the stash name in `[FORK_REPORT]` so the conductor can route a recovery fork to inspect / pop / discard the stashed work.

**NEVER** discard uncommitted sibling-fork work without inspection. **NEVER** `git checkout .` or `git reset --hard` on a working tree with foreign uncommitted changes. **ALWAYS** stash with attribution.

## Why this rule exists

In autonomous parallel-fork workflows, multiple forks may be assigned overlapping branches (or the conductor dispatches a continuation fork onto the original fork's branch). When the original fork is interrupted (api crash, abort, timeout), its in-progress edits may sit uncommitted on the working tree. A fresh fork landing on that branch sees:

- Files modified relative to the last commit.
- Untracked files the prior fork was about to add.
- Possibly a half-staged index.

The naive responses all fail:

| Naive action | Failure mode |
|---|---|
| `git checkout .` or `git reset --hard` | Permanently destroys the prior fork's in-progress work. Cannot be recovered. |
| Build on top of the dirty state | New fork's commits include the prior fork's incomplete work, attributing it to the wrong author and shipping a half-baked deliverable. |
| Branch off and ignore the dirty tree | Subsequent operations (checkout, pull, rebase) error or silently merge the foreign changes. |
| Do nothing and report blocked | Wastes the fork slot and leaves the prior work in limbo with no recovery path. |

`git stash push -u -m <attribution>` resolves all four:
- Work is preserved (recoverable via `git stash list` and `git stash apply`).
- Working tree is clean for the new fork to proceed.
- The stash name attributes the rescue to the fork that did it, so future-me can correlate stash to event.
- The stash name surfaces in `[FORK_REPORT]`, so the conductor can dispatch a recovery fork without searching blind.

## Protocol

```
1. On entering any branch the fork was dispatched to, run:
     cd <repo>
     git status --porcelain

2. If output is empty: clean tree, proceed normally. STOP HERE.

3. If output is non-empty: there is uncommitted state. Classify:
   - Is it expected? (e.g. the brief said "your prior fork commit-X is on this branch")
   - Is it foreign? (no expectation in the brief, no attribution to current fork)

4. If foreign / unexpected:
     git stash push -u -m "<my-fork-id>-stash-of-prior-uncommitted-work-on-<branch>"
     git status --porcelain   # verify clean now

5. If stash command failed: do NOT continue. Surface the failure in [FORK_REPORT] with full git status output and STOP.

6. If stash succeeded: proceed with the brief's work on the now-clean tree.

7. In [FORK_REPORT], list the stash name and approximate sibling-fork id (if known) so the conductor can recover:
     STASHED: <my-fork-id>-stash-of-prior-uncommitted-work-on-<branch> (presumed sibling fork: <sibling-fork-id>)

8. If the stash needs recovery later:
     git stash list | grep <my-fork-id>
     git stash show -p stash@{N}        # inspect
     git stash apply stash@{N}          # restore
     git stash drop stash@{N}           # only after rebuild verified
```

## What "attribution" means

Two fork ids matter in this pattern:

- **The stashing fork** (the one that found the unsafe state): its id goes into the stash message. This is the only id the stashing fork can be sure of.
- **The sibling fork** (whose work created the unsafe state): may or may not be known. If the conductor brief identifies it ("the prior fork was X"), include it in the stash message as `presumed-sibling=<X>`. If unknown, don't guess - leave it for later recovery.

The attribution rule: stash to the **rescuer's id**, not the **owner's id**. The owner (sibling fork) may be unknowable; the rescuer always knows itself.

## Do

- `git status --porcelain` on every branch entry, before any edits.
- `git stash push -u -m <attribution>` when foreign state is found - the `-u` flag is non-negotiable; without it, untracked files are not stashed and will be silently overwritten.
- Surface the stash name in `[FORK_REPORT]` so the conductor can dispatch a recovery fork.
- Verify clean tree (`git status --porcelain` returning empty) before proceeding to the briefed work.
- When the conductor dispatches a recovery fork, it should reference the stash name verbatim from the original `[FORK_REPORT]`.

## Do NOT

- Do NOT `git checkout .` or `git reset --hard` on a dirty tree. Permanent data loss.
- Do NOT `git stash` without `-u` - untracked files (the most common mid-edit artefact) will be missed.
- Do NOT use a stash message that doesn't include a fork id - bare `git stash push` produces messages like "WIP on feat/xyz" which are unrecoverable in a graph of dozens of stashes.
- Do NOT proceed to the briefed work without verifying the tree is clean post-stash.
- Do NOT `git stash drop` (or pop) the rescued stash from inside the rescuing fork. That is the conductor's call after recovery is verified - don't lose data optimistically.
- Do NOT assume the foreign state is irrelevant just because it's uncommitted. Mid-edit work from a sibling fork may be 90% of a deliverable.
- Do NOT report the situation as "blocked" without stashing first - that strands the prior work in limbo and burns the fork slot.

## Recovery protocol (the conductor)

When a `[FORK_REPORT]` surfaces a `STASHED:` line, the conductor's options are:

1. **Apply the stash into a continuation fork.** Dispatch a fork briefed to:
   - `git checkout <branch>`
   - `git stash list | grep <stash-name>` to confirm presence
   - `git stash apply stash@{N}` (apply, do NOT pop yet)
   - inspect the changes
   - if useful: complete the work, commit, push, then `git stash drop stash@{N}`
   - if not useful: `git stash drop stash@{N}` and report

2. **Inspect and discard.** If the stashed work is verifiably superseded by later commits, `git stash show -p` to log the diff, then `git stash drop`.

3. **Long-park.** If the stashed work is interesting but not currently relevant, leave it stashed and add a status_board row noting the stash exists.

In all three cases, attribution is preserved: the stash name names the rescuing fork, the conductor can search for it, and the prior work is not silently lost.

## Origin

30 Apr 2026, 24:09 AEST (00:09 AEST 30 Apr in absolute time). The scheduler-fix fork (`mok4s59g_36837e`) was dispatched to apply a fix on the `feat/phase-d-failure-classifier-2026-04-29` branch. On entering the branch, it found uncommitted changes from the Phase D fork's (`mok4hdfa_e00208`) interrupted work - the Phase D fork had been mid-edit when the api crash hit, and PM2 respawn left its working state stranded on the branch.

The scheduler-fix fork ran:

```
git stash push -u -m "mok4s59g_36837e-stash-of-mok4hdfa_e00208-uncommitted"
```

This created stash `stash@{0}` keyed to the rescuing fork's id, with the presumed sibling fork named in the message. The scheduler-fix fork then proceeded on a clean tree, ran its own scheduler fix to completion, committed, pushed, and surfaced the stash name in its `[FORK_REPORT]`.

A subsequent Phase D continuation fork (`mok4serp`) was dispatched by the conductor, briefed to recover the stash. It ran:

```
git checkout feat/phase-d-failure-classifier-2026-04-29
git stash list | grep mok4s59g_36837e
git stash apply stash@{0}
# inspected diff, completed missing pieces
git commit -m "feat: phase D failure classifier (continuation of mok4hdfa, recovered from mok4s59g stash)"
git push
git stash drop stash@{0}
```

The Phase D work was recovered without loss. The scheduler fix shipped on a clean baseline. The protocol was validated empirically.

If the scheduler-fix fork had instead `git checkout .`'d the working tree, the Phase D work would have been permanently lost and the continuation fork would have rebuilt it from scratch - a 10-15 minute cost and a token-budget hit.

Codified by fork_mok57rx9_308d21 at 24:19 AEST 30 Apr 2026.

## Cross-references

- `~/ecodiaos/patterns/continuation-aware-fork-redispatch.md` - sibling pattern for the substrate-already-shipped case (this pattern handles the dirty-tree case; that pattern handles the committed-but-interrupted case).
- `~/ecodiaos/patterns/parallel-forks-must-claim-numbered-resources-before-commit.md` - related concern when sibling forks may have written numbered resources mid-flight.
- `~/ecodiaos/patterns/factory-reject-nukes-untracked-files.md` - parallel rule for the Factory case; reject_factory_session destroys untracked files. Stash-first is the protective pattern in both cases.
- `~/ecodiaos/patterns/check-pre-kill-commits-before-redispatch.md` - related pattern: check committed work on the branch before redispatch. This pattern covers the uncommitted-work case the same applies for committed work.
- `~/ecodiaos/patterns/distributed-state-seam-failures-are-the-core-infrastructure-risk.md` - the meta-rule; uncommitted sibling-fork state on a shared branch is one specific seam.
- `~/ecodiaos/patterns/stage-worktree-before-factory-dispatch.md` - prevention layer; clean baselines before dispatch reduce the frequency of this pattern firing.
- `~/ecodiaos/patterns/no-symbolic-logging-act-or-schedule.md` - "the stash worked" without writing the pattern is symbolic; this file is the act.
- `~/ecodiaos/patterns/codify-at-the-moment-a-rule-is-stated-not-after.md` - the meta-rule that triggered this file's authoring.
