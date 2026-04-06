-- ═══════════════════════════════════════════════════════════════════════
-- 043: Auto-Developer Social Intake
--
-- Extends code_requests to support multi-source social intake
-- (LinkedIn, Meta, Twitter/X) alongside existing Gmail path.
-- Stores channel-specific reply context so the system can notify
-- the original requester when work completes.
-- ═══════════════════════════════════════════════════════════════════════

-- reply_context stores channel-specific data needed to notify the requester
-- e.g. { "platform": "linkedin", "dmId": "...", "participantName": "..." }
ALTER TABLE code_requests ADD COLUMN IF NOT EXISTS reply_context JSONB DEFAULT '{}';

-- Index for looking up code requests by session_id (used by oversight close-the-loop)
CREATE INDEX IF NOT EXISTS idx_code_requests_session_id ON code_requests (session_id) WHERE session_id IS NOT NULL;

-- Index for source + status queries (dashboard, recovery)
CREATE INDEX IF NOT EXISTS idx_code_requests_source_status ON code_requests (source, status);
