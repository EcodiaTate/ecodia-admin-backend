-- migrations/008_cc_factory.sql
-- CC Factory: extend cc_sessions for autonomous pipeline

ALTER TABLE cc_sessions
    ADD COLUMN IF NOT EXISTS codebase_id UUID REFERENCES codebases(id),
    ADD COLUMN IF NOT EXISTS pipeline_stage TEXT DEFAULT 'queued',
    ADD COLUMN IF NOT EXISTS context_bundle JSONB,
    ADD COLUMN IF NOT EXISTS files_changed TEXT[] DEFAULT '{}',
    ADD COLUMN IF NOT EXISTS commit_sha TEXT,
    ADD COLUMN IF NOT EXISTS deploy_status TEXT,
    ADD COLUMN IF NOT EXISTS confidence_score NUMERIC(3,2),
    ADD COLUMN IF NOT EXISTS trigger_source TEXT DEFAULT 'manual';

-- Add check constraints (safe to add separately)
ALTER TABLE cc_sessions DROP CONSTRAINT IF EXISTS cc_sessions_pipeline_stage_check;
ALTER TABLE cc_sessions ADD CONSTRAINT cc_sessions_pipeline_stage_check
    CHECK (pipeline_stage IN ('queued','context','executing','testing','deploying','complete','failed'));

ALTER TABLE cc_sessions DROP CONSTRAINT IF EXISTS cc_sessions_deploy_status_check;
ALTER TABLE cc_sessions ADD CONSTRAINT cc_sessions_deploy_status_check
    CHECK (deploy_status IS NULL OR deploy_status IN ('pending','deploying','deployed','failed','reverted'));

ALTER TABLE cc_sessions DROP CONSTRAINT IF EXISTS cc_sessions_trigger_source_check;
ALTER TABLE cc_sessions ADD CONSTRAINT cc_sessions_trigger_source_check
    CHECK (trigger_source IN ('manual','crm_stage','kg_insight','simula_proposal','thymos_incident','scheduled','cortex'));

-- Expand triggered_by to include new sources
ALTER TABLE cc_sessions DROP CONSTRAINT IF EXISTS cc_sessions_triggered_by_check;
ALTER TABLE cc_sessions ADD CONSTRAINT cc_sessions_triggered_by_check
    CHECK (triggered_by IN ('crm_stage','manual','task','simula','thymos','scheduled','cortex'));

-- Expand status to include pipeline states
ALTER TABLE cc_sessions DROP CONSTRAINT IF EXISTS cc_sessions_status_check;
ALTER TABLE cc_sessions ADD CONSTRAINT cc_sessions_status_check
    CHECK (status IN ('initializing','running','awaiting_input','complete','error','queued'));

CREATE INDEX IF NOT EXISTS idx_cc_sessions_codebase ON cc_sessions(codebase_id);
CREATE INDEX IF NOT EXISTS idx_cc_sessions_pipeline ON cc_sessions(pipeline_stage) WHERE pipeline_stage NOT IN ('complete','failed');
CREATE INDEX IF NOT EXISTS idx_cc_sessions_trigger ON cc_sessions(trigger_source);
