-- 034: Link Factory sessions to goals they're pursuing.
-- This closes the feedback loop: the maintenance mind dispatches sessions
-- for goals, and now the system can track which sessions advanced which goals.

ALTER TABLE cc_sessions ADD COLUMN IF NOT EXISTS goal_id INTEGER REFERENCES organism_goals(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_cc_sessions_goal_id ON cc_sessions (goal_id) WHERE goal_id IS NOT NULL;
