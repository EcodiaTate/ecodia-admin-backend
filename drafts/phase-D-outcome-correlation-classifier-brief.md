# Phase D — Outcome Correlation Classifier (Layer 5 of 7)

**Source-of-truth:** `~/ecodiaos/patterns/decision-quality-self-optimization-architecture.md` (Layer 5 spec, lines 86-98). This brief is dispatch-ready.

**Phase position:** Layer 5. Depends on Phase B (telemetry foundation, SHIPPED) and Phase C (application tags, TBD). Without Phase C's application_event signal, Phase D cannot distinguish usage failure from surfacing failure.

**Goal:** When `outcome_event.outcome = 'correction'`, classify the failure into one of three modes — usage / surfacing / doctrine — so the remediation routes to the right layer:
- **Usage failure:** relevant pattern surfaced AND was tagged `[APPLIED]` AND outcome was still a correction. The doctrine was right; the application was wrong (or the doctrine was right but incomplete). Refine the pattern.
- **Surfacing failure:** relevant pattern existed but did NOT surface (no `surface_event` row for it). The triggers missed. Tighten/expand triggers OR write a new pattern.
- **Doctrine failure:** no relevant pattern existed. Author a new pattern.

---

## Tasks

### Task 1: Classifier service

Author `~/ecodiaos/src/services/telemetry/failureClassifier.js`:

For each `outcome_event` with `outcome='correction'` AND `classification IS NULL`, run:

1. **Find the action context.** Pull `dispatch_event.metadata` + the conductor's response text + Tate's correction text (already linked via `outcome_event.correction_text`).
2. **Embedding-search the patterns corpus** (`mcp__neo4j__graph_semantic_search` against `Pattern` nodes) using the correction text as the query. Top-K results = "patterns that should have surfaced for this correction".
3. **Compare to actual surface_event rows for the dispatch:**
   - Top-K all surfaced AND tagged `[APPLIED]` → classification = **usage_failure**
   - Top-K not all surfaced (semantic match exists but no surface_event row) → classification = **surfacing_failure**
   - Top-K returned zero results above similarity threshold → classification = **doctrine_failure**
4. Write classification + evidence_note into `outcome_event`.

### Task 2: Schedule classifier cron

Schedule `decision-quality-classifier` every 1h. Classifier handles 50 unclassified outcomes per tick max (cap to control embedding cost).

### Task 3: Classification dashboard panel

Extend `decisionQualityService.computeDecisionQuality()` with a 6th panel `classification_distribution`:
- Per classification (usage / surfacing / doctrine): rolling-7d count + as % of total corrections.
- Per pattern: which classifications dominate when this pattern is involved.
- Top-10 doctrine_failure clusters: "no pattern existed for X" — surfaced as authoring-fork candidates.

### Task 4: Tate-tagged ground truth + auto-classifier accuracy

Add a `classification_tate_tagged` column to `outcome_event`. Tate can override the auto-classification via a new admin route `POST /api/telemetry/outcome/:id/classify` with `{classification, note}`. Run a periodic accuracy check: when both auto- and Tate-classifications exist, % match. If accuracy drops below 70%, flag as P2 status_board signal.

### Task 5: Doctrine-failure auto-author trigger

When `doctrine_failure` count for a particular cluster exceeds 3 over 14d, fire a status_board P2 row "Doctrine gap: <cluster> — author new pattern". This is the architecture flagging its own gaps.

---

## Hard constraints

- **Embedding cost budget:** classifier runs at most 50 outcomes/tick × 24 ticks = 1200/day. Each call uses one Neo4j semantic search. If embedding cost runs over $5/day, cap.
- **Conservative defaults:** when in doubt, classify as `usage_failure` (least invasive remediation). Phase D is about routing, not about being right 100%.
- **Hot-path safe:** classifier runs from cron, never on dispatch hot path.
- **Internal-only:** doctrine corpus only.

---

## What counts as done

- `failureClassifier.js` exists; runs from CLI in --once mode.
- `decision-quality-classifier` cron scheduled (every 1h).
- `outcome_event.classification` column populated for all corrections older than 1 day.
- `/api/telemetry/decision-quality?days=7` returns `classification_distribution` panel with valid data.
- `POST /api/telemetry/outcome/:id/classify` admin route lands; Tate can override.
- Accuracy check produces a number even on partial ground-truth data.
- Architecture file's phasing table updated: "D SHIPPED".

---

## Verification protocol

1. Inject one synthetic `outcome_event` with outcome='correction' + correction_text matching a known pattern's keywords. Run classifier --once. Confirm `classification = 'usage_failure'` (because the pattern surfaced) OR `surfacing_failure` (because it didn't).
2. Inject one synthetic correction with vocabulary fully outside the patterns corpus. Confirm `classification = 'doctrine_failure'`.
3. Curl `/api/telemetry/decision-quality?days=30` — confirm classification_distribution panel returns non-zero counts.

---

## Cross-references

- `~/ecodiaos/patterns/decision-quality-self-optimization-architecture.md` (Layer 5 spec)
- `~/ecodiaos/patterns/neo4j-first-context-discipline.md` (Neo4j retrieval discipline; Phase D leverages semantic search heavily)
- `~/ecodiaos/src/services/telemetry/outcomeInference.js` (Phase B's `correction` outcomes feed Phase D's classifier)
- `~/ecodiaos/src/services/telemetry/decisionQualityService.js` (extend with classification_distribution)
- Phase D depends on Phase B (SHIPPED) AND Phase C (application_event tags). Cannot start until both land.

---

## Origin

Pre-staged 29 Apr 2026 by fork_mojpf9sm_0f7cef. Original briefing intent from fork_mojnrqs8_48ed64.
