-- 058_ios_ship_attempts.sql
-- Tracks iOS App Store submission attempts via the ASC API client.

CREATE TABLE IF NOT EXISTS ios_ship_attempts (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  app_id        TEXT,
  bundle_id     TEXT NOT NULL,
  version_string TEXT NOT NULL,
  build_number  TEXT,
  build_id      TEXT,
  version_id    TEXT,
  submission_id TEXT,
  state         TEXT NOT NULL DEFAULT 'started',
  error         TEXT,
  started_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at  TIMESTAMPTZ,
  metadata      JSONB DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS idx_ios_ship_attempts_state ON ios_ship_attempts(state);
CREATE INDEX IF NOT EXISTS idx_ios_ship_attempts_started_at ON ios_ship_attempts(started_at DESC);
