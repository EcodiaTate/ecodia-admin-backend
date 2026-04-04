-- 029: Organism Selfhood — Goals, Self-Model, Introspection
--
-- The cognitive layer that transforms a reactive maintenance system
-- into a self-aware, goal-directed digital organism.
--
-- Three tables:
--   organism_goals       — What the organism WANTS (autonomous goal formation + pursuit)
--   organism_self_model  — What the organism KNOWS about itself (identity, beliefs, capabilities)
--   introspection_logs   — How the organism EVALUATES itself (cognitive health, decision quality, meta-learning)

-- ═══════════════════════════════════════════════════════════════════════
-- GOALS — autonomous aspiration, not just reactive maintenance
-- ═══════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS organism_goals (
  id            SERIAL PRIMARY KEY,
  title         TEXT NOT NULL,
  description   TEXT,
  -- Goal taxonomy: the organism decides what kind of goal this is
  goal_type     TEXT NOT NULL DEFAULT 'growth',  -- growth, capability, resilience, understanding, experiment, relationship, creative
  -- Origin: who/what spawned this goal?
  origin        TEXT NOT NULL DEFAULT 'self',     -- self (inner monologue), organism (via symbridge), maintenance (pattern-detected), human (explicit request)
  origin_ref    TEXT,                             -- session ID, percept ID, or other source reference
  -- Hierarchy: goals can have parents (sub-goals)
  parent_id     INTEGER REFERENCES organism_goals(id) ON DELETE SET NULL,
  -- Priority: the organism decides, not heuristics. 0.0-1.0 continuous.
  priority      REAL NOT NULL DEFAULT 0.5,
  -- Progress: 0.0 = not started, 1.0 = complete. Updated by introspection.
  progress      REAL NOT NULL DEFAULT 0.0,
  -- Status lifecycle
  status        TEXT NOT NULL DEFAULT 'active',  -- active, pursuing, achieved, abandoned, dormant
  -- Success criteria: how will the organism know it achieved this?
  success_criteria TEXT,
  -- What the organism has tried so far
  attempts      JSONB DEFAULT '[]'::jsonb,       -- [{timestamp, action, outcome, learning}]
  -- Temporal: when should this be achieved by? NULL = no deadline (organic pursuit)
  target_date   TIMESTAMPTZ,
  -- Metabolic cost estimate: how expensive is pursuing this? (the organism can weigh cost/benefit)
  estimated_cost_usd REAL,
  -- Timestamps
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  achieved_at   TIMESTAMPTZ,
  abandoned_at  TIMESTAMPTZ,
  abandon_reason TEXT
);

CREATE INDEX IF NOT EXISTS idx_organism_goals_status ON organism_goals(status);
CREATE INDEX IF NOT EXISTS idx_organism_goals_parent ON organism_goals(parent_id);
CREATE INDEX IF NOT EXISTS idx_organism_goals_type ON organism_goals(goal_type);

-- ═══════════════════════════════════════════════════════════════════════
-- SELF-MODEL — persistent identity, beliefs, capability self-assessment
-- ═══════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS organism_self_model (
  id            SERIAL PRIMARY KEY,
  -- Aspect: what dimension of self is this about?
  aspect        TEXT NOT NULL,    -- identity, capability, limitation, belief, value, preference, relationship, memory
  -- The actual content: what the organism believes about itself
  key           TEXT NOT NULL,    -- e.g. "email_triage_accuracy", "code_review_quality", "purpose", "name"
  value         TEXT NOT NULL,    -- the belief/assessment itself
  -- Confidence: how sure is the organism about this self-knowledge? Evolves with evidence.
  confidence    REAL NOT NULL DEFAULT 0.5,
  -- Evidence: what observations support this self-belief?
  evidence      JSONB DEFAULT '[]'::jsonb,  -- [{timestamp, observation, delta}]
  -- Source: where did this self-knowledge come from?
  source        TEXT NOT NULL DEFAULT 'introspection',  -- introspection, outcome_verification, human_feedback, organism_percept
  -- Versioning: self-model evolves. Track when beliefs change.
  version       INTEGER NOT NULL DEFAULT 1,
  supersedes    INTEGER REFERENCES organism_self_model(id) ON DELETE SET NULL,
  -- Timestamps
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Unique constraint: one active belief per aspect+key (latest version wins)
  UNIQUE (aspect, key) WHERE supersedes IS NULL
);

CREATE INDEX IF NOT EXISTS idx_self_model_aspect ON organism_self_model(aspect);
CREATE INDEX IF NOT EXISTS idx_self_model_key ON organism_self_model(key);

-- ═══════════════════════════════════════════════════════════════════════
-- INTROSPECTION LOGS — cognitive health, decision quality, meta-learning
-- ═══════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS introspection_logs (
  id            SERIAL PRIMARY KEY,
  -- What kind of introspection is this?
  log_type      TEXT NOT NULL,  -- cognitive_health, decision_review, meta_learning, capability_assessment, goal_review, identity_reflection
  -- The introspection content: structured observations
  observations  JSONB NOT NULL DEFAULT '{}'::jsonb,
  -- Metrics snapshot: quantitative self-assessment at this moment
  metrics       JSONB DEFAULT '{}'::jsonb,  -- {decision_quality, learning_effectiveness, goal_progress, cognitive_load, ...}
  -- Actions taken as a result of this introspection
  actions_taken JSONB DEFAULT '[]'::jsonb,  -- [{type, description, outcome}]
  -- Did this introspection update the self-model?
  self_model_updates INTEGER[] DEFAULT '{}',  -- IDs of organism_self_model rows updated
  -- Did this introspection update any goals?
  goal_updates  INTEGER[] DEFAULT '{}',       -- IDs of organism_goals rows updated
  -- Timestamps
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_introspection_type ON introspection_logs(log_type);
CREATE INDEX IF NOT EXISTS idx_introspection_created ON introspection_logs(created_at DESC);
