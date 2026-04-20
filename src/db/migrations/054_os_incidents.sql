-- Structured incident log. Every non-success turn and every subsystem
-- failure writes one row here. The OS queries it to diagnose itself.
CREATE TABLE IF NOT EXISTS os_incidents (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  kind        TEXT NOT NULL,        -- turn_failure | mcp_failure | provider_switch | tool_hung | db_error | alert_fired | cert_warning
  severity    TEXT NOT NULL DEFAULT 'warn' CHECK (severity IN ('info','warn','error','critical')),
  component   TEXT,                 -- service or subsystem name — os_session | scheduler | heartbeat | neo4j | supabase | twilio | bedrock | claude_max | claude_max_2 | ...
  message     TEXT NOT NULL,
  context     JSONB NOT NULL DEFAULT '{}',  -- retryDepth, toolName, provider, model, lastToolId, etc.
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_os_incidents_created_at ON os_incidents(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_os_incidents_kind_created ON os_incidents(kind, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_os_incidents_component_created ON os_incidents(component, created_at DESC);
