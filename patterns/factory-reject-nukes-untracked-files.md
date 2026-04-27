---
triggers: factory, reject_factory_session, factory-reject, untracked-files, git-reset, worktree-clean, untracked-loss, dirty-worktree-dispatch, pre-dispatch-commit, factory-cleanup, lost-work, untracked-deleted
---

# Always commit pre-existing untracked files BEFORE dispatching Factory

## The rule

Before calling `start_cc_session`, commit (or stash) every legitimate untracked file in the codebase's working directory. `reject_factory_session` performs a worktree clean that deletes ALL untracked files in the repo, not just files the rejected session created. Anything left untracked at dispatch time is at risk of being nuked on reject.

## Why

The Factory cleanup step on reject runs the equivalent of `git reset HEAD && git clean -fd` (or the same effect via internal mechanism). It does not distinguish between:
- Files the rejected Factory session created
- Files I (the conductor) authored before dispatch and never committed
- Files Tate or another process dropped in the worktree
- Drafts directories, pattern files, scratch notes, anything

Everything untracked goes. The reset is operating on the codebase's git working directory, which on `ecodiaos-backend` is `/home/tate/ecodiaos`, the same directory I work in for pattern files, drafts, and notes. So my own pre-existing work IS in the cleanup path.

## Do

- Before any `start_cc_session` against `ecodiaos-backend`: run `git status -s` and review every `??` (untracked) entry.
- Commit any legitimate untracked files (pattern files, doctrine, drafts that matter) before dispatch.
- For genuine scratch you don't want to commit, move it OUT of the working directory (e.g. `mv scratch.md /tmp/` or `~/notes/`).
- Document this commit in the message (e.g. "pre-dispatch hygiene: committing pattern + drafts before fork-send-message Factory dispatch").

## Do not

- Do not assume `reject_factory_session` only touches Factory-authored files. It does not. It cleans the whole worktree.
- Do not assume Factory works in an isolated worktree clone separate from main. For `ecodiaos-backend`, the working directory IS `/home/tate/ecodiaos`, the same directory the conductor operates in.
- Do not save important content as untracked files thinking they'll persist. Either commit or move out of the repo.
- Do not panic-rewrite from cold context if reject-clean nukes something. Check `git stash list`, `git reflog`, and the file system carefully first. Reflog will show the reset point. Stash list might have something. But neither helps with files that were untracked at the time of the reset. Those are gone.

## Verification protocol (before every Factory dispatch on ecodiaos-backend)

```bash
cd ~/ecodiaos
git status -s
# Review every line. For each:
#   ' M file' (modified, tracked)  → safe, will be preserved on reject (worktree clean restores from HEAD)
#   '??  file' (untracked)         → AT RISK. Commit, stash, or move out.
```

If any `??` lines remain after review, decide deliberately for each one. Do not dispatch with at-risk untracked files in the tree.

## Origin

Apr 27 2026, 13:00 AEST. Dispatched Factory session a32be744 (fork send_message capability) with three untracked files in the worktree:
- `patterns/fork-by-default-stay-thin-on-main.md` (the new pattern I had just authored)
- `patterns/INDEX.md` (modified, tracked) - this one was safe
- `drafts/landcare/landcare-positioning-brief-2026-04-27.md` (7229 bytes of meta-loop work from earlier this morning)

The Factory session was a phantom (zero target deliverables). Rejected it. The reject ran a worktree clean which deleted both untracked files. The pattern file I could rewrite from conversation context. The Landcare brief was 7229 bytes of considered work and was lost from disk; only Neo4j references remained. Recovering it required recomposing from memory and notes.

The lesson is structural: the Factory worktree IS the conductor's working directory for the ecodiaos-backend codebase. Cleanup operations on Factory's worktree are also cleanup operations on my workspace. Treat untracked files in `/home/tate/ecodiaos` as transient unless and until committed.

A future hardening would be a pre-dispatch hook that checks `git status -s` and refuses to dispatch if untracked files are present without an `--allow-untracked` flag. Worth specifying. Adjacent to `prefer-hooks-over-written-discipline.md`.
