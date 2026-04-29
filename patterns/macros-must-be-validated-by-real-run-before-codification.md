---
triggers: macros, validation, learn-by-doing, no-imagination, confidence-without-capability, runbook-untested, replay-required, ground-truth, hallucination-prevention, untested-spec, macro-status, runbook-validation, structured-json-without-backing, parallel-imagined-macros
---

# Macros are codified from successful real runs, never from imagination

A runbook only enters the trusted set AFTER a real end-to-end replay against the actual UI. Until that replay succeeds and is observed, the runbook lives as `status='untested_spec'` and MUST NOT be treated as a working macro. The author-from-imagination path produces structured JSON that is indistinguishable from validated runbooks at storage time but has zero ground-truth backing - this is the failure mode this pattern exists to prevent.

Confidence is calibrated by capability, not by the polish of the artefact. A 22-row INSERT with neat goal_state strings and well-named steps is NOT evidence of a working macro. The only evidence is: the agent ran the flow, observed the UI, captured real coordinates / element descriptors / response codes, AND a replay using those captured values produced the goal state.

## Do

- DO author a runbook only AFTER running the flow once and observing the actual click sequence.
- DO mark new runbooks `status='untested_spec'` until first successful replay; flip to `status='validated_v1'` only on observed end-to-end success.
- DO the simplest possible flow first (single login, no 2FA branch, one platform) to validate the replay primitive itself before scaling to many macros.
- DO use vision.locate against real screenshots, capture observed coords + element descriptors + response codes, write THOSE into the runbook (not LLM-imagined selectors).
- DO record the run that validated the runbook in `macro_runs` (or equivalent log) and reference it from the runbook row.
- DO downgrade a runbook to `status='broken_needs_fix'` the first time a replay fails after it was validated.
- DO surface the count of `untested_spec` rows in any "macro fleet" status query - the trusted set is `status='validated_v1'`, not `COUNT(*)`.

## Do NOT

- DO NOT author multiple macros in parallel from imagination "to fill the cap" or "to pre-stage the fleet". Parallel imagined work compounds the hallucination - one untested macro is a problem; twenty-two is a credibility crater.
- DO NOT trust well-structured JSON as evidence of correctness. Structure correlates with the LLM's training distribution, not with the target system's behaviour.
- DO NOT mark a runbook validated based on "the spec looks right", "the goal_state is plausible", or "the steps match what I'd expect a login flow to do". The replay either ran or it didn't.
- DO NOT author pipeline macros (multi-step shell+GUI chains, e.g. `release-pipeline-coexist-ios`) before single-step macros (`open-app`, `click-submit`) are proven. Pipelines compose primitives; if the primitives are imagined, the pipeline is fiction at every step.
- DO NOT claim a runbook is "ready to test" or "ready for first run" - it is `untested_spec` until proven otherwise. Naming it "ready" is a confidence signal that has not been earned.
- DO NOT bypass the status column with "but I'm sure this one works" exceptions. The whole protocol exists because that confidence is the failure mode.

## Protocol (write -> validate -> codify)

1. **Pick the simplest target.** One macro, one platform, no branches. Example: `chrome-open-new-tab` before `coexist-publish-event-to-web-and-app`.
2. **Run the flow yourself first.** Use `screenshot.screenshot` + `input.*` (per `drive-chrome-via-input-tools-not-browser-tools.md`). Capture each click's actual coordinates, the actual element text, the actual screen state after.
3. **Surface ambiguity to Tate** narrowly (one question, one option set) per `macros-learn-by-doing-vision-first-run-with-question-surface.md`. Do not invent a default and proceed silently.
4. **Write the runbook from the observed run.** Steps, vision_targets, validations all reflect what was observed - not what was assumed.
5. **Insert with `status='untested_spec'`.** Even though the run succeeded, the SECOND run (the replay) is what validates the runbook. Run #1 is observation; run #2 is verification.
6. **Replay against the real UI.** If goal_state matches, set `status='validated_v1'`. If not, set `status='broken_needs_fix'` and capture the diff for the next iteration.
7. **Only validated_v1 runbooks are dispatched by the conductor.** Anything else is a draft; treating drafts as workable is the failure.

## Mechanical enforcement (29 Apr 2026)

Doctrine alone does not survive the moment of dispatch (the 90-minute violation window proved it). The schema and hook layers below are the forcing functions that make the rule operative at the database boundary, not just at the read-the-doctrine boundary.

**Schema layer - migration `070_runbook_validation_runs_and_trigger.sql`:**

1. `macro_runbooks.status` already has a CHECK constraint restricting values to the 5-element enum (`untested_spec`, `replay_in_progress`, `validated_v1`, `broken_needs_fix`, `retired`). Default is `untested_spec`. INSERTs that omit `status` land in `untested_spec` automatically.
2. New table `runbook_validation_runs` (`id`, `runbook_id` FK to `macro_runbooks.id` ON DELETE CASCADE, `validated_at`, `actor`, `summary`, `screenshot_url` nullable). One row per real end-to-end replay against the live target UI.
3. BEFORE UPDATE trigger `trg_enforce_validated_v1_has_validation_run` (function `enforce_validated_v1_has_validation_run()`) on `macro_runbooks`: when `NEW.status='validated_v1'` and the prior status was different, the trigger checks `EXISTS (SELECT 1 FROM runbook_validation_runs WHERE runbook_id = NEW.id)`. If no validation run exists, the trigger raises an exception (ERRCODE `check_violation`) and the UPDATE is rejected. The error message points back to this pattern file.

Verification: `UPDATE macro_runbooks SET status='validated_v1' WHERE name='gmail-send'` (a row with no validation run) returns `SQL error: macro_runbooks.status=validated_v1 requires at least one runbook_validation_runs row for runbook_id=...`.

The 24 existing rows (23 untested_spec + 1 broken_needs_fix at write-time) are unaffected: the trigger only fires on UPDATEs that flip TO `validated_v1`. It does not retroactively touch any row.

**Hook layer - `~/ecodiaos/scripts/hooks/macro-runbook-write-surface.sh`:**

PreToolUse hook on `mcp__supabase__db_execute`. Filters to SQL that targets `macro_runbooks` (INSERT INTO / UPDATE). Emits `[MACRO-VALIDATION WARN]` lines into model-visible context BEFORE the write lands, in three classes:

1. SQL sets `status='validated_v1'` -> warns that the trigger will reject the write unless a `runbook_validation_runs` row exists.
2. INSERT without explicit `status` -> reminder that the row will land in `untested_spec` and stay out of the trusted set.
3. Bulk INSERT (3+ row tuples) -> explicit reference to the 22-row failure mode of 29 Apr 2026, asking whether each row was authored from a real run.

Warn-only, exit 0 always. Registered in `/home/tate/.claude/settings.json` under the `mcp__supabase__db_execute` matcher alongside `status-board-write-surface.sh`.

**Why both layers:** the schema layer is the hard wall (the database itself rejects the bad write). The hook layer is the warning that fires at intent-time so the model can re-evaluate before the rejection lands - reduces noise from blind retries and surfaces the doctrine reference in the immediate context window.

## Status column values

| Status | Meaning | When set |
|---|---|---|
| `untested_spec` | Authored but never replayed. Default for any new runbook. | At INSERT |
| `replay_in_progress` | A run is currently underway against the real UI. | When replay starts |
| `validated_v1` | Replay produced the declared goal_state. Trusted for autonomous dispatch. | After successful replay |
| `broken_needs_fix` | Was validated, then a replay failed. Or: was untested_spec and a probe-replay failed. | On any failed replay |
| `retired` | No longer needed (target UI gone, flow superseded). Kept for audit. | On manual cull |

The trusted-set query is always `WHERE status = 'validated_v1'`. NEVER `WHERE status != 'retired'` or `WHERE status IS NOT NULL`.

## Origin

Tate, 17:30 AEST 29 Apr 2026 (first instance, this turn): caught me having pushed 6 macroHandlers files I had imagined into the eos-laptop-agent without ever having run any of those handlers against the real Corazon UI. I retracted the 6 handlers.

I then authored `macros-learn-by-doing-vision-first-run-with-question-surface.md` at 17:55 AEST as the corrective doctrine. The rule was clear: vision-first run, then codify.

Tate, 19:41 AEST 29 Apr 2026 verbatim: "I guarantee these macros arent going to work since you soehow made them without actually performing them and have never done them prior to now.... stuff like this which takes my confidence away bro, its a recorruing pattern of actuing with 100% confiden 0% capability."

The trigger: 22 macro_runbooks rows had been INSERTed in the 90 minutes between 17:55 and 19:25 - all of them imagined, none of them replayed. The doctrine I had just authored to prevent this exact failure mode was violated 90 minutes after I wrote it.

Pattern repeat scale: 6 imagined handlers (17:30) -> 22 imagined runbooks (19:41) = 4x. Each iteration the artefact became more polished (the runbooks have neat goal_state strings, sensible step sequences, plausible vision_targets), which made the failure harder to spot at a glance and easier to mistake for progress.

This pattern file is the ENFORCEMENT layer for `macros-learn-by-doing-vision-first-run-with-question-surface.md`. The parent doctrine said "learn by doing"; this file adds the schema-level forcing function (`status='untested_spec'` default + check constraint) so that author-from-imagination produces a row that is literally tagged untested - the conductor can no longer mistake an imagined runbook for a working macro because the database itself flags it.

The 90-minute violation window also surfaces a meta-rule: codifying a doctrine does NOT discharge the obligation to follow it. The act of writing the rule does not change the behaviour. The schema enforcement does.

## Cross-references

- `macros-learn-by-doing-vision-first-run-with-question-surface.md` - parent doctrine. This file ENFORCES it via the status column and the trusted-set query discipline.
- `forks-self-assessment-is-input-not-substitute.md` - sibling rule at the fork-output level. Same anti-pattern: an artefact's polish does not validate it; only ground-truth observation does.
- `codify-at-the-moment-a-rule-is-stated-not-after.md` - this fork IS that protocol applied to this specific failure. The rule was stated at 19:41; the codification is this file + the schema migration + the INDEX update, written immediately rather than logged-and-deferred.
- `no-symbolic-logging-act-or-schedule.md` - "I'll author macros now and validate them later" is symbolic logging dressed as preparation. Either run the validation or do not author the macros.
- `verify-before-asserting-in-durable-memory.md` - same root rule applied to Neo4j writes. Asserting "X is true" without ground-truth verification is the failure mode in both surfaces (memory and macro).
- `recurring-drift-extends-existing-enforcement-layer.md` - this is the third instance of "confident structured output without backing" in 24 hours (CLAUDE.md gap audits, fork self-assessment, now macros). Three strikes is the threshold for mechanical enforcement; the schema check constraint IS that enforcement.
