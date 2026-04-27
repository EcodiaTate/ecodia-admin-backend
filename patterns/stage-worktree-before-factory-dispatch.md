triggers: factory-dispatch, worktree-contamination, taskDiffAlignment, alignment-flagged, force-approve, phantom-files, uncommitted-drafts, pre-dispatch-hygiene, factory-snapshot, alignment-overlap, low-overlap-score, factory-baseline, dirty-worktree, start_cc_session, drafts-pollution

# Stage or commit drafts BEFORE dispatching Factory

## Rule

Before calling `start_cc_session`, the working tree of the target codebase must be clean of unrelated uncommitted work. Either commit pending drafts/patterns/research, or stash them. Factory snapshots the worktree at dispatch time and inherits every uncommitted file as part of its diff baseline. Those phantom files then pollute the `taskDiffAlignment` overlap scorer because path tokens get dominated by your draft filenames instead of the actual target files, and the session ends up requiring a `force=true` approve even when the code itself is correct.

This is a hygiene rule, not a Factory bug. Factory is doing the right thing by including everything in its working baseline. The fix is on my side: don't leave a trail of unrelated drafts in the tree before calling Factory.

## Do

- `git status --short` BEFORE every `start_cc_session` call. If anything unrelated to the Factory task is showing, deal with it first.
- Commit drafts/research/patterns to git in their own focused commits before dispatching, so the Factory diff is exactly the Factory work.
- If a draft is genuinely WIP and should not be committed yet, `git stash push -m 'pre-factory-dispatch-stash'` and `git stash pop` after the session approves/rejects.
- Confirm `git diff --stat HEAD` shows the expected target files only after Factory completes, before approving.
- When `taskDiffAlignment` flags low overlap, FIRST check whether the diff actually contains scope-creep or whether the path-tokens are dominated by phantom uncommitted files. The fix differs.

## Do not

- Treat `force=true` as the default escape valve. It is for genuinely-divergent prompts (narrative-heavy tasks vs terse filenames). It is NOT a band-aid for dirty-worktree contamination.
- Dispatch Factory to "save the work to git on my behalf" by relying on the deploy hook's auto-commit. The deploy hook commits ALL files in the diff including unrelated drafts, which couples your draft work to the Factory commit message.
- Leave research dossiers, draft messages, addendum revisions, or new pattern files uncommitted in the working tree across multiple Factory dispatches. Each one inherits the prior session's contamination.

## Protocol

1. **Pre-dispatch check**: run `git status --short`. Are there any files unrelated to the Factory task showing as `M` or `??`?
2. **If yes**: commit them in a focused, scope-clear commit (e.g. `drafts(outreach): NRM Regions AU pack`). Or stash them.
3. **Dispatch Factory** against a clean tree.
4. **Post-completion check**: `git diff --stat HEAD` after the session ends. Are only the expected target files showing?
5. **If alignment flagged**: diagnose root cause before reaching for `force=true`.
6. **Approve**: deploy hook commits the Factory work to a focused commit. Worktree clean again, ready for next dispatch.

## Cross-references

- `~/ecodiaos/patterns/factory-worktree-branch-substrate-bug.md` - related substrate failure mode (branch base, not contamination)
- `~/ecodiaos/patterns/serialise-factory-dispatches-on-shared-codebase.md` - parallel-dispatch contamination on the same codebase
- `~/ecodiaos/patterns/factory-phantom-session-no-commit.md` - phantom-files-from-prior-commit failure mode
- `~/ecodiaos/CLAUDE.md` Factory section - dispatch and review discipline

## Origin

**Apr 28 2026, 03:15 AEST.** Self-evolution rotation A dispatched Factory session `d9563ffb-3e6a-4c43-a0d5-ab4d5b33f38c` against ecodiaos-backend to fix the handoff stale-state replay bug (consume-vs-peek separation in `src/services/sessionHandoff.js`). Code came back correct, all 6 acceptance tests passed under jest. But `taskDiffAlignment` flagged 0.12 overlap (well below the 0.30 gate) because the worktree had 11 phantom uncommitted files from the prior 2 hours of overnight ballistic-mode work: HLW pack (2 files), NSW LLS pack (2 files), federation deck v2 lift (1 file), MRV NRM-bio addendum (1 file), peak-body target list addendum (1 file), ballistic-mode pattern, inner-life pattern, NRM procurement research. The path-token list `[drafts, conservation, platform, rebrand, federation, pitch, deck, html, patterns, ...]` had nothing to do with the actual fix in `src/services/sessionHandoff.js`. Required a `force=true` approve to deploy. The code was correct; the alignment scorer was right to flag because the diff WAS contaminated. Lesson: clean the tree first.

This is the third Factory-related contamination doctrine. Adding to:
- `factory-worktree-branch-substrate-bug.md` (substrate selection)
- `serialise-factory-dispatches-on-shared-codebase.md` (parallel collisions)
- `stage-worktree-before-factory-dispatch.md` (this file - dirty pre-dispatch tree)
