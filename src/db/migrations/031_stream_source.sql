-- 031: Add stream_source column to cc_sessions
-- Tracks which cognitive stream (maintenance, exploration, perception, reflection)
-- generated each dispatched session, enabling per-stream effectiveness analysis.

ALTER TABLE cc_sessions ADD COLUMN IF NOT EXISTS stream_source TEXT;

-- Index for per-stream queries in the system brief
CREATE INDEX IF NOT EXISTS idx_cc_sessions_stream_source ON cc_sessions (stream_source) WHERE stream_source IS NOT NULL;
