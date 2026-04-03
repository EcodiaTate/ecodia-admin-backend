-- 022: Action Queue Decision Memory + Lifecycle Management
--
-- Transforms the action queue from a notification inbox into a genuine
-- decision-support system that learns from every approval and dismissal.
--
-- 1. action_decisions: tracks every approve/dismiss with structured reasons
--    and enables pattern-based suppression + priority adjustment
-- 2. default_expires_at: items that never expire = zombie queue
-- 3. resource_key: prevents concurrent execution against same resource

-- ─── Decision Memory Table ───────────────────────────────────────────
-- Every execute/dismiss creates a row. Aggregated for suppression + learning.

CREATE TABLE IF NOT EXISTS action_decisions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    action_id UUID NOT NULL REFERENCES action_queue(id) ON DELETE CASCADE,
    decision TEXT NOT NULL CHECK (decision IN ('executed', 'dismissed', 'expired')),
    -- Structured dismiss reasons (not free-text)
    reason_category TEXT CHECK (reason_category IN (
        'wrong_priority',   -- surfaced too high/low
        'wrong_sender',     -- don't care about this sender
        'wrong_action',     -- wrong action type suggested
        'bad_draft',        -- draft quality was poor
        'already_handled',  -- handled outside the system
        'not_relevant',     -- shouldn't have surfaced at all
        'other',            -- free-text fallback
        NULL                -- executed items don't need a reason
    )),
    reason_detail TEXT,     -- optional free-text (max value when reason_category = 'other')
    -- Snapshot of what was decided on (survives action_queue cleanup)
    source TEXT NOT NULL,
    action_type TEXT NOT NULL,
    sender_email TEXT,
    sender_name TEXT,
    priority_when_surfaced TEXT,
    title TEXT,
    -- Timing
    time_to_decision_seconds INT,  -- how long it sat in queue before decision
    created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_action_decisions_source_type
  ON action_decisions(source, action_type, decision);

CREATE INDEX IF NOT EXISTS idx_action_decisions_sender
  ON action_decisions(sender_email, decision)
  WHERE sender_email IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_action_decisions_recent
  ON action_decisions(created_at DESC);

-- Composite for suppression queries: "has this sender+type been dismissed N times?"
CREATE INDEX IF NOT EXISTS idx_action_decisions_suppression
  ON action_decisions(source, action_type, sender_email, decision, created_at DESC);

-- ─── Default Expiry ──────────────────────────────────────────────────
-- Items without explicit expiry now get a 48h default.
-- Existing NULL rows are left alone (migration is additive).
-- The service layer sets the default going forward.

-- ─── Resource Key ────────────────────────────────────────────────────
-- Identifies the target resource for conflict detection in batch execute.
-- e.g. "gmail:thread:abc123", "crm:lead:456", "xero:sync"

ALTER TABLE action_queue ADD COLUMN IF NOT EXISTS resource_key TEXT;

CREATE INDEX IF NOT EXISTS idx_action_queue_resource_key
  ON action_queue(resource_key)
  WHERE status = 'pending';
