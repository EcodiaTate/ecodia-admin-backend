triggers: factory,filesChanged,taskDiffAlignment,review_factory_session,approve_factory_deploy,force,stale-worktree,factory-metadata

# Factory metadata can lie - verify on disk before approve

## Rule
The `filesChanged` field returned by `review_factory_session` is NOT a reliable reflection of what the session produced. It can include stale artefacts from uncommitted worktree state that predates the session. The `taskDiffAlignment.flagged` signal is computed against that polluted list and therefore inherits the pollution - it can flag a clean diff as off-task.

**Before `approve_factory_deploy` on any session where (a) `filesChanged` contains paths outside the spec, OR (b) `taskDiffAlignment.flagged === true`:**

1. Read the actual diff body returned by `review_factory_session` - is it clean?
2. cd to the repo and verify the expected output paths exist on disk with the expected content (`ls`, `find`, parse the file if it's structured).
3. If the real artefacts match spec, approve with `force=true` and record the metadata discrepancy in the `notes` field.

## Do NOT
- Do not reject a session purely on `filesChanged` or `taskDiffAlignment` signals. Reject only when the actual diff or on-disk state is wrong.
- Do not approve blindly just because `force=true` is available - always verify filesystem first.
- Do not assume a single session produces exactly one atomic diff. Concurrent or back-to-back sessions on the same codebase contaminate each other's metadata (see `factory-codebase-staleness-check-before-dispatch.md`).

## Protocol (checklist)
- [ ] Read `review_factory_session` output in full
- [ ] If `filesChanged` contains unexpected paths: note them, they are likely worktree pollution
- [ ] If `taskDiffAlignment.flagged`: read the `reason` and `matchedKeywords` - if the mismatch is purely because polluted filenames have different keywords from the task, it's a false positive
- [ ] Verify expected output files exist on disk with correct content (`ls -la path/`, `cat` or parse them)
- [ ] If verified-clean: `approve_factory_deploy(sessionId, force: true, notes: "metadata discrepancy explained + what was actually verified")`
- [ ] If verified-dirty (real scope creep or wrong content): `reject_factory_session(sessionId, reason)`

## Origin
Apr 23 2026, Ordit PR acceptance tooling session.
- Session `a02c83bb-ea55-4747-a161-c1dc66dff389` (scope-check script): `filesChanged` reported `["clients/ordit/REVIEWER_PERSONA_PROMPT.md"]` only, `taskDiffAlignment.flagged=true` at 8% overlap. Actual diff cleanly added `package.json` minimatch dep and `tools/scope-check.js` matching spec exactly. Approved with `force=true`, deployed as commit `ecf1c01`.
- Session `f94a86e9-3f6d-4954-ae08-ef8b6667f5c3` (semgrep rulepack): `filesChanged` reported the correct 10 files PLUS the same stale `REVIEWER_PERSONA_PROMPT.md`. Verified on-disk that `.semgrep/ordit/` contained README.md + ruleset.yml + 8 rule files, all valid YAML, each rule file with exactly one rule. Approved normally.

The stale file (`REVIEWER_PERSONA_PROMPT.md`) was committed in `e99b410` BEFORE either session was dispatched, so it shouldn't have appeared in either session's `filesChanged` at all. Whatever Factory uses to compute that list pulled in a stale reference.

## Addendum - concurrent-Factory commit bundling

Both sessions were dispatched in parallel against `ecodiaos-backend` (despite the "never dispatch parallel on same codebase" rule - my mistake). This produced a second downstream anomaly:

- Scope-check session committed itself cleanly at `25246cf` (package.json + tools/scope-check.js) BEFORE I called `approve_factory_deploy`.
- When I then called `approve_factory_deploy(a02c83bb)`, it created a SECOND commit `ecf1c01` that snapshot-committed the full worktree state - which by then contained the semgrep session's 10 files + REVIEWER_PERSONA_PROMPT.md. So the scope-check approve accidentally bundled the semgrep rulepack.
- The subsequent `approve_factory_deploy(f94a86e9)` returned `{success: true}` with no `commitSha` because there was nothing new to commit.

Lesson: when you realise mid-session that you dispatched two Factory jobs in parallel on the same codebase, expect the first approve to snowball everything uncommitted. Check `git log -p` on the snowball commit to confirm nothing unintended shipped. Do NOT trust the approve response alone - cross-check what actually landed in the commit.

## Addendum 2 - operator-authored ambient state also triggers snowball

Apr 27 2026. Factory session `aeaf1cfa-fb36-4e22-be3c-7d17c1a91edc` (kg-embed `*Run` filter + Reflection.content + listener registry dispatch fix). NO parallel Factory session was running, but the worktree had ambient untracked work I had authored myself before dispatch (5 new pattern files, drafts/yarn-and-yield/* deck materials, public/docs/quorum-of-one-003 edits, clients/macincloud-access.md, dao/dao-uups-migration-spec.md, drafts/quorum-of-one-004-draft.html, drafts/roam-iap-audit-2026-04-27.md). The session itself committed cleanly to a topic branch as `5a47b03` with exactly the three intended src/ changes. When I called `approve_factory_deploy(force=true)` the deployment service:

1. Bundled all that ambient untracked state into a SECOND commit `cca296e8` on top of the session commit, with the Factory's task message as the commit message (so the commit message claimed it was the kg-embed fix when really it was 18 files of unrelated work).
2. Failed during push or restart and returned HTTP 500.

Recovery required manually: ff main from origin, ff main to topic branch HEAD, `git commit --amend` the snowball commit with an accurate message before push, then push and verify PM2 picked up the new code.

**Generalised lesson:** the snowball trigger is ANY uncommitted state in the worktree at approve time - parallel Factory sessions, operator-authored drafts, my own pattern-file authoring. Either (a) commit your ambient work to a separate branch BEFORE calling approve_factory_deploy, or (b) be ready to amend the resulting commit message and split via revert+commit if the bundled scope is unacceptable. The approve API does not separate "session output" from "everything else dirty in the worktree" - it commits ALL of it under the session's task message.

**Prevention checklist before calling approve_factory_deploy on ecodiaos-backend:**
- [ ] `git status -sb` - any modified or untracked files I authored?
- [ ] If yes and they are unrelated to the session: commit them on a separate branch first, OR accept the snowball and plan to amend message + split via revert+commit on the next push.
- [ ] If yes and they are session-related leakage: investigate before approving.

## Addendum 3 - the metric being improved flags its own improvement

Apr 27 2026, 23:30 AEST. Factory session `d67c00f5-52ca-45d6-b9be-25e43f5d58ad` fixed three bugs in `src/services/taskDiffAlignment.js` itself - the very gate that produces the `flagged` signal. Bugs were:
1. keyword-extraction regex required min 4 chars while extractPathTokens accepted length>=3, silent asymmetry stripping 3-char acronyms (iap, sms, dao).
2. bidirectional substring match (`t.includes(kw) || kw.includes(t)`) let short path tokens match keywords containing them ("set" in "dataset" matching "settings"), inflating phantom scores.
3. STOPWORDS contained domain-meaningful words (`service`, `services`, `method`, `handler`, `helper`, `pattern`, `patterns`, `doctrine`), silently dropping real signal.

Diff cleanly modified exactly the two prescribed files (`src/services/taskDiffAlignment.js` + `tests/taskDiffAlignment.test.js`) plus 4 new regression tests. All 7 tests passed via the prescribed verification command. Pre-dispatch hygiene commit `7c5744a` had already isolated 20 files of ambient work from the worktree, so no snowball risk.

When I called `approve_factory_deploy` without `force`, it rejected with `Task-diff mismatch: Low keyword overlap (8%)`. The irony is structural: the prompt was a long, explanatory bug-description (~700 words of "the regex strips X while paths keep Y, and STOPWORDS dropping service means..."). Under the stricter post-fix matching the PR introduces, that long narrative prompt scores low against terse filenames like `taskDiffAlignment.js`. **The metric this PR is improving flags its own improvement.**

Approved with `force=true`, deployed as commit `adc42da`. No worktree pollution, no parallel session, no operator-authored leakage - this addendum is the third distinct mechanism producing a false-positive `flagged` signal:

- Addendum 1 (Apr 23): stale `filesChanged` from polluted worktree pre-existing the session.
- Addendum 2 (Apr 27 morning): operator ambient untracked state snowballed at approve time.
- **Addendum 3 (Apr 27 night): long, explanatory prompts inherently score low under stricter matching - especially when fixing the matcher itself.**

The doctrine holds: `flagged` is advisory, filesystem-truth is authoritative. Verify on disk, force-approve when verified clean, record the mechanism in `notes`.

## Related patterns
- `factory-codebase-staleness-check-before-dispatch.md` - prevention side (clean worktree before dispatch)
- `factory-phantom-session-no-commit.md` - when Factory reports work that produced no commit
- `factory-approve-no-push-no-commit-sha.md` - approve succeeds but no real commit shipped
- `factory-reject-nukes-untracked-files.md` - the worktree-clean side of pre-dispatch hygiene
