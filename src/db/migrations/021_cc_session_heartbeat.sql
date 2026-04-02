-- Add heartbeat tracking to cc_sessions so orphan detection can use
-- recency of last heartbeat rather than just started_at.
-- A session with no heartbeat update in 2+ minutes is likely dead.

ALTER TABLE cc_sessions ADD COLUMN IF NOT EXISTS last_heartbeat_at TIMESTAMPTZ;

-- Index for efficient orphan queries
CREATE INDEX IF NOT EXISTS idx_cc_sessions_heartbeat_running
  ON cc_sessions (last_heartbeat_at)
  WHERE status IN ('running', 'initializing');
