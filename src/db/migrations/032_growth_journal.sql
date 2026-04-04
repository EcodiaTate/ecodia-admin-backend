-- Growth Journal — the organism's experiment log.
-- Not learnings (post-hoc patterns from sessions), not reflections (inner monologue).
-- These are deliberate hypotheses the system proposes, tracks, and resolves.

CREATE TABLE IF NOT EXISTS growth_journal (
  id            SERIAL PRIMARY KEY,
  entry_type    TEXT NOT NULL CHECK (entry_type IN ('experiment', 'insight', 'aspiration')),
  title         TEXT NOT NULL,
  body          TEXT NOT NULL,
  hypothesis    TEXT,                        -- for experiments: what we expect to happen
  outcome       TEXT,                        -- filled in when resolved
  status        TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'active', 'resolved', 'abandoned')),
  source        TEXT NOT NULL DEFAULT 'maintenance_loop',  -- what proposed it
  metadata      JSONB DEFAULT '{}',
  created_at    TIMESTAMPTZ DEFAULT now(),
  resolved_at   TIMESTAMPTZ,
  updated_at    TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_growth_journal_status ON growth_journal(status);
CREATE INDEX IF NOT EXISTS idx_growth_journal_type ON growth_journal(entry_type);
CREATE INDEX IF NOT EXISTS idx_growth_journal_created ON growth_journal(created_at DESC);
