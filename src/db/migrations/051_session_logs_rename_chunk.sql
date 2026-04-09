-- Rename cc_session_logs.chunk → content to match code references
ALTER TABLE cc_session_logs RENAME COLUMN chunk TO content;
