---
triggers: doctrine, neo4j, synthesis, learning, evolution, pattern-corpus, self-evolution, weekly-synthesis, accumulated, logged, episode-mining, consolidation, log-and-forget, reflexive, doctrine-rot, pattern-mining, decision-mining, weekly-cadence, strategic-thinking
---

# Doctrine corpus is for evolution, not archive - weekly synthesis cadence

## TOP-LINE INVARIANT

**Logging a pattern, decision, or episode without periodically re-reading and synthesising it is the same failure as not logging it.** The "logged-but-not-reflexive doctrine is functionally unlogged" pattern (Apr 28 2026) names the symptom in a single instance; this pattern names the systemic remedy.

The doctrine corpus (`~/ecodiaos/patterns/`, Neo4j Patterns/Decisions/Episodes/Strategic_Directions, status_board, scheduler) is the load-bearing self that survives substrate swaps. If it accumulates without being reread and acted on, it becomes archive instead of substrate. Doctrine rot is the failure.

## The rule

**Weekly synthesis pass, action-output mandatory.**

Cadence: every Monday morning AEST (or first session of any new ISO week if Monday is missed).

Inputs:
1. Neo4j Episodes from the last 7 days: `MATCH (e:Episode) WHERE coalesce(e.created_at, datetime()) > datetime() - duration('P7D') RETURN e.name, e.description ORDER BY e.created_at DESC`.
2. Neo4j Decisions from the last 7 days: same query with `:Decision`.
3. Neo4j Patterns added or modified in the last 7 days.
4. status_board rows that closed (archived_at set) in the last 7 days - mine the close-context for lessons.
5. Factory rejections + rejection reasons from the last 7 days - cc_sessions where pipeline_stage='failed' or status='rejected'.
6. Fork [FORK_REPORT]s from the last 7 days that surfaced something unexpected.

Pass:
1. Read the inputs in full. Don't skim.
2. Identify cross-cutting themes - the same root cause showing up in 2+ separate Episodes / Decisions / failures is a candidate Pattern.
3. Identify pattern-violations - cases where I logged a doctrine and then violated it. These trigger the "second-strike formatting protocol" (top-line invariant + expand triggers + addendum on the existing pattern - do NOT create a new file).
4. Identify dormant doctrine - Patterns referenced in <2 Episodes/Decisions over the last 30 days. These either need to be retired (no longer relevant) or hoisted (not surfacing when they should).

Mandatory action output (one or more of):
- New Pattern file in `~/ecodiaos/patterns/` with full triggers/origin/protocol structure.
- Edits to an existing Pattern file (top-line invariant hoist, triggers expansion, addendum).
- Status_board row that operationalises an insight (e.g. "Tighten ordit invoicing cadence to weekly per Episode 3340 + Episode 3338 cluster").
- Scheduled task created or modified to enforce a doctrine-implied cadence.
- Pattern file retired (moved to `patterns/_retired/` with a note linking to its successor or to the Episode that supersedes it).

If a synthesis pass produces no action output, the pass failed. Try again with deeper reading. "Reflection without output" is the anti-pattern this pattern exists to prevent.

## Do

- Run the synthesis pass weekly even if "nothing big happened" - the value is in noticing patterns I missed in the moment.
- Keep the synthesis pass on a fork (`spawn_fork` with full brief) whenever possible - it consumes deep tokens and benefits from a clean conversation tail. The fork's [FORK_REPORT] back to me is the synthesis summary; the durable artefacts (Pattern files, status_board rows) are written by the fork directly.
- Treat the synthesis pass as the highest-leverage proactive work I can do when nothing else is screaming. It compounds: every synthesis makes the next session a better operator.
- Write the synthesis Episode to Neo4j with `:Episode {synthesis_pass: true, week: 'YYYY-WNN'}` so the meta-cadence is queryable.

## Do not

- Do not skip a week because "the corpus is fine." Doctrine rot is invisible at the weekly scale; only visible at the monthly scale, by which time it's already cost real failures.
- Do not treat the synthesis pass as a status-report exercise. It must produce durable artefacts (Pattern edits, status_board rows, schedule changes), not summaries.
- Do not write summary-only Episodes that don't link back to specific source Episodes/Decisions. A synthesis Episode should reference at least 3 source nodes.

## Origin

2026-04-28 12:39 AEST. Tate: "I think we also need to be doing a lot more learning and actual evolution based on the consolidated and logged stuff in neo. you're doing well, but theres still so many patterns to synthesise and learn from and act on consistently."

A Decision node already existed - `Doctrine corpus is the self - weekly positive-synthesis pattern-authoring cadence` - prescribing this cadence. But no scheduled task carried it, no fork ever ran the pass, and the Decision was effectively a stranded intention. This pattern operationalises the Decision.

The deeper symptom Tate's pointing at: I keep adding patterns (the corpus grows) without re-reading them (the corpus doesn't surface). This pattern says: build a forced re-reading rhythm, with mandatory action output, on a weekly schedule.

## Cross-references

- `Doctrine corpus is the self - weekly positive-synthesis pattern-authoring cadence` (Neo4j Decision node) - the original commitment this pattern operationalises.
- `Logged-but-not-reflexive doctrine is functionally unlogged - second-strike formatting protocol` (Neo4j Pattern node) - the per-instance version of the same root failure.
- `Conductor coordinates - capacity is a floor, not a ceiling` - synthesis passes ARE conductor work; they are exactly what the freed-up main-thread attention should be spent on.
- `os_scheduled_tasks` row for the `weekly-doctrine-synthesis` cron (created 2026-04-28).
