-- Durable write-ahead buffer for Neo4j writes that arrive when Aura is unreachable.
-- Writes are buffered here and replayed via graph_replay_buffer MCP tool once the instance is back.
CREATE TABLE IF NOT EXISTS graph_write_buffer (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  tool        TEXT        NOT NULL,          -- 'graph_reflect' | 'graph_merge_node' | 'graph_create_relationship'
  payload     JSONB       NOT NULL,          -- full args the MCP tool was called with
  status      TEXT        NOT NULL DEFAULT 'pending', -- 'pending' | 'replayed' | 'failed'
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  replayed_at TIMESTAMPTZ,
  error       TEXT
);

CREATE INDEX IF NOT EXISTS graph_write_buffer_status_created
  ON graph_write_buffer (status, created_at);
