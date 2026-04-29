---
triggers: working-tree-drift, fork-worktree, fork-worktree-isolation, post-fork-pull, narrate-vs-disk-fork-commits, scripts-hooks-missing-on-disk, phase-d-hooks-restoration-drift, classifier-disk-verify-fail, ref-vs-tree-divergence, git-pull-after-merge, working-tree-stale-head, branch-ref-moved-but-tree-did-not
---

# Fork-worktree commits do not propagate to the main working tree without an explicit pull

## The rule

When a fork (SDK fork or Factory session) commits work and pushes to a branch that lands on `origin/main`, the local `main` ref on the VPS may move forward — but the **primary working tree at `~/ecodiaos`** does NOT auto-update. Only the ref does. `git status` from the working tree reads its own checked-out HEAD, which may still be at a previous commit even when `origin/main` has moved forward. Disk probes (`ls`, `cat`, hook execution) read the working-tree files. If the working tree is at a stale HEAD, the conductor will see "MISSING" for files that genuinely exist on `main` but have not yet been pulled into the tree.

**The fix is mechanical, not investigative: after any fork-merge into main, run `git -C ~/ecodiaos pull origin main --ff-only` BEFORE any disk-probe-based verification.**

## The mechanism

The Claude Agent SDK runs each fork in its own isolated git worktree. A fork's git operations (commit, push) act on:

1. The fork's worktree HEAD (private to the fork, gone when the fork ends).
2. The shared `.git` directory's refs (the local `main` ref CAN move forward when the fork pushes and the upstream merge-commit lands back).

What does NOT happen automatically:

- The primary working tree at `~/ecodiaos` does NOT receive a checkout of the new HEAD.
- `git status` in the primary tree reads `~/ecodiaos/.git/HEAD` (its own pinned commit), not the network-fetched `main` ref.
- File contents in the primary tree are whatever was last checked out into it — which may be days behind the actual `main` HEAD.

Result: a fork can commit + push + merge a file. `git log origin/main` confirms the file is on `main`. `git ls-tree origin/main path/to/file` confirms the blob exists. But `ls path/to/file` returns "No such file or directory" because the working tree was last checked out before that commit landed.

This is **distributed-state-seam drift between the git ref database and the working tree filesystem**. Same architectural failure mode as status_board vs disk, narration vs deployed state, kv_store vs ledger. See `~/ecodiaos/patterns/distributed-state-seam-failures-are-the-core-infrastructure-risk.md`.

## Detection signal

The conductor can ALWAYS distinguish "file genuinely missing" from "working tree stale" with three probes in this order:

1. `ls -la <path>` → exit code 2 / "No such file or directory" → file not in working tree.
2. `git ls-tree HEAD -- <path>` (run from primary tree) → empty → file not at the working tree's HEAD.
3. `git ls-tree origin/main -- <path>` → blob entry → file IS on `origin/main`.

If 1 fails AND 2 is empty AND 3 returns a blob, the working tree is stale. The fix is `git pull`, not re-authoring the file.

If 1 fails AND 3 is also empty, the file genuinely does not exist on `main` and the narration that claimed it was shipped is wrong (separate failure mode — see `~/ecodiaos/patterns/factory-approve-no-push-no-commit-sha.md` and `~/ecodiaos/patterns/factory-phantom-session-no-commit.md`).

## The fix protocols

### Single-file recovery (no full pull)

When you need just one file and don't want to pull the whole branch:

```bash
git -C ~/ecodiaos checkout <commit-sha> -- path/to/file
```

This grabs the blob at that commit and writes it into the working tree without moving HEAD. Use when the working tree has uncommitted modifications you don't want disturbed by a pull.

### Full sync (preferred when working tree is clean)

```bash
git -C ~/ecodiaos status --short          # confirm clean
git -C ~/ecodiaos pull origin main --ff-only
git -C ~/ecodiaos log -1 --oneline        # verify HEAD moved
```

`--ff-only` is critical: refuse to merge if the local ref has diverged. A divergence here is a different failure mode (uncommitted feature work on the local main, or local commits the working tree never pushed) and should be investigated, not auto-merged.

### Mid-fork-wave: stash uncommitted state first

If the primary working tree has uncommitted changes from another fork (untracked files, modified telemetry logs, etc.), do NOT pull — `git pull` will fail or worse. First:

```bash
git -C ~/ecodiaos stash push -u -m "pre-pull stash <fork-id> <iso-timestamp>"
git -C ~/ecodiaos pull origin main --ff-only
git -C ~/ecodiaos stash pop                # if you want the changes back
```

See `~/ecodiaos/patterns/stash-and-clean-when-finding-sibling-fork-unsafe-state.md` for the full sibling-fork-state protocol.

## Verification (post-recovery)

After any `pull` or `checkout`, run the hook-stack invariant check from `~/ecodiaos/CLAUDE.md` ("Hook-stack invariant check (P1)"). Probes every hook command registered in `~/.claude/settings.json` and prints any path that doesn't resolve on disk. Empty output = working tree synced. Any MISSING line = either pull didn't take, or the file genuinely isn't on `main` yet.

## Do

- Pull the primary working tree immediately after merging a fork PR into main.
- Run the hook-stack invariant check at session start to catch tree-ref drift cheaply.
- Use `git ls-tree origin/main -- <path>` as the second-tier probe before declaring a file missing.
- Distinguish "stale tree" (fix: pull) from "narration drift" (fix: investigate the originating fork) at the probe layer, before any rework decision.

## Do NOT

- Re-author a file because `ls` returned "No such file or directory" — always run the 3-probe check first.
- Run `git pull` on a primary tree with uncommitted changes — stash first.
- Assume `git fetch` updates the working tree; it only updates remote-tracking refs.
- Trust narration ("fork X shipped Y") as evidence the working tree has Y.
- Treat working-tree-drift as a Tate-blocked or external problem; it is a 5-second `git pull` on the VPS.

## Origin

**30 Apr 2026 ~08:18-08:21 AEST.** fork_moklwqg2_dc4dcd shipped Phase-D mechanical hooks restoration as commit 9e3f7d4 on `main` (path-restricted `git checkout` from canonical sources, 4 hooks + lib helper from 635644b plus post-action-applied-tag-check.sh from 4c24ace). Conductor's post-merge probe of the primary working tree at `~/ecodiaos/scripts/hooks/` reported every restored hook as MISSING. Investigation by fork_mokmicul_83561c confirmed three drift modes converging: (a) primary working tree at stale HEAD, (b) `git ls-tree origin/main` confirmed the blobs WERE on main, (c) `pull origin main` resolved all five MISSING reports in one operation.

Same root cause as the 01:40 AEST `failureClassifier.js` not-on-disk failure earlier in the day (recent_doctrine entry 2 — feature branch commit not yet on main, working tree at main HEAD).

## Cross-references

- `~/ecodiaos/patterns/verify-deployed-state-against-narrated-state.md` — the meta-rule (narration is unreliable evidence; probe ground-truth substrate).
- `~/ecodiaos/patterns/narration-vs-disk-reconciliation-checklist.md` — the operational six-substrate probe checklist; this pattern is the git-ref-vs-working-tree instance of that checklist.
- `~/ecodiaos/patterns/distributed-state-seam-failures-are-the-core-infrastructure-risk.md` — architectural framing.
- `~/ecodiaos/patterns/factory-metadata-trust-filesystem.md` — companion: don't trust the session's reported `filesChanged`, probe the filesystem.
- `~/ecodiaos/patterns/stash-and-clean-when-finding-sibling-fork-unsafe-state.md` — when the working tree has foreign uncommitted state.
- `~/ecodiaos/patterns/sdk-forks-must-commit-deliverables-not-leave-untracked.md` — the sibling rule that authored work must be committed, not left as untracked working-tree state.
