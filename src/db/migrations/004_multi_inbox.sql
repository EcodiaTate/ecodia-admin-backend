-- Add inbox column to track which account an email came from
ALTER TABLE email_threads ADD COLUMN IF NOT EXISTS inbox TEXT DEFAULT 'code@ecodia.au';
CREATE INDEX IF NOT EXISTS idx_email_threads_inbox ON email_threads(inbox);

-- Change gmail_sync_state to use inbox as primary key instead of serial
-- Drop old table and recreate with text PK for per-inbox tracking
DROP TABLE IF EXISTS gmail_sync_state;
CREATE TABLE gmail_sync_state (
    id          TEXT PRIMARY KEY,  -- inbox email address
    history_id  TEXT NOT NULL,
    updated_at  TIMESTAMPTZ DEFAULT now()
);
