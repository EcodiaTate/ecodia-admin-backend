-- 027_cc_session_completing_status.sql
-- Add 'completing' transitional status to cc_sessions.
-- The close handler sets this immediately when a CC process exits, BEFORE any async
-- work (readline drain, error extraction, oversight pipeline). This prevents the
-- orphan-cleanup from falsely marking sessions as orphaned when PM2 restarts during
-- the close handler's async window.

ALTER TABLE cc_sessions DROP CONSTRAINT IF EXISTS cc_sessions_status_check;
ALTER TABLE cc_sessions ADD CONSTRAINT cc_sessions_status_check
    CHECK (status IN ('initializing','running','completing','awaiting_input','complete','error','queued','paused','stopped'));
