-- 069: Cowork V2 MCP peerage substrate tables
--
-- Part 3 of 3 for Cowork V2 MCP peerage substrate (W2-B,
-- fork_mokmorc8_24edea, 30 Apr 2026).
--
-- Adds four tables:
--   * cowork_sessions       — open-paren marker for every Cowork session
--   * cowork_audit_log      — durable log of every Cowork-sourced WRITE
--   * cowork_inbox          — conductor -> Cowork queue (poll pattern)
--   * cowork_idempotency_log — 24h response cache keyed by idempotency_key
--
-- Spec reference: ~/ecodiaos/drafts/cowork-deep-integration-architecture-2026-04-30.md
--   §4.14-4.17, §5.2, §6.1, §10.4 step 3.

CREATE TABLE IF NOT EXISTS cowork_sessions (
  session_id   TEXT PRIMARY KEY,
  started_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  intent       TEXT,
  initiated_by TEXT NOT NULL DEFAULT 'cowork-self',
  ended_at     TIMESTAMPTZ,
  outcome      TEXT,
  outcome_reason TEXT,
  metadata     JSONB
);

CREATE INDEX IF NOT EXISTS cowork_sessions_started_idx
  ON cowork_sessions(started_at DESC);
CREATE INDEX IF NOT EXISTS cowork_sessions_open_idx
  ON cowork_sessions(session_id) WHERE ended_at IS NULL;

CREATE TABLE IF NOT EXISTS cowork_audit_log (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  occurred_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  cowork_session_id   TEXT,
  tool_name           TEXT NOT NULL,
  scope_used          TEXT NOT NULL,
  request_summary     JSONB,
  response_summary    JSONB,
  affected_substrate  TEXT,
  affected_row_ref    TEXT,
  bearer_fingerprint  TEXT,
  client_ip           INET
);

CREATE INDEX IF NOT EXISTS cowork_audit_log_occurred_idx
  ON cowork_audit_log(occurred_at DESC);
CREATE INDEX IF NOT EXISTS cowork_audit_log_session_idx
  ON cowork_audit_log(cowork_session_id);
CREATE INDEX IF NOT EXISTS cowork_audit_log_tool_idx
  ON cowork_audit_log(tool_name, occurred_at DESC);

CREATE TABLE IF NOT EXISTS cowork_inbox (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  queued_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  from_actor    TEXT NOT NULL,
  body          TEXT NOT NULL,
  ack_required  BOOLEAN DEFAULT TRUE,
  acked_at      TIMESTAMPTZ,
  expires_at    TIMESTAMPTZ,
  metadata      JSONB
);

CREATE INDEX IF NOT EXISTS cowork_inbox_queued_idx
  ON cowork_inbox(queued_at) WHERE acked_at IS NULL;
CREATE INDEX IF NOT EXISTS cowork_inbox_expires_idx
  ON cowork_inbox(expires_at) WHERE expires_at IS NOT NULL;

CREATE TABLE IF NOT EXISTS cowork_idempotency_log (
  key            TEXT PRIMARY KEY,
  tool_name      TEXT NOT NULL,
  response_json  JSONB NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS cowork_idempotency_created_idx
  ON cowork_idempotency_log(created_at);

COMMENT ON TABLE cowork_sessions IS 'Open-paren marker for every Cowork session. Pairs with cowork.log_session close-paren.';
COMMENT ON TABLE cowork_audit_log IS 'Disk-durable trace of every Cowork-sourced WRITE. Reads are not audited.';
COMMENT ON TABLE cowork_inbox IS 'Conductor -> Cowork message queue. Poll model: Cowork calls inbox.read.';
COMMENT ON TABLE cowork_idempotency_log IS '24h response cache keyed by idempotency_key. TTL cleanup runs on access.';
