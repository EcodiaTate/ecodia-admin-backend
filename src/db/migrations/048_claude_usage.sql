-- migrations/048_claude_usage.sql
-- Track Claude Max weekly usage per conversation turn
-- Enables energy budgeting: the OS can see its weekly spend and self-govern model choice

CREATE TABLE IF NOT EXISTS claude_usage (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id      UUID,                        -- references cc_sessions(id) if applicable
  source          TEXT NOT NULL DEFAULT 'os_session',  -- 'os_session', 'factory', 'cortex'
  provider        TEXT NOT NULL DEFAULT 'claude_max',  -- 'claude_max', 'bedrock_opus', 'bedrock_sonnet'
  model           TEXT,                        -- model ID string
  input_tokens    INTEGER NOT NULL DEFAULT 0,
  output_tokens   INTEGER NOT NULL DEFAULT 0,
  cost_usd        NUMERIC(12, 6),              -- estimated cost if on a pay-as-you-go plan
  week_start      DATE NOT NULL,               -- ISO Monday of the billing week
  created_at      TIMESTAMPTZ DEFAULT now()
);

-- Fast weekly aggregation queries
CREATE INDEX IF NOT EXISTS claude_usage_week_start_idx ON claude_usage (week_start);
CREATE INDEX IF NOT EXISTS claude_usage_provider_idx ON claude_usage (provider);
CREATE INDEX IF NOT EXISTS claude_usage_created_at_idx ON claude_usage (created_at);
