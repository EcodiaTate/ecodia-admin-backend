-- migrations/025_cc_session_resume.sql
-- CC sessions: support pause/resume and concurrent sessions
-- Adds 'paused'/'stopped' statuses + stores the CC CLI session ID so we can --resume

-- Store the CC CLI's own session ID (different from our DB UUID)
ALTER TABLE cc_sessions ADD COLUMN IF NOT EXISTS cc_cli_session_id TEXT;

-- Expand status constraint to include paused and stopped
ALTER TABLE cc_sessions DROP CONSTRAINT IF EXISTS cc_sessions_status_check;
ALTER TABLE cc_sessions ADD CONSTRAINT cc_sessions_status_check
    CHECK (status IN ('initializing','running','awaiting_input','complete','error','queued','paused','stopped'));

CREATE INDEX IF NOT EXISTS idx_cc_sessions_cli_id ON cc_sessions(cc_cli_session_id) WHERE cc_cli_session_id IS NOT NULL;
