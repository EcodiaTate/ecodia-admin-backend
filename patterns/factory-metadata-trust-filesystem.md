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

## Related patterns
- `factory-codebase-staleness-check-before-dispatch.md` - prevention side (clean worktree before dispatch)
- `factory-phantom-session-no-commit.md` - when Factory reports work that produced no commit
- `factory-approve-no-push-no-commit-sha.md` - approve succeeds but no real commit shipped
