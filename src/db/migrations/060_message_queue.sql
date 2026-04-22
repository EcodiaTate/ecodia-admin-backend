CREATE TABLE IF NOT EXISTS message_queue (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  body text NOT NULL,
  mode text NOT NULL DEFAULT 'queue' CHECK (mode IN ('queue', 'direct')),
  source text NOT NULL DEFAULT 'tate',
  queued_at timestamptz NOT NULL DEFAULT now(),
  delivered_at timestamptz,
  delivered_in_turn_id text,  -- turn id from os_session if available
  cancelled_at timestamptz,
  promoted_at timestamptz,    -- non-null if age-swept or explicit promote
  max_age_hours int NOT NULL DEFAULT 24,
  context_at_queue jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- snapshot: {current_work, active_plan, last_assistant_turn_id, top_status_board_row, last_cc_session_id}
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_message_queue_pending
  ON message_queue (queued_at)
  WHERE delivered_at IS NULL AND cancelled_at IS NULL;

COMMENT ON TABLE message_queue IS 'Tate->OS inbox. Queued messages held until os_signal_handoff fires or max_age_hours elapses.';
