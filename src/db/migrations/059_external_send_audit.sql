CREATE TABLE IF NOT EXISTS external_send_audit (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sent_at timestamptz NOT NULL DEFAULT now(),
  inbox text,
  recipients_all text[],
  external_recipients text[] NOT NULL,
  subject text,
  tate_goahead_ref text NOT NULL,
  message_id text,
  thread_id text
);
CREATE INDEX IF NOT EXISTS idx_external_send_audit_sent_at ON external_send_audit(sent_at DESC);
