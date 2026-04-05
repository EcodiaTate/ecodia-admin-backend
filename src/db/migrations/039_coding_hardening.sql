-- 039: Coding workspace hardening — dedup constraints, status enums, stuck-state recovery
--
-- Fixes identified in deep audit of the code request → Factory dispatch pipeline.

-- 1. Prevent duplicate code requests from the same source
--    (e.g., email triaged twice before status update commits)
CREATE UNIQUE INDEX IF NOT EXISTS idx_code_requests_source_dedup
  ON code_requests(source, source_ref_id)
  WHERE source_ref_id IS NOT NULL AND status NOT IN ('rejected', 'completed');

-- 2. Add index for fast lookup of stuck/orphaned code requests
CREATE INDEX IF NOT EXISTS idx_code_requests_stuck
  ON code_requests(status, created_at)
  WHERE status IN ('confirmed', 'dispatched') AND session_id IS NULL;

-- 3. Track dispatch failures so they can be retried
ALTER TABLE code_requests ADD COLUMN IF NOT EXISTS dispatch_attempts INT DEFAULT 0;
ALTER TABLE code_requests ADD COLUMN IF NOT EXISTS last_error TEXT;

-- 4. Index for session observation — include 'completing' status
CREATE INDEX IF NOT EXISTS idx_cc_sessions_health
  ON cc_sessions(status, started_at)
  WHERE status IN ('running', 'initializing', 'completing', 'queued');
