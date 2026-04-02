-- 013: Unified Action Queue
-- Pre-processed actionable items from all integrations, surfaced for one-tap approval

CREATE TABLE action_queue (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    source TEXT NOT NULL,                    -- gmail, linkedin, meta, calendar, crm, factory, cortex
    source_ref_id TEXT,                      -- FK to the source record (thread id, dm id, etc)
    action_type TEXT NOT NULL,               -- send_reply, archive, create_lead, follow_up, publish_post, send_message, schedule_meeting, create_task
    title TEXT NOT NULL,                     -- short display title
    summary TEXT,                            -- AI-generated one-liner of what this is about
    prepared_data JSONB DEFAULT '{}',        -- pre-filled data (draft reply, CRM fields, post content, etc)
    context JSONB DEFAULT '{}',             -- supporting info (sender, thread subject, lead score, etc)
    priority TEXT DEFAULT 'medium' CHECK (priority IN ('low', 'medium', 'high', 'urgent')),
    status TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'dismissed', 'expired', 'executed')),
    approved_at TIMESTAMPTZ,
    executed_at TIMESTAMPTZ,
    error_message TEXT,
    expires_at TIMESTAMPTZ,                  -- auto-expire stale actions
    created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_action_queue_status ON action_queue(status) WHERE status = 'pending';
CREATE INDEX idx_action_queue_priority ON action_queue(priority, created_at DESC);
CREATE INDEX idx_action_queue_source ON action_queue(source);
CREATE INDEX idx_action_queue_expires ON action_queue(expires_at) WHERE status = 'pending';
