---
triggers: sdk-forks-must-commit, fork-deliverables-uncommitted, untracked-in-git, working-tree-only, fork-no-commit, mcp-forks-spawn-fork, sdk-fork-discipline, fork-ship-but-uncommitted, on-disk-untracked, narrated-shipped-uncommitted, branch-switch-loses-untracked, clean-checkout-loss, deliverable-vulnerable, fork-bookkeeping, fork-completion-checklist, git-status-untracked, post-fork-commit-pass, file-mtime-newer-than-head, verify-deployed-state-distinguish-missing-vs-untracked, glob-pattern-ls-failure, explicit-path-verify, sibling-fork-git-clean, working-tree-wipe, untracked-destruction-event
---

# SDK forks must commit deliverables, not leave them untracked

When a fork (`mcp__forks__spawn_fork`) lands a filesystem deliverable (a script, a draft, a screenshot, a spec, a data file) and updates state stores (Neo4j Decision/Episode, status_board row, kv_store entry) saying the deliverable shipped, the fork MUST also `git add` and `git commit` the deliverable on whatever branch it's working on (`main` for VPS-internal doctrine work, the appropriate feature branch for code work). Files left as untracked working-tree state are functionally available on the current VPS instance but are vulnerable to **clean-checkout loss, branch-switch-driven cleanup, AND active destruction by concurrent sibling forks running `git clean` / `git checkout .` / `git reset --hard`**. Worse, they create a state-store-vs-git mismatch that misleads any future verify probe.

This is the **fork-ship-completion** invariant. Narration in state stores ("shipped at path X") is only as durable as the underlying file's git-commit status. An untracked file is functionally a phantom-ship-in-waiting: any branch operation by a sibling fork can remove it, and the state stores keep narrating it as shipped long after it's gone.

## The probe (verify-deployed-state, distinguishing three states)

When a verify probe asks "is X actually shipped?", there are three states the file can be in, NOT two:

| State | `[ -f path ]` | `git log -- path` | Functional? | Durable? |
|---|---|---|---|---|
| **Committed** | yes | non-empty | yes | yes |
| **On disk, untracked** | yes | empty | yes | NO — vulnerable to clean checkout, branch switch, sibling-fork `git clean`, working-tree wipe |
| **Missing** | no | empty | no | n/a |

The correct verify probe is **explicit-path** (`ls -la "$path"` with a literal string, NOT a glob like `cowork-*` which can fail to expand) AND a `git log` check. Conflating "missing" and "on-disk-untracked" produces phantom-ship false-positives (the file IS shipped, just not committed). Conflating "on-disk-untracked" and "committed" produces phantom-ship false-negatives (the file LOOKS shipped, but won't survive the next `git checkout` or sibling-fork `git clean`).

## The fork checklist (what every fork must do at end-of-work)

Before emitting `[FORK_REPORT]`, the fork must:

1. **Stage every new or modified file** that is part of the fork's stated deliverable. `git status --porcelain` to see the working tree, `git add <explicit-paths>` for each. Do NOT use blanket `git add -A` because that captures sibling-fork untracked files (which is a different doctrine; see `~/ecodiaos/patterns/stash-and-clean-when-finding-sibling-fork-unsafe-state.md`).
2. **Commit on the appropriate branch.** `main` for VPS-internal doctrine, `~/ecodiaos/patterns/`, `~/ecodiaos/scripts/`, `~/ecodiaos/clients/`, `~/ecodiaos/drafts/` (yes, drafts get committed too — they are durable artefacts). Feature branch for code work on a target codebase.
3. **Stamp the commit with the fork id** so post-hoc reviewers can attribute the change to the right fork session. EcodiaOS convention: `Co-Authored-By: <fork_id>` trailer or fork id in the commit message body.
4. **Push if the fork's brief says push.** Many briefs say "do not push" — respect that. But "do not push" is NOT "do not commit." Local commits on the VPS are the durability layer; pushes are the publishing layer.
5. **Update status_board / Neo4j AFTER the commit lands**, with the commit SHA in the row context or node properties. If the commit fails (pre-commit hook rejects, etc.), the state-store update SHOULD reflect the failure, NOT pretend the commit succeeded.
6. **Commit IMMEDIATELY after Write/Edit, not at end-of-fork.** A fork that writes 5 files and saves all the commits to a single end-of-fork commit operation has a window in which sibling forks can wipe the working tree. Commit incrementally; consolidate via squash later if needed.

If a fork's brief explicitly forbids commit-to-main (rare; e.g. "stage only, leave for conductor review"), the fork still must NAME the staging surface in its report — "deliverable at /home/tate/ecodiaos/scripts/X, untracked, conductor must commit" — so the state stores correctly reflect the un-durable state.

## Why the conductor must enforce this

The conductor cannot rely on `[FORK_REPORT]` line alone — the fork's narration that it "shipped X" can be technically true (file on disk) while being durably wrong (file uncommitted). The conductor's verify pass at fork-completion MUST run the three-state probe above and reconcile state stores against actual git status. If state stores say "shipped" but `git log` is empty, that is a discrepancy worth surfacing — either as a status_board P2-P3 row "fork deliverables uncommitted, commit-pass needed" or as an immediate `git add + commit` from the conductor's own session.

## Do

- After every fork lands, run a 3-state verify probe: explicit-path `ls -la` + `git log -- <path>` to classify each deliverable as committed / on-disk-untracked / missing.
- When a fork's brief includes filesystem deliverables, write the brief to include "git add + git commit" as an explicit step in the success criteria, not an implicit assumption.
- When state stores narrate a fork as "shipped X at path Y" and the on-disk file is untracked, surface a status_board row to capture the gap and queue a commit-pass.
- Treat untracked working-tree state as a transient stage in a deliverable's lifecycle, NOT a final state. The final state is "committed and (optionally) pushed."
- Use explicit paths for verify probes. `ls -la "$path"` with a literal string. NEVER `ls ~/ecodiaos/drafts/cowork-*` — globs can fail to expand silently and produce false-negative phantom-ship narratives.
- When authoring a multi-file deliverable in a fork, commit incrementally — don't accumulate writes for a single end-of-fork commit. The accumulation window is when sibling-fork `git clean` can wipe the work.

## Do NOT

- Do not assume "the file is on disk" means "the file is durably shipped." Branch operations by sibling forks, clean-checkout from a recovery script, or `git clean -fd` can wipe untracked files in milliseconds. The 30 Apr 2026 originating event saw this happen mid-synthesis-turn.
- Do not treat the absence of a `[FORK_REPORT]` mention of git-commit as "they probably committed." Verify.
- Do not write Neo4j Decisions or status_board rows that assert "shipped" status for an untracked file without flagging the untracked status in the row context.
- Do not rely on glob-pattern `ls` for verify probes. The shell may not expand the glob in the harness's bash context, in which case the glob is passed literally to `ls` and the command fails with "no such file" even though the matching file is right there.
- Do not let untracked diagnostic artefacts (screenshots, draft markdowns, intermediate JSON) accumulate without commit or explicit cleanup. They drift into a "limbo" state where the conductor can no longer tell what's part of the active record vs what's leftover from a dead fork.
- Do not run `git clean` / `git checkout .` / `git reset --hard` against a working tree that may contain a sibling fork's untracked-but-active deliverables. If you must clean, stash first per `~/ecodiaos/patterns/stash-and-clean-when-finding-sibling-fork-unsafe-state.md`.

## Origin

30 April 2026, ~10:30-10:35 AEST, surfaced during the `fork_mokm4yba_a1c59a` Cowork buildout Wave 1 synthesis. Two distinct events in sequence:

**Event 1 (the verify-failure event):** the synthesis fork's initial verify probe used glob-pattern `ls` (`ls ~/ecodiaos/scripts/cowork-dispatch ~/ecodiaos/drafts/cowork-* ~/ecodiaos/drafts/claude-desktop-account-*`) which returned "no such file or directory" for the wildcard arguments — the shell did not expand the literal glob in the harness bash context, so `ls` got the literal string `cowork-*` as the path. The synthesis fork built a phantom-ship narrative on the bad result, wrote a P1 status_board row + Neo4j Episode + status_board updates + pattern-file cross-references all asserting the deliverables were missing-on-disk, and was about to commit the wrong narrative when a `git status --porcelain` revealed `??` (untracked) entries for the very files that the phantom-ship narrative said were missing. Explicit-path `ls -la` then confirmed all five deliverables (helper script, two screenshots, investigation draft, W2-A architecture spec, W2-D SSH bridge spec) were on disk, untracked.

**Event 2 (the destruction event, ~5 minutes later):** while the synthesis fork was authoring corrective doctrine + correcting state-store narration, a concurrent sibling fork ran `git clean -fd` (or equivalent) against the working tree. The synthesis fork's three brand-new pattern files (`cowork-no-focus-collision.md`, `sdk-forks-must-commit-deliverables-not-leave-untracked.md`, the modified `cowork-conductor-dispatch-protocol.md`) plus all five Wave 1+early-Wave-2 untracked deliverables (helper script, screenshots, investigation draft, W2-A spec, W2-D spec) were destroyed in real-time. CLAUDE.md edits survived because CLAUDE.md is gitignored. The synthesis fork's `git add` then failed with "did not match any files" — confirming the wipe. The fork re-authored everything and committed immediately as a single atomic operation.

The combined event is the canonical demonstration of why uncommitted-on-disk is a transient lifecycle stage, not a final state. The Wave 1 forks (moklpzze, moklqrut, moklri02) had completed their work, narrated it as shipped in state stores, but did not commit. ~2 hours later, a sibling fork's `git clean` destroyed everything. The state stores still narrated "shipped" until the synthesis fork's verify probe caught the mismatch. This pattern formalises the discipline.

## Cross-references

- `~/ecodiaos/patterns/verify-deployed-state-against-narrated-state.md` — the meta-rule. This file is the SDK-fork instance of that meta-rule. The meta-rule says "narration drifts from reality, probe both"; this rule says "the probe must distinguish three states, not two."
- `~/ecodiaos/patterns/factory-metadata-trust-filesystem.md` — the Factory-CLI sibling rule. SDK forks have the same failure mode but with different mechanics (no PR, no commit-or-revert default, just direct working-tree mutation).
- `~/ecodiaos/patterns/factory-approve-no-push-no-commit-sha.md` — the Factory analogue for the post-completion verify gap.
- `~/ecodiaos/patterns/factory-phantom-session-no-commit.md` — same Factory analogue, different angle.
- `~/ecodiaos/patterns/stash-and-clean-when-finding-sibling-fork-unsafe-state.md` — the sibling rule for the fork that finds untracked sibling work; explains why blanket `git add -A` is wrong AND why blanket `git clean` is wrong.
- `~/ecodiaos/patterns/distributed-state-seam-failures-are-the-core-infrastructure-risk.md` — the architectural meta-frame. State stores (Neo4j, status_board, kv_store) and the git tree are two of ~10 substrates EcodiaOS state lives in. Fork-shipped-but-uncommitted is exactly the seam-write inconsistency this rule catalogues.
- `~/ecodiaos/patterns/no-symbolic-logging-act-or-schedule.md` — uncommitted-but-narrated-as-shipped IS symbolic logging at the state-store layer.
- `~/ecodiaos/patterns/cowork-no-focus-collision.md` — the sibling pattern authored in the same synthesis turn as this one. The destruction event affected both equally.

Authored: 30 April 2026, fork_mokm4yba_a1c59a (Cowork buildout Wave 1 synthesis). Re-authored after the documented destruction event in Event 2 — itself the live demonstration of the doctrine.
