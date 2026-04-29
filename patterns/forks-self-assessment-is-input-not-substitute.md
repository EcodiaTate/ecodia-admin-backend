---
triggers: fork-self-report, fork-self-assessment, FORK_REPORT, fork-claims-shipped, fork-says-done, fork-output-trust, ground-truth-verification, fork-completion, post-fork-verify, did-the-fork-actually, polished-fork-output, fork-confidence, conductor-trust-fork, verify-fork-artefact, commit-sha-check, file-mtime-check, status-board-check, neo4j-node-check, fork-says-but, artefact-vs-claim, fork-summary-trust, fork-narrative
---

# A fork's self-assessment is input, not substitute, for ground-truth verification

A fork's `[FORK_REPORT]` and `[NEXT_STEP]` lines are the fork's own narrative of what it did. They are useful inputs to the conductor's decision-making but they are NOT a substitute for verifying the artefacts the fork claims to have produced. A fork can write a confident summary of work that did not actually land, just as a Factory session can write confident-looking diffs that miss the task. The conductor's job is to verify by artefact, not by narrative.

Polished fork output is not evidence of correctness. The same model that runs the fork runs the conductor; the fork's self-report has no privileged access to ground truth that the conductor lacks. Trusting the report is trusting the model's own confidence calibration, which is exactly the failure mode this rule corrects.

## Do

- DO read the fork's `[FORK_REPORT]` for context on what the fork attempted, blockers it hit, and decisions it made along the way.
- DO verify by artefact: commit SHA exists in `git log`, file mtime updated as expected, status_board row `last_touched` is recent, Neo4j node returns from a query, INDEX.md row landed, kv_store key is present.
- DO use the artefact-verification ladder: (1) git log shows the commit; (2) `git show <sha>` shows the diff matches the brief; (3) the diff is non-empty for any file the brief named; (4) any side effects (status_board updates, INDEX.md edits, Neo4j writes) are verifiable independently.
- DO mark fork outcomes in status_board / kv_store based on artefact evidence, not the fork's self-claim.
- DO NOTE if the fork report and the artefact disagree. That divergence is high-signal - either the fork's self-model is miscalibrated or the artefact path failed silently. Both are worth surfacing.
- DO trust the fork report when the artefact verification confirms it. Trust the report less when artefact verification surfaces nothing.

## Do NOT

- DO NOT mark a fork's work "shipped" based solely on the fork's `[FORK_REPORT]`. The report is the fork's claim; the commit is the proof.
- DO NOT treat the fork's confidence (well-structured summary, named files edited, neat outcome statements) as evidence of work done. Structure correlates with model training, not with target-system reality.
- DO NOT skip artefact verification because "the fork looked competent." The fork looking competent is the failure mode this rule corrects.
- DO NOT propagate the fork's self-claim into Neo4j Decisions, status_board updates, or Tate-facing summaries until the artefact has been independently verified. The conductor is the layer that converts fork narrative into durable durable assertions; that conversion requires verification.
- DO NOT batch-trust fork reports across multiple forks just because the first one verified. Each fork's claim verifies independently.
- DO NOT confuse "the fork ran without error" with "the fork did the work." Fork-runtime success is necessary but not sufficient.

## Protocol (verify-by-artefact)

For each fork that returns:

1. **Read the `[FORK_REPORT]`** and `[NEXT_STEP]` if present. Note: what files did the fork claim to edit, what side-effects did it claim, what does it say about partial completion or blockers.
2. **Match each claim to an artefact:**
   - File edits -> `git diff HEAD~1` or `git show <sha>` against the named files. The diff should be non-empty and topically aligned.
   - Commits pushed -> `git log origin/main` shows the SHA the fork named.
   - Status_board updates -> `SELECT * FROM status_board WHERE name = '<row>'` returns the expected status / next_action / last_touched.
   - Neo4j writes -> `MATCH (n) WHERE n.name = '<name>' RETURN n` returns the node.
   - kv_store writes -> `SELECT * FROM kv_store WHERE key = '<key>'` returns the row.
   - INDEX.md updates -> grep INDEX.md for the named file path.
3. **Reconcile divergences.** If the fork said it shipped X but the artefact does not exist, the conductor records the gap, does NOT propagate the false claim to Tate, and decides the next move (re-dispatch, manual fix, surface to Tate as a real blocker).
4. **Update durable assertions only after verification.** status_board, Neo4j, kv_store, Tate-facing summaries get the verified state - not the fork-claimed state.

## When verify-by-artefact is cheap

Most artefact checks are 1-2 tool calls. `git log -1 --format='%H %s'`, `ls -la <file>`, `db_query "SELECT ..."`. The verification cost is dwarfed by the cost of acting on a false claim. There is no exception for "the fork is reliable" or "this fork has been right the last 5 times" - the verification is the discipline that prevents the failure mode regardless of base rate.

## Anti-pattern (recurrent)

The failure shape: fork returns with a clean `[FORK_REPORT]` claiming "edited file X, status_board row updated, INDEX.md current, ready for review." Conductor reads the report, marks the work done, surfaces a summary to Tate. Hours later Tate asks "is the change actually in?" and a `git log` reveals nothing was committed - the fork's runtime had a silent failure mode, or the fork edited a stale worktree, or the fork's claim was hallucinated.

The verification window between fork-return and Tate-asks-about-it is the failure window. Closing it requires the conductor to verify-by-artefact at fork-return time, not at Tate-asks time.

## Origin

This pattern has been referenced repeatedly in CLAUDE.md and in other pattern files (`macros-must-be-validated-by-real-run-before-codification.md` and `use-anthropic-existing-tools-before-building-parallel-infrastructure.md` both list it as a sibling cross-reference) but never authored as a standalone file. The cross-references resolved to a path that did not exist - which itself is the same failure mode at the doctrine layer (claim of doctrine vs the doctrine actually being there).

The substantive trigger is the recurring drift Tate has flagged: forks that return with confident summaries of work that did not land. Each instance the fork's self-narrative was more polished than the last, which made the failure harder to spot at a glance and easier to mistake for completion. The corrective is the conductor's discipline of verify-by-artefact at fork-return, not at later-discovery.

29 Apr 2026 evening: this file was authored as part of the P1 gap-audit landing window after the audit flagged S1 (two pattern files referenced but not present). The cross-references in `use-anthropic-existing-tools-before-building-parallel-infrastructure.md` and `macros-must-be-validated-by-real-run-before-codification.md` now resolve.

## Cross-references

- `~/ecodiaos/patterns/macros-must-be-validated-by-real-run-before-codification.md` - sibling at the macro level. Same anti-pattern: structure-of-output is not evidence of correctness; only ground-truth replay is. That file enforces validation at the macro level; this file enforces it at the fork-return level.
- `~/ecodiaos/patterns/use-anthropic-existing-tools-before-building-parallel-infrastructure.md` - same root failure mode at the design level. Polished parallel infrastructure is not evidence of solving the problem; verify whether Anthropic's primitive already does it.
- `~/ecodiaos/patterns/codify-at-the-moment-a-rule-is-stated-not-after.md` - same root at the doctrine layer. Saying the rule is not the same as writing the file; the verification is whether the file landed.
- `~/ecodiaos/patterns/factory-metadata-trust-filesystem.md` - sibling at the Factory-session level. Factory's metadata (filesChanged, taskDiffAlignment) is also a self-report; the conductor verifies via filesystem, not via metadata.
- `~/ecodiaos/patterns/verify-empirically-not-by-log-tail.md` - same root at the infrastructure level. Logs are claims; running-process state is ground truth.
- `~/ecodiaos/patterns/verify-before-asserting-in-durable-memory.md` - same root at the Neo4j level. Asserting "X is true" without ground-truth verification is the failure mode.
- `~/ecodiaos/patterns/no-symbolic-logging-act-or-schedule.md` - parent doctrine. "The fork said it did the work, so I'll mark it done" is symbolic logging dressed as efficiency.
