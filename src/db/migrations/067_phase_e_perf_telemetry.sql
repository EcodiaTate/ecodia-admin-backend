-- 067: Phase E - per-primitive performance telemetry + macro auto-tune.
--
-- Layer 6 of the Decision Quality Self-Optimization Architecture.
-- See: ~/ecodiaos/patterns/decision-quality-self-optimization-architecture.md
-- Brief: ~/ecodiaos/drafts/phase-E-perprimitive-perf-telemetry-brief.md
--
-- Three tables:
--   1. primitive_perf_event - one row per timed invocation of a hot primitive
--      (forkService.spawnFork, macroSuite.run, brief-consistency-check.sh,
--      mcp__neo4j__graph_semantic_search). Drives p50/p95/p99 panels and
--      regression detection.
--   2. macro_perf_event - macro-specific perf event with per-step wait timings
--      and success state. Drives the macro wait-time auto-tune cron (the
--      canonical use case Tate named at 16:09 AEST 29 Apr 2026).
--   3. macro_tune_log - audit trail of every wait-time adjustment the
--      auto-tune cron makes. One row per tune (per macro per param per run).

-- ---------------------------------------------------------------------------
-- primitive_perf_event
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS primitive_perf_event (
  id              BIGSERIAL PRIMARY KEY,
  ts              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  primitive_name  TEXT NOT NULL,
  duration_ms     INTEGER NOT NULL,
  status          TEXT,                 -- 'ok' | 'error' | 'timeout'
  payload_size_bytes INTEGER,
  metadata        JSONB,
  CHECK (duration_ms >= 0)
);

CREATE INDEX IF NOT EXISTS idx_perf_primitive_ts ON primitive_perf_event(primitive_name, ts DESC);
CREATE INDEX IF NOT EXISTS idx_perf_ts ON primitive_perf_event(ts DESC);

-- ---------------------------------------------------------------------------
-- macro_perf_event
--
-- One row per macroSuite.run() invocation. wait_steps is a JSONB array of
-- {step_name, expected_ms, observed_ms, succeeded} objects, capturing every
-- input.* / screenshot.* / waitFor primitive the macro composed.
-- The auto-tune cron analyses observed_ms vs expected_ms across the trailing
-- 30 runs per macro and adjusts the registered expected wait params.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS macro_perf_event (
  id              BIGSERIAL PRIMARY KEY,
  ts              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  run_id          TEXT NOT NULL,        -- caller-supplied unique id (e.g. fork_id + ts)
  macro_name      TEXT NOT NULL,        -- registry key, e.g. 'stripe-dashboard-charges'
  target_host     TEXT,                 -- 'corazon' | 'sy094' | future hosts
  wait_steps      JSONB,                -- [{step_name, expected_ms, observed_ms, succeeded}]
  total_ms        INTEGER NOT NULL,
  success         BOOLEAN NOT NULL,
  error_message   TEXT,
  metadata        JSONB,
  CHECK (total_ms >= 0)
);

CREATE INDEX IF NOT EXISTS idx_macro_perf_macro_ts ON macro_perf_event(macro_name, ts DESC);
CREATE INDEX IF NOT EXISTS idx_macro_perf_ts ON macro_perf_event(ts DESC);

-- ---------------------------------------------------------------------------
-- macro_tune_log
--
-- Audit trail of every wait-time adjustment the auto-tune cron makes.
-- Used for forensic review of why a macro started running differently, and
-- for the cap enforcement (5x of original baseline). Direction is 'up' or
-- 'down'; reason captures the median/sample-count signal that triggered it.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS macro_tune_log (
  id              BIGSERIAL PRIMARY KEY,
  ts              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  macro_name      TEXT NOT NULL,
  step_name       TEXT NOT NULL,
  param_name      TEXT NOT NULL,        -- usually 'expected_ms'
  old_value_ms    INTEGER NOT NULL,
  new_value_ms    INTEGER NOT NULL,
  direction       TEXT NOT NULL CHECK (direction IN ('up', 'down', 'no_change')),
  reason          TEXT NOT NULL,        -- e.g. 'observed median 45ms is <50% of expected 100ms over 30 runs'
  sample_count    INTEGER NOT NULL,
  observed_median_ms INTEGER,
  observed_p95_ms INTEGER,
  baseline_ms     INTEGER,              -- the original (5x cap reference) value
  capped          BOOLEAN NOT NULL DEFAULT FALSE
);

CREATE INDEX IF NOT EXISTS idx_macro_tune_macro_ts ON macro_tune_log(macro_name, ts DESC);
