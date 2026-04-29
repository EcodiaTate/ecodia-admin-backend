-- 067: Phase F (Layer 7) — episode_resurface_event
--
-- Tracks Episode-node resurfacings emitted by the Layer 7 dispatch path.
-- See: ~/ecodiaos/patterns/decision-quality-self-optimization-architecture.md
-- (Layer 7 - Accumulated-learning resurfacing).
--
-- Schema parity note: this migration codifies a table that was previously
-- created out-of-band (the live Postgres has had episode_resurface_event for
-- some time but no migration file existed). The migration is idempotent
-- (CREATE TABLE IF NOT EXISTS + CREATE INDEX IF NOT EXISTS) so it is a no-op
-- on environments where the table already exists, and a structural ship on
-- environments where it does not. Future schema changes go in subsequent
-- migrations, not by amending this one.
--
-- Columns:
--   id, ts                                — surrogate PK + insert timestamp
--   dispatch_event_id                     — FK-shaped (uuid) link back to dispatch_event
--                                           (kept loose; not a hard FK so a missing
--                                            dispatch_event row never blocks an Episode
--                                            resurface insert)
--   hook_name, tool_name                  — same shape as dispatch_event for joins
--   resurfaced_node_id, _label, _name     — Neo4j node descriptors of the Episode
--   similarity_score                      — cosine score (0..1) from semantic search
--   acknowledged_in_response              — fill-later: did the dispatch consume
--                                           the resurfaced Episode in its output
--   repeated_failure                      — fill-later: did the dispatched action
--                                           fail in the SAME shape as the resurfaced
--                                           Episode (Layer-7 primary health metric)
--   metadata                              — jsonb escape hatch (query text, alt-hits,
--                                           hook stderr context, etc.)

CREATE TABLE IF NOT EXISTS public.episode_resurface_event (
  id                          BIGSERIAL PRIMARY KEY,
  ts                          TIMESTAMPTZ NOT NULL DEFAULT now(),
  dispatch_event_id           UUID,
  hook_name                   TEXT,
  tool_name                   TEXT,
  resurfaced_node_id          TEXT NOT NULL,
  resurfaced_node_label       TEXT,
  resurfaced_node_name        TEXT,
  similarity_score            DOUBLE PRECISION,
  acknowledged_in_response    BOOLEAN,
  repeated_failure            BOOLEAN,
  metadata                    JSONB
);

CREATE INDEX IF NOT EXISTS idx_episode_resurface_event_ts
  ON public.episode_resurface_event (ts DESC);

CREATE INDEX IF NOT EXISTS idx_episode_resurface_event_dispatch
  ON public.episode_resurface_event (dispatch_event_id)
  WHERE dispatch_event_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_episode_resurface_event_node
  ON public.episode_resurface_event (resurfaced_node_id);

CREATE INDEX IF NOT EXISTS idx_episode_resurface_event_repeated
  ON public.episode_resurface_event (repeated_failure)
  WHERE repeated_failure IS NOT NULL;

COMMENT ON TABLE public.episode_resurface_event IS
  'Phase F (Layer 7) of decision-quality self-optimization architecture: '
  'records each Episode node resurfaced into a dispatch context, plus '
  'whether the dispatched action acknowledged it and whether the action '
  'repeated the prior failure shape.';
