-- 047: Action Feedback — post-decision quality signals
--
-- Extends the decision loop beyond approve/dismiss into quality feedback.
-- After executing an action, the user can rate the quality of the AI's work
-- (draft quality, priority accuracy, relevance). This feeds back into triage
-- calibration so the AI improves over time.
--
-- Also adds a recalibration_signals view for per-(source, action_type) performance.

CREATE TABLE IF NOT EXISTS action_feedback (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    action_id UUID NOT NULL REFERENCES action_queue(id) ON DELETE CASCADE,
    decision_id UUID REFERENCES action_decisions(id) ON DELETE SET NULL,
    -- Quality signals (1-5 scale, null = not rated)
    draft_quality INT CHECK (draft_quality BETWEEN 1 AND 5),
    priority_accuracy INT CHECK (priority_accuracy BETWEEN 1 AND 5),
    relevance INT CHECK (relevance BETWEEN 1 AND 5),
    -- Overall satisfaction
    overall INT CHECK (overall BETWEEN 1 AND 5),
    -- Free-form correction (e.g. "the draft should have been more formal")
    correction TEXT,
    -- Snapshot for analysis (survives action_queue cleanup)
    source TEXT NOT NULL,
    action_type TEXT NOT NULL,
    sender_email TEXT,
    sender_name TEXT,
    created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_action_feedback_action
  ON action_feedback(action_id);

CREATE INDEX IF NOT EXISTS idx_action_feedback_source_type
  ON action_feedback(source, action_type, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_action_feedback_sender
  ON action_feedback(sender_email, created_at DESC)
  WHERE sender_email IS NOT NULL;
