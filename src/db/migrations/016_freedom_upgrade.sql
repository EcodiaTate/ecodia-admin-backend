-- ═══════════════════════════════════════════════════════════════════════
-- 016: Freedom Upgrade — The Cambrian Explosion
--
-- Cross-session learning, validation outcome tracking, direct action
-- audit trail, internal event bus audit log.
-- ═══════════════════════════════════════════════════════════════════════

-- Cross-session learning: Factory remembers what worked and what didn't
CREATE TABLE IF NOT EXISTS factory_learnings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  codebase_id UUID REFERENCES codebases(id),
  pattern_type TEXT NOT NULL,
  pattern_description TEXT NOT NULL,
  evidence JSONB DEFAULT '{}',
  confidence NUMERIC(3,2) DEFAULT 0.50,
  success BOOLEAN,
  session_ids UUID[] DEFAULT '{}',
  times_applied INT DEFAULT 0,
  last_applied_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_factory_learnings_codebase ON factory_learnings(codebase_id);
CREATE INDEX IF NOT EXISTS idx_factory_learnings_type ON factory_learnings(pattern_type);
CREATE INDEX IF NOT EXISTS idx_factory_learnings_confidence ON factory_learnings(confidence DESC);

-- Validation outcome tracking: learn from deploy results
ALTER TABLE validation_runs ADD COLUMN IF NOT EXISTS outcome TEXT;
ALTER TABLE validation_runs ADD COLUMN IF NOT EXISTS outcome_at TIMESTAMPTZ;

-- Self-modification flag on CC sessions
ALTER TABLE cc_sessions ADD COLUMN IF NOT EXISTS self_modification BOOLEAN DEFAULT false;

-- Direct action audit trail: organism → integration without CC sessions
CREATE TABLE IF NOT EXISTS direct_actions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  action_type TEXT NOT NULL,
  params JSONB NOT NULL DEFAULT '{}',
  result JSONB,
  status TEXT NOT NULL DEFAULT 'pending',
  requested_by TEXT NOT NULL DEFAULT 'organism',
  correlation_id TEXT,
  duration_ms INT,
  created_at TIMESTAMPTZ DEFAULT now(),
  completed_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_direct_actions_type ON direct_actions(action_type);
CREATE INDEX IF NOT EXISTS idx_direct_actions_status ON direct_actions(status);

-- Internal event bus audit log: optional persistence for debugging
CREATE TABLE IF NOT EXISTS event_bus_log (
  id BIGSERIAL PRIMARY KEY,
  event_type TEXT NOT NULL,
  payload JSONB DEFAULT '{}',
  source_service TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_event_bus_log_type ON event_bus_log(event_type);
CREATE INDEX IF NOT EXISTS idx_event_bus_log_created ON event_bus_log(created_at DESC);
