-- 072_phase_f_episode_resurface_event.sql
--
-- Phase F (Layer 7) of the Decision Quality Self-Optimization Architecture.
-- See: ~/ecodiaos/patterns/decision-quality-self-optimization-architecture.md
-- Brief: ~/ecodiaos/drafts/phase-F-neo4j-resurfacing-brief.md
--
-- At dispatch time the episode-resurface hook semantically searches the Neo4j
-- corpus (Episode/Decision/Pattern/Strategic_Direction) for nodes conceptually
-- similar to the brief's goal sentence. Each surfaced node lands one row here
-- so we can compute "repeated failure after resurface" and "surfaced but
-- ignored" rates as Phase F's primary health metrics.
--
-- Note on FK type: dispatch_event.id is UUID (not BIGINT as drafted). The
-- column type below MUST mirror that to keep the FK valid.
--
-- Idempotent: IF NOT EXISTS guards everywhere.

CREATE TABLE IF NOT EXISTS episode_resurface_event (
  id BIGSERIAL PRIMARY KEY,
  ts TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  dispatch_event_id UUID REFERENCES dispatch_event(id) ON DELETE SET NULL,
  hook_name TEXT,
  tool_name TEXT,
  -- The Neo4j node that resurfaced.
  resurfaced_node_id TEXT NOT NULL,        -- node.identity.toNumber() or name when id absent
  resurfaced_node_label TEXT,              -- primary label (Episode|Decision|Pattern|Strategic_Direction)
  resurfaced_node_name TEXT,
  similarity_score DOUBLE PRECISION,
  -- Whether the conductor's downstream response cited this resurface
  -- (computed downstream, NULL until classification runs).
  acknowledged_in_response BOOLEAN DEFAULT NULL,
  -- Optional repeated-failure tracking. NULL = unknown / not yet evaluated.
  -- TRUE = subsequent dispatch outcome matched the resurfaced node's known
  -- failure mode (set by Phase F's repeated-failure metric job).
  repeated_failure BOOLEAN DEFAULT NULL,
  metadata JSONB
);

CREATE INDEX IF NOT EXISTS idx_episode_resurface_dispatch ON episode_resurface_event(dispatch_event_id);
CREATE INDEX IF NOT EXISTS idx_episode_resurface_node ON episode_resurface_event(resurfaced_node_name);
CREATE INDEX IF NOT EXISTS idx_episode_resurface_ts ON episode_resurface_event(ts DESC);

COMMENT ON TABLE episode_resurface_event IS
  'Phase F (Layer 7) of decision-quality architecture. Each row is one Neo4j node ' ||
  'semantically-resurfaced at fork/Factory dispatch time. Drained from ' ||
  'logs/telemetry/episode-resurfaces.jsonl by dispatchEventConsumer.';
