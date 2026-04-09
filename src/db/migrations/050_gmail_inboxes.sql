-- Migration 050: gmail_inboxes table
-- Replaces GMAIL_INBOXES env var so the OS can add/remove inboxes itself via db_execute.

CREATE TABLE IF NOT EXISTS gmail_inboxes (
  email       TEXT PRIMARY KEY,
  enabled     BOOLEAN NOT NULL DEFAULT true,
  label       TEXT,                          -- optional human label e.g. 'main', 'code'
  added_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  notes       TEXT                           -- OS can annotate why this inbox is here
);

-- Seed from current known inboxes (safe to re-run — ON CONFLICT does nothing)
INSERT INTO gmail_inboxes (email, label) VALUES
  ('tate@ecodia.au', 'main'),
  ('code@ecodia.au', 'code')
ON CONFLICT (email) DO NOTHING;
