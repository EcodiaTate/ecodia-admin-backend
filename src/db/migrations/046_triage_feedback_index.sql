-- 046: Triage Feedback Loop — sender_name index for decision intelligence
-- The getTriageContext() function queries action_decisions by sender_name
-- when sender_email is unavailable (common for LinkedIn DMs, Meta conversations).
-- The existing idx_action_decisions_sender only covers sender_email.

CREATE INDEX IF NOT EXISTS idx_action_decisions_sender_name
  ON action_decisions(sender_name, decision, created_at DESC)
  WHERE sender_name IS NOT NULL;
