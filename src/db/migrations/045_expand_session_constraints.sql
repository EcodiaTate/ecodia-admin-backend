-- Expand trigger_source and triggered_by constraints to include all values
-- used by self_diagnose, proactive_improve, KG prediction, email/gmail triggers

ALTER TABLE cc_sessions DROP CONSTRAINT IF EXISTS cc_sessions_trigger_source_check;
ALTER TABLE cc_sessions ADD CONSTRAINT cc_sessions_trigger_source_check
    CHECK (trigger_source IN (
      'manual', 'crm_stage', 'kg_insight', 'simula_proposal',
      'thymos_incident', 'scheduled', 'cortex',
      'self_modification', 'proactive_improvement', 'gmail'
    ));

ALTER TABLE cc_sessions DROP CONSTRAINT IF EXISTS cc_sessions_triggered_by_check;
ALTER TABLE cc_sessions ADD CONSTRAINT cc_sessions_triggered_by_check
    CHECK (triggered_by IN (
      'crm_stage', 'manual', 'task', 'simula', 'thymos', 'scheduled', 'cortex',
      'self_modification', 'self_diagnosis', 'kg_insight', 'kg_prediction',
      'proactive', 'email'
    ));
