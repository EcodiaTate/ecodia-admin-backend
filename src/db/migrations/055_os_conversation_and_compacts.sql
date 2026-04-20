-- os_conversation: structured append-only turn log for replay-capable rehydration
CREATE TABLE IF NOT EXISTS os_conversation (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cc_session_id uuid NOT NULL,
  turn_number integer NOT NULL,
  role text NOT NULL CHECK (role IN ('user','assistant','tool_use','tool_result','system')),
  content text,
  content_json jsonb,
  token_count integer,
  created_at timestamptz NOT NULL DEFAULT NOW(),
  superseded_by_compact_id uuid NULL
);
CREATE INDEX IF NOT EXISTS idx_os_conversation_session_turn ON os_conversation(cc_session_id, turn_number);
CREATE INDEX IF NOT EXISTS idx_os_conversation_session_time ON os_conversation(cc_session_id, created_at DESC);

-- os_compacts: history of auto-compactions (summary + what turn range it replaced)
CREATE TABLE IF NOT EXISTS os_compacts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cc_session_id uuid NOT NULL,
  summary text NOT NULL,
  turn_range_start integer NOT NULL,
  turn_range_end integer NOT NULL,
  tokens_before integer,
  tokens_after integer,
  created_at timestamptz NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_os_compacts_session ON os_compacts(cc_session_id, created_at DESC);
