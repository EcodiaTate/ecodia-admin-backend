-- 015: Action Queue Consolidation Support
-- Adds updated_at for tracking consolidated items and index for sender-based lookups

ALTER TABLE action_queue ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT now();

-- Index for consolidation: find pending items by sender email/name
CREATE INDEX IF NOT EXISTS idx_action_queue_consolidation
  ON action_queue(source, status, created_at DESC)
  WHERE status = 'pending';

-- GIN index on context for JSONB sender lookups
CREATE INDEX IF NOT EXISTS idx_action_queue_context_email
  ON action_queue ((context->>'email'))
  WHERE status = 'pending';
