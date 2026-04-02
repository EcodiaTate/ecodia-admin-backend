-- 014: Add triage columns to meta_conversations + missing indexes
-- Meta DMs now get AI-triaged like LinkedIn DMs and Gmail emails

ALTER TABLE meta_conversations ADD COLUMN IF NOT EXISTS triage_status text;
ALTER TABLE meta_conversations ADD COLUMN IF NOT EXISTS triage_priority text;
ALTER TABLE meta_conversations ADD COLUMN IF NOT EXISTS triage_summary text;

-- Index for triage polling
CREATE INDEX IF NOT EXISTS idx_meta_conversations_triage
  ON meta_conversations (triage_status) WHERE triage_status IS NULL OR triage_status = 'pending';

-- Action queue: index for calendar source lookups (meeting prep dedup)
CREATE INDEX IF NOT EXISTS idx_action_queue_source_ref
  ON action_queue (source, source_ref_id) WHERE status = 'pending';
