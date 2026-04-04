-- Outcome tracking: close the feedback loop.
-- After a Factory session deploys a fix, the system checks 24h later
-- whether the error it targeted actually went away. This feeds back
-- into learning confidence — verified fixes get boosted, ineffective
-- ones get demoted. Without this, learnings are based on LLM vibes,
-- not observed reality.

-- Track which error pattern a session was targeting (extracted from prompt)
ALTER TABLE cc_sessions
  ADD COLUMN IF NOT EXISTS target_error_pattern TEXT;

-- Outcome verification on factory_learnings
ALTER TABLE factory_learnings
  ADD COLUMN IF NOT EXISTS outcome_status TEXT DEFAULT 'pending'
    CHECK (outcome_status IN ('pending', 'verified_effective', 'verified_ineffective', 'skipped')),
  ADD COLUMN IF NOT EXISTS outcome_verified_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS errors_before INT,
  ADD COLUMN IF NOT EXISTS errors_after INT;

-- Track which learning was applied to which session (bidirectional link)
ALTER TABLE cc_sessions
  ADD COLUMN IF NOT EXISTS applied_learning_ids UUID[] DEFAULT '{}';
