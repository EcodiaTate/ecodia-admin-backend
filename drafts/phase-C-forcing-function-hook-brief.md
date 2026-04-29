# Phase C — Applied-Pattern-Tag Forcing Function (Layer 3 of 7)

**Source-of-truth:** `~/ecodiaos/patterns/decision-quality-self-optimization-architecture.md` (Layer 3 spec, lines 64-72). This brief is dispatch-ready.

**Phase position:** Layer 3. Closes the loop between Layer 1 (surfacing) and Layer 5 (outcome classification). Without Phase C, the conductor reads warns and can ignore them silently — no record of the choice — and Phase D's classifier has no signal for "did the agent apply this pattern or not."

**Goal:** Make ignoring a surfaced pattern explicit, not silent. Every dispatch that received `[CONTEXT-SURFACE WARN]` lines must produce an audit tag the conductor wrote: `[APPLIED] <pattern_path> because <reason>` OR `[NOT-APPLIED] <pattern_path> because <reason>`. The forcing function is warn-only (consistent with hook discipline) but the warn shows the unacknowledged path so the conductor sees what they ignored.

---

## Tasks

### Task 1: Schema — `application_event` already exists, document the shape

Phase B already created `application_event` (`pattern_path`, `dispatch_event_id`, `ts`, optional `reason`, `applied bool`). This phase only WRITES to it. Confirm columns include:
- `applied` boolean (true = applied, false = explicitly not-applied)
- `reason` text (the conductor's stated justification)
- `tagged_silent` boolean default false (true if the conductor never tagged at all and the post-action hook backfilled)

If columns missing, ADD via migration. The Phase B fork shipped the table; Phase C may need to extend it. Re-check `db_describe_table application_event` first.

### Task 2: Post-action hook

Author `~/ecodiaos/scripts/hooks/post-action-applied-tag-check.sh` as a `PostToolUse` hook (not `PreToolUse`). Triggers on the same dispatch surfaces as Phase B's hooks (`mcp__forks__spawn_fork`, `mcp__factory__start_cc_session`, post-tool-call resolution).

Logic:
1. Read tool result on stdin (`tool_response` field).
2. Look up the most recent `dispatch_event` (within 5 seconds) for this tool_name.
3. Find all `surface_event` rows for that dispatch.
4. For each surface, check whether the tool result text contains `[APPLIED] <pattern_path>` OR `[NOT-APPLIED] <pattern_path>` for that pattern.
5. If neither tag is present for a surfaced pattern, emit `[FORCING WARN] dispatch surfaced <pattern_path> but neither [APPLIED] nor [NOT-APPLIED] tag found in result. Tag explicitly next time. See ~/ecodiaos/patterns/decision-quality-self-optimization-architecture.md Layer 3.`
6. Write one `application_event` row per surface: applied=true OR false (based on tag), or tagged_silent=true (no tag found).
7. Always exit 0. Warn-only.

### Task 3: Conductor protocol update

Patch `~/ecodiaos/CLAUDE.md` and `~/CLAUDE.md` "Pattern Surfacing" sections to document the new tag protocol. The conductor must end any dispatch that received `[CONTEXT-SURFACE WARN]` with one of:

- `[APPLIED] <full path> because <one-sentence reason>`
- `[NOT-APPLIED] <full path> because <one-sentence reason>`

per surfaced pattern. The forcing function fires post-action; tags can be either in the model's reply text OR in the fork's brief itself (the brief saying "applying X because Y" is sufficient).

### Task 4: Layer 3 observability

Extend `decisionQualityService.js` with a `tagDistribution` panel:
- Per pattern: applied / not_applied / silent counts over the window.
- Per pattern: silent_rate = silent / (applied + not_applied + silent).

Expose via `GET /api/telemetry/decision-quality?days=7` as a 5th panel `tag_distribution`.

### Task 5: Layer 3 drift detection

Extend `computeDriftSignals()`:
- `pattern_silent_majority`: any pattern with silent_rate > 50% over rolling 7d.
- Action: surface as P3, owner reviews — either tighten the trigger (over-firing) OR escalate the hook's loudness (the conductor is genuinely ignoring relevant doctrine).

---

## Hard constraints

- **Hot-path latency:** post-action hook fires AFTER the tool resolves. Latency budget is generous (>100ms acceptable). Still prefer JSONL append + batch insert over direct Postgres write.
- **Backward-compatible:** the application_event table already exists from Phase B (or this phase adds columns). Existing surface_event rows without companion application_event rows are treated as silent_rate contributors after Phase C lands.
- **No model breakage:** the forcing function is warn-only. The model can ignore a forcing warn the same way it can ignore a Pre-warn. Phase C just makes the ignoring observable.
- **Internal-only:** doctrine corpus only.

---

## What counts as done

- `application_event` schema confirmed/extended with applied + reason + tagged_silent.
- `post-action-applied-tag-check.sh` exists, fires on PostToolUse, writes JSONL + warns appropriately.
- `dispatchEventConsumer.js` extended (or new sibling consumer authored) to drain application_event JSONL.
- `decisionQualityService.tagDistribution()` shipped, returned by /api/telemetry/decision-quality.
- `computeDriftSignals()` returns `pattern_silent_majority` flags.
- CLAUDE.md updated with the [APPLIED]/[NOT-APPLIED] tag protocol.
- Verification: synthetic dispatch with known surface; check tag-or-no-tag both produce correct application_event rows.
- Architecture file's phasing table updated: "C SHIPPED".

---

## Cross-references

- `~/ecodiaos/patterns/decision-quality-self-optimization-architecture.md` (Layer 3 spec)
- `~/ecodiaos/patterns/context-surfacing-must-be-reliable-and-selective.md` (Layer 1 parent)
- `~/ecodiaos/patterns/no-symbolic-logging-act-or-schedule.md` (the discipline that justifies forcing tags — the conductor saying "I considered it" without an artefact is symbolic)
- `~/ecodiaos/scripts/hooks/lib/emit-telemetry.sh` (telemetry contract)
- `~/ecodiaos/src/services/telemetry/decisionQualityService.js` (extend with tagDistribution)
- Phase A is parallelisable with Phase C (both modify the same hook scripts dir; coordinate on file).
- Phase D depends on Phase C (classification needs application_event signal).

---

## Origin

Pre-staged 29 Apr 2026 by fork_mojpf9sm_0f7cef. Original briefing intent from fork_mojnrqs8_48ed64.
