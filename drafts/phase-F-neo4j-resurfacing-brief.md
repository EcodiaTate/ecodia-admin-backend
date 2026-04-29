# Phase F — Neo4j Episode/Decision Semantic Resurfacing (Layer 7 of 7)

**Source-of-truth:** `~/ecodiaos/patterns/decision-quality-self-optimization-architecture.md` (Layer 7 spec, lines 110-118). This brief is dispatch-ready.

**Phase position:** Layer 7, last. Schedule AFTER Phases A/C/D/E ship and stabilise. Most invasive: adds a new retrieval channel to the dispatch hot path.

**Goal:** Patterns codify rules; Episodes record events. Some lessons live ONLY in Episode/Decision nodes (e.g. "two weeks ago we tried X, it failed at step 4 because of Y"). Layer 1 grep-on-triggers cannot find these because Episodes don't have triggers. Phase F supplies the missing memory channel: at dispatch time, semantically-search Neo4j Pattern + Decision + Episode nodes for content matching the action surface; surface top-k institutional-memory hits inline with the brief-consistency hook output.

---

## Tasks

### Task 1: Episode-search hook

Extend `~/ecodiaos/scripts/hooks/brief-consistency-check.sh` with a new Check 7 (or sibling hook `~/ecodiaos/scripts/hooks/episode-resurface.sh`) that, after the existing trigger-keyword grep:

1. Extracts the brief's "goal sentence" (first non-empty `**Goal:**` line OR first 200 chars of brief).
2. Calls `mcp__neo4j__graph_semantic_search` (NOT `graph_search`) against node labels `Episode`, `Decision`, `Pattern`, `Strategic_Direction` with the goal sentence.
3. Top-K hits (K=3 by default) where similarity > 0.75 get surfaced as `[EPISODE-RESURFACE INFO] last time we did something shaped like this: <node.name> (<node.date>) — <node.description first 200 chars>. See <neo4j-id-or-direct-link>`.
4. Cap at K=3 to avoid flood.

Performance budget: each semantic_search call is ~50-200ms. Hook is willing to pay this on dispatch (vs hot tool call). If timeout > 500ms, skip the resurface and continue.

### Task 2: `episode_resurface_event` table

Migration:
```sql
CREATE TABLE episode_resurface_event (
  id BIGSERIAL PRIMARY KEY,
  dispatch_event_id BIGINT REFERENCES dispatch_event(id),
  ts TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resurfaced_node_id TEXT NOT NULL,
  resurfaced_node_label TEXT,
  resurfaced_node_name TEXT,
  similarity_score FLOAT,
  acknowledged_in_response BOOLEAN DEFAULT NULL
);
CREATE INDEX idx_episode_resurface_dispatch ON episode_resurface_event(dispatch_event_id);
```

### Task 3: Telemetry passthrough

The hook emits a JSONL event per resurface (parallel to surfaces). The consumer (`dispatchEventConsumer.js`) extends to drain `episode_resurfaces` array into `episode_resurface_event` rows.

### Task 4: Repeated-failure-after-resurface metric

Phase F's primary health metric. For each `episode_resurface_event`, check whether the dispatch's outcome was the SAME failure mode as the resurfaced Episode's recorded failure mode. If yes (same failure, despite resurface), increment the "repeated failure rate" counter.

If repeated-failure-rate stays high (>20% over 30d), the resurfacing isn't producing learning — the conductor reads and ignores. Surface as P2 status_board flag.

### Task 5: Episode archival

Episodes older than 6 months that no longer resurface (similarity below threshold) are candidates for `cold_episode` partition: lower retrieval cost, still queryable on demand. This is housekeeping for the Neo4j corpus, runnable monthly.

### Task 6: Layer 7 dashboard panel

Extend `/api/telemetry/decision-quality` with `episode_resurfacing` panel:
- Total resurfaces over window.
- Top-resurfaced nodes (by frequency).
- Repeated-failure-after-resurface rate.
- "Surfaced but ignored" count (nodes resurfaced where the response did NOT cite them).

---

## Hard constraints

- **Hot-path latency:** semantic_search adds 50-200ms PER dispatch. This is the most invasive change. Have a hard 500ms timeout — if exceeded, skip rather than block.
- **Embedding cost:** ~$0.0001 per call. At 1000 dispatches/day = ~$3/month. Acceptable.
- **Backward-compatible:** the hook's semantic_search call is wrapped in try/catch. If Neo4j is down, hook continues with normal output.
- **Cold-start safe:** new sessions still see the existing trigger-keyword grep results even if semantic_search is unavailable.
- **Internal-only:** EcodiaOS Neo4j corpus.

---

## What counts as done

- `episode_resurface_event` table in place.
- Hook (or sibling) calls semantic_search and emits resurfaces.
- `dispatchEventConsumer.js` drains the new event class.
- Phase F dashboard panel ships.
- Repeated-failure-rate metric computed and surfaced.
- Synthetic test: dispatch a fork whose goal sentence semantically matches a known Episode (but NOT trigger-keyword-matches a Pattern). Confirm the Episode surfaces.
- Architecture file's phasing table updated: "F SHIPPED".

---

## Verification protocol

1. Identify an Episode in Neo4j whose `name` and `description` use vocabulary distinct from any pattern file's `triggers:` line.
2. Dispatch a synthetic fork whose goal sentence paraphrases that Episode (without using the same words).
3. Confirm `[EPISODE-RESURFACE INFO]` line appears in the hook output, citing the Episode.
4. Confirm `episode_resurface_event` row landed.
5. Curl `/api/telemetry/decision-quality?days=7` — confirm episode_resurfacing panel shows the event.

---

## Cross-references

- `~/ecodiaos/patterns/decision-quality-self-optimization-architecture.md` (Layer 7 spec)
- `~/ecodiaos/patterns/neo4j-first-context-discipline.md` (Neo4j retrieval discipline)
- `~/ecodiaos/patterns/context-surfacing-must-be-reliable-and-selective.md` (Layer 1 — Layer 7 is the semantic-fallback layer the meta-pattern names but doesn't yet automate)
- `~/ecodiaos/scripts/hooks/brief-consistency-check.sh` (extend OR sibling)
- Phase F depends on Phase B (telemetry foundation, SHIPPED). Schedule after D and E for cleanest attribution.

---

## Origin

Pre-staged 29 Apr 2026 by fork_mojpf9sm_0f7cef. Original briefing intent from fork_mojnrqs8_48ed64.
