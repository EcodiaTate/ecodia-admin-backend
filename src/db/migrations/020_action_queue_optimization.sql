-- 020: Action Queue Optimization
-- Index for sender name lookups used by tryConsolidate() and getPendingForSender()

CREATE INDEX IF NOT EXISTS idx_action_queue_context_from
  ON action_queue ((context->>'from'))
  WHERE status = 'pending';

-- Composite index for getPending() sort: priority + created_at on pending items
-- Replaces the need to evaluate CASE on every query
CREATE INDEX IF NOT EXISTS idx_action_queue_pending_priority
  ON action_queue (
    (CASE priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 WHEN 'low' THEN 3 END),
    created_at DESC
  )
  WHERE status = 'pending';
