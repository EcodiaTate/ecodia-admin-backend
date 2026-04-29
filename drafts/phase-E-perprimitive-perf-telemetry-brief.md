# Phase E — Per-Primitive Performance Telemetry & Auto-Tune (Layer 6 of 7)

**Source-of-truth:** `~/ecodiaos/patterns/decision-quality-self-optimization-architecture.md` (Layer 6 spec, lines 100-108). This brief is dispatch-ready.

**Phase position:** Layer 6. Schedule after Phase D is stable. Cosmetic/optimisation; the architecture works without it but degrades silently as the corpus grows.

**Goal:** Catch p95-latency regression on hot primitives (`brief-consistency-check.sh`, `forkService.spawn`, `macroSuite.run`, `mcp__neo4j__graph_semantic_search`) before it becomes user-visible. Without this, hooks slow gradually as patterns/ corpus grows; the conductor only notices when a fork dispatch noticeably stalls.

---

## Tasks

### Task 1: `primitive_perf_event` table

Migration:
```sql
CREATE TABLE primitive_perf_event (
  id BIGSERIAL PRIMARY KEY,
  ts TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  primitive_name TEXT NOT NULL,
  duration_ms INTEGER NOT NULL,
  metadata JSONB,
  -- common dimensions for slicing
  status TEXT,           -- 'ok' / 'error' / 'timeout'
  payload_size_bytes INTEGER,
  CHECK (duration_ms >= 0)
);
CREATE INDEX idx_perf_primitive_ts ON primitive_perf_event(primitive_name, ts DESC);
```

### Task 2: Instrument hot primitives

Add timing telemetry to:
- `brief-consistency-check.sh` (and siblings) — emit duration_ms via the existing `emit-telemetry.sh` lib OR a new sibling `emit-perf.sh`. JSONL line shape: `{ts, primitive_name, duration_ms, status, payload_size_bytes}` to `~/ecodiaos/logs/telemetry/perf-events.jsonl`.
- `src/services/forkService.js` `spawnFork()` — wrap with `performance.now()` brackets, emit perf event via direct Postgres write OR JSONL append (consistent with the dispatch_event hot-path discipline — JSONL preferred).
- `src/services/macroSuite.js` `run()` — same.
- `mcp__neo4j__graph_semantic_search` — emit perf event via the MCP server wrapper (timing spans the embedding compute call).

### Task 3: Batch consumer

Author `~/ecodiaos/src/services/telemetry/perfEventConsumer.js` (mirror of dispatchEventConsumer): drain perf-events.jsonl into primitive_perf_event every 15m. Schedule `telemetry-perf-consumer` cron.

### Task 4: Auto-tune cron

Author `~/ecodiaos/src/services/telemetry/perfAutoTune.js`:

For each primitive_name, compute:
- `p50`, `p95`, `p99` latency over rolling 7d.
- `delta_vs_30d_baseline` = (current_p95 - baseline_p95) / baseline_p95.

If `delta > 0.5` (50% regression) AND sample count >= 100, raise a P2 status_board flag `perf_regression: <primitive_name> p95 +<X>%`. Don't fire if sample count is low (avoid noise on rarely-used primitives).

Auto-retrain baseline: after a regression flag, if p95 stays within ±20% of new value for 7 consecutive days, accept the new baseline. Don't poison the baseline forever on a one-off spike.

Schedule `decision-quality-perf-autotune` every 24h.

### Task 5: Layer 6 dashboard panel

Extend `/api/telemetry/decision-quality` with `perf_per_primitive` panel:
- Per primitive: p50, p95, p99 over window + delta vs baseline.
- Top regression candidates: primitives with delta > 25% even if not yet at the 50% flag threshold.

### Task 6: Layer 6 drift detection (already covered above)

Auto-tune cron IS the drift detector. No separate flag class needed.

---

## Hard constraints

- **Hot-path latency:** perf instrumentation MUST NOT itself add measurable overhead. Target overhead < 100µs per primitive call.
- **JSONL append (consistent with Phase B):** perf events go to JSONL, batch consumer drains every 15m. No direct Postgres write from instrumented primitives.
- **Sample count gating:** never flag regression on n < 100. Statistical noise dominates below that.
- **Baseline retraining:** prevent the baseline-poisoning failure mode (one bad day becoming the new normal).
- **Internal-only:** EcodiaOS primitives. Don't instrument client codebase code.

---

## What counts as done

- `primitive_perf_event` table + indexes in place.
- 4 hot primitives instrumented; perf JSONL accumulating real events.
- `telemetry-perf-consumer` cron scheduled, draining JSONL.
- `decision-quality-perf-autotune` cron scheduled, computing deltas.
- `perf_per_primitive` panel in `/api/telemetry/decision-quality`.
- One synthetic regression test: artificially slow `brief-consistency-check.sh` by 100% for 1 day; confirm `perf_regression` flag fires.
- Architecture file's phasing table updated: "E SHIPPED".

---

## Cross-references

- `~/ecodiaos/patterns/decision-quality-self-optimization-architecture.md` (Layer 6 spec)
- `~/ecodiaos/scripts/hooks/lib/emit-telemetry.sh` (template for `emit-perf.sh`)
- `~/ecodiaos/src/services/telemetry/dispatchEventConsumer.js` (template for perfEventConsumer)
- `~/ecodiaos/src/services/forkService.js` (instrument spawnFork)
- `~/ecodiaos/src/services/macroSuite.js` (instrument run)

---

## Origin

Pre-staged 29 Apr 2026 by fork_mojpf9sm_0f7cef. Original briefing intent from fork_mojnrqs8_48ed64.
