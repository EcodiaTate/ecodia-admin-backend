# Phase G - Adversarial Self-Audit Brief (daily 22:00 AEST critic-fork)

This brief is the body the daily `phase-G-adversarial-audit` cron dispatches. It instructs a fork to run an adversarial audit of the last 7 days of decisions, identify the worst N, and write `Critique` Neo4j nodes (advisory only) with proposed pattern stubs where doctrine gaps are exposed.

## Why this brief exists

Without an internal critic, doctrine evolves only when Tate flags an issue or a fork happens to surface drift inside its own brief. Phase G is the layer that says "this was a bad call yesterday, here's why, here's a new pattern stub." It is the mechanical-enforcement layer for `~/ecodiaos/patterns/ocd-ambition-refuse-mediocrity.md` (the bar is "would this make Ecodia unparalleled") and `~/ecodiaos/patterns/no-symbolic-logging-act-or-schedule.md` (intentions don't survive sessions, only durable artefacts do).

**The critic's job is to be uncomfortable. Soft-pedalling defeats the layer.**

## Hard constraints (read first)

- **NEVER auto-create a Pattern node.** Critique nodes carry `proposed_pattern_stub` text bodies; humans (Tate or me-on-next-orient) decide whether to graduate them.
- **NEVER edit canonical doctrine files.** No edits to `~/ecodiaos/patterns/`, `~/ecodiaos/clients/`, `~/ecodiaos/docs/`, `~/CLAUDE.md`, `~/ecodiaos/CLAUDE.md`.
- **NEVER mutate kv_store.** Read-only on kv_store.
- **NEVER touch Phase B telemetry tables (`dispatch_event` / `surface_event` / `application_event` / `outcome_event`).** Read-only.
- **NEVER spawn other forks.** The audit IS this fork's deliverable.
- **Cap at 5 critiques per audit.** If more candidates exist, rank by `severity × evidence_strength` and write the top 5; mention the remainder in the status_board context as "13 candidates total, top 5 written."
- **Sparse-data graceful degradation:** if telemetry is sparse and Neo4j scan returns no significant signal, output "no significant decisions to audit, telemetry sparse" and skip critique creation. Hallucinated critiques pollute the doctrine layer; zero critiques is fine.

## Reading list (orientation, ~3 min)

1. `~/ecodiaos/patterns/decision-quality-self-optimization-architecture.md` - especially the "Layer 8 - Adversarial self-audit" section and the Critique node schema.
2. `~/ecodiaos/patterns/ocd-ambition-refuse-mediocrity.md` - the quality bar that defines "bad decision."
3. `~/ecodiaos/patterns/forks-self-assessment-is-input-not-substitute.md` - if this file exists; otherwise skip. It defines why fork self-reports are evidence, not the verdict.
4. `~/ecodiaos/patterns/no-symbolic-logging-act-or-schedule.md` - the doctrine that says symbolic intentions don't count; only durable artefacts do.

## Process

### Step 1 - Telemetry pull (last 7 days)

Query each Phase B table for the last 7 days:

```sql
-- Dispatch graph counts
SELECT
  date_trunc('day', created_at) AS day,
  COUNT(*) AS dispatches,
  COUNT(DISTINCT dispatch_id) AS unique_dispatches
FROM dispatch_event
WHERE created_at > NOW() - INTERVAL '7 days'
GROUP BY 1 ORDER BY 1 DESC;

-- Surfacing rate
SELECT
  pattern_path,
  COUNT(*) AS surface_count
FROM surface_event
WHERE created_at > NOW() - INTERVAL '7 days'
GROUP BY 1 ORDER BY 2 DESC LIMIT 50;

-- Application rate (Phase C will populate; may be empty until then)
SELECT
  pattern_path,
  COUNT(*) FILTER (WHERE applied = TRUE) AS applied_count,
  COUNT(*) FILTER (WHERE applied = FALSE) AS not_applied_count
FROM application_event
WHERE created_at > NOW() - INTERVAL '7 days'
GROUP BY 1 ORDER BY 1;

-- Outcome correlation: dispatches that hit corrections
SELECT
  d.tool_name,
  COUNT(*) AS dispatches,
  COUNT(o.id) FILTER (WHERE o.outcome_type = 'correction') AS corrections,
  ROUND(100.0 * COUNT(o.id) FILTER (WHERE o.outcome_type = 'correction') / COUNT(*), 1) AS correction_pct
FROM dispatch_event d
LEFT JOIN outcome_event o ON o.dispatch_event_id = d.id
WHERE d.created_at > NOW() - INTERVAL '7 days'
GROUP BY 1 ORDER BY 4 DESC NULLS LAST LIMIT 30;
```

If aggregate dispatch_event count for the 7-day window is < 20, classify as **sparse telemetry** and fall back exclusively to the Neo4j scan in Step 2.

### Step 2 - Neo4j cross-reference (always run)

```cypher
// Today's CCSession + Decision + Episode + status_board reclassifications
MATCH (n)
WHERE (n:CCSession OR n:Decision OR n:Episode)
  AND coalesce(n.created_at, datetime()) > datetime() - duration('P7D')
RETURN labels(n) AS labels, n.name AS name, n.description AS description, n.created_at AS created_at
ORDER BY n.created_at DESC
LIMIT 100
```

Plus:

```sql
-- status_board rows that flipped from next_action_by='ecodiaos' back to 'tate' in last 7 days (suggests autonomous attempt failed)
SELECT id, name, status, next_action, next_action_by, last_touched, context
FROM status_board
WHERE last_touched > NOW() - INTERVAL '7 days'
  AND next_action_by = 'tate'
  AND context ILIKE '%fork_%'
ORDER BY last_touched DESC;
```

### Step 3 - Identify worst-N decisions

Heuristics for "bad decision" (in priority order):

1. **Tate explicit correction.** A directive in chat that overrode an autonomous action ("STOP DOING THE WORK", "BRO this is taking my confidence", "you didn't make that the pattern yet"). Cross-reference Neo4j Decision/Episode nodes for verbatim quotes. Cost = trust + time.
2. **Status_board reclassification back to Tate.** Autonomous attempt failed, the row was put back on Tate. Cost = the time spent before the reclassification + the wait for Tate.
3. **Fork orphaned by infrastructure failure.** PM2 restart, OS crash, parent-fork death without recovery state. Cost = the orphan's work + the recovery fork's time.
4. **Low-confidence Factory commit on critical path.** confidence < 0.4 approved without secondary verification. Cost = downstream trust debt.
5. **Hook fired and was ignored.** application_event silent rate per pattern (Phase C will populate). For now: any dispatch where the brief context shows `[CONTEXT-SURFACE WARN]` was emitted but the resulting fork did not reference the warned pattern in its FORK_REPORT. Cost = doctrine drift.
6. **30+ minute idle while Tate active.** Continuous-work doctrine violation (`~/ecodiaos/patterns/continuous-work-conductor-never-idle.md` if it exists). Cost = pipeline stagnation.

Cap at 5 critiques. If more candidates, rank by severity (1-5) × evidence_strength (1-3, integer) and pick top 5.

### Step 4 - Classify each critique

For each of the worst-N decisions, classify the failure_class:

- **`usage_failure`**: relevant pattern surfaced AND was acknowledged AND outcome was still a correction. Doctrine right, application wrong.
- **`surfacing_failure`**: relevant pattern existed but did NOT surface (no `surface_event` row for it). Triggers missed.
- **`doctrine_failure`**: no relevant pattern existed at all. Corpus has a gap.
- **`exploration_drift`**: knew the doctrine, deliberately chose to explore, didn't get back to baseline cost. (Distinct from `usage_failure` because the choice was conscious.)

Severity 1-5:
- 1: cost <15min
- 2: cost 15-60min
- 3: cost 1-3h
- 4: cost 3-8h OR trust impact
- 5: cost >8h OR material trust/reputation/data impact

### Step 5 - Write Critique nodes

For each of the 1-5 critiques (NEVER more than 5), write a Neo4j node:

```cypher
CREATE (c:Critique {
  dispatch_event_id: 'evt_xxx_or_null',
  decision_summary: 'one-line of what was decided',
  failure_class: 'doctrine_failure',
  severity: 4,
  proposed_pattern_stub: '... 200-400 word stub if doctrine gap, else null ...',
  evidence: 'fork_xxx, status_board_row_yyy, Episode "..." created_at YYYY-MM-DD HH:MM',
  created_at: datetime(),
  reviewed: false,
  tate_decision: null,
  audit_id: 'phase-G-audit-YYYY-MM-DD',
  fork_id: '<this fork id>'
})
RETURN id(c) AS critique_id, c.decision_summary AS summary
```

Keep the proposed_pattern_stub honest. If you can't articulate a clear new rule from this critique, set it to null - that means the failure was application of existing doctrine (`usage_failure`), not a doctrine gap.

### Step 6 - Surface to status_board

Insert one P3 row:

```sql
INSERT INTO status_board (entity_type, name, status, next_action, next_action_by, priority, last_touched, context)
VALUES (
  'task',
  'Phase G audit YYYY-MM-DD - N critiques, M proposed patterns',
  'audit-complete',
  'Review Critique nodes; set tate_decision to graduate/dismiss/elaborate per node.',
  'ecodiaos',
  3,
  NOW(),
  'Critique node IDs: [list]. Authored by <fork_id>. Audit window: last 7 days. Telemetry status: <sparse|partial|complete>. Top failure_class distribution: <e.g. 2 doctrine_failure, 1 usage_failure, 1 exploration_drift>.'
);
```

### Step 7 - Report

End the fork with:

```
[FORK_REPORT] Phase G adversarial audit YYYY-MM-DD complete. <N> critiques written (severity distribution: <list>), <M> with proposed_pattern_stub. Telemetry status: <sparse|partial|complete>. Critique IDs: <list>. status_board P3 row inserted at <id>. <If 0 critiques>: telemetry sparse, no significant decisions to audit - this is acceptable output. <If 5 critiques and N>5 candidates>: <total> candidates total, top 5 written by severity-times-evidence rank.
```

## Examples of expected critique quality

(These are illustrative - the cron should produce critiques that are this specific or better.)

**Example 1 - doctrine_failure, severity 4:**
> decision_summary: "Spawned 5/5 chambers + coexist forks at 16:50 AEST without OS-crash recovery state captured; OS crashed at 16:54 orphaning 4 forks (incl. fork_mojnrqs8 carrying Phase B Architecture doctrine)"
> failure_class: doctrine_failure
> severity: 4
> proposed_pattern_stub: "When dispatching N parallel forks where N >= 3, capture lightweight recovery state (fork IDs + brief paths + status_board entity_refs) to a single kv_store key BEFORE the last spawn returns. Recovery state must be sufficient to redispatch any orphaned fork from a fresh session without re-reading the parent's transcript. Cost of state-capture: ~2 tool calls. Cost of orphan recovery without state-capture: 1-2 hours of transcript-reread + brief reconstruction. ..."

**Example 2 - exploration_drift, severity 3:**
> decision_summary: "First-pass trigger authoring (102 pattern files) optimised for coverage over precision; baseline brief produced 16 surfacing warns, requiring same-day retune fork (fork_mojnfeb1) to revise 56 files."
> failure_class: exploration_drift
> severity: 3
> proposed_pattern_stub: "When authoring trigger keywords across a large doctrine corpus, the first-pass author should explicitly aim for *precision*, not coverage. False-positives compound across the corpus: 16 false-positive warns on a single dispatch teaches the conductor to skim warns. Acceptance criterion before declaring trigger-authoring complete: a representative recent fork brief should produce no more than 5 warns, and every warn should be a true positive on Tate-review. Compound-keyword triggers (entity-name + system-name + tech-term) outperform single common-noun triggers."

**Example 3 - usage_failure, severity 2, no doctrine gap:**
> decision_summary: "Conductor went 30+ minutes idle 14:35-15:05 AEST while Tate was active at the laptop, third strike on continuous-work-conductor-never-idle doctrine."
> failure_class: usage_failure
> severity: 2
> proposed_pattern_stub: null (doctrine already exists at `~/ecodiaos/patterns/continuous-work-conductor-never-idle.md`; this is application failure, not doctrine gap)

## What "good" looks like

- 1-3 critiques per audit at steady state.
- ~30% graduated to Pattern within 7 days.
- Mean severity 2-3.
- Zero hallucinated critiques (every critique cites at least one verifiable source: dispatch_event_id, Neo4j node name, status_board row id, Tate quote with timestamp).
- Honest classification (no defaulting to `doctrine_failure` when `usage_failure` is the truth).

## Origin

Authored 29 Apr 2026 by fork_mojpoybs_68d714 as Phase G of the Decision Quality Self-Optimization Architecture. The cron dispatches this brief verbatim daily at 22:00 AEST.
