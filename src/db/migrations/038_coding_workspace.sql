-- 038: Coding workspace — code request tracking + parallel session hierarchy
--
-- code_requests bridges email/CRM/Cortex intake → Factory dispatch.
-- parent_session_id enables parallel session decomposition.

CREATE TABLE IF NOT EXISTS code_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source TEXT NOT NULL,                          -- 'gmail', 'crm', 'cortex', 'manual'
  source_ref_id TEXT,                            -- email_thread.id, client.id, etc.
  client_id UUID REFERENCES clients(id),
  project_id UUID REFERENCES projects(id),
  codebase_id UUID REFERENCES codebases(id),
  summary TEXT NOT NULL,
  raw_prompt TEXT,                               -- AI-generated factory prompt
  code_work_type TEXT,                           -- 'feature', 'bugfix', 'update', 'investigation'
  status TEXT DEFAULT 'pending',                 -- pending → confirmed → dispatched → completed → rejected
  session_id UUID REFERENCES cc_sessions(id),
  confidence NUMERIC(3,2),
  needs_confirmation BOOLEAN DEFAULT false,
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT now(),
  resolved_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_code_requests_status ON code_requests(status);
CREATE INDEX IF NOT EXISTS idx_code_requests_client ON code_requests(client_id);
CREATE INDEX IF NOT EXISTS idx_code_requests_source ON code_requests(source, source_ref_id);

-- Parent-child session tracking for parallel decomposition
ALTER TABLE cc_sessions ADD COLUMN IF NOT EXISTS parent_session_id UUID REFERENCES cc_sessions(id);
CREATE INDEX IF NOT EXISTS idx_cc_sessions_parent ON cc_sessions(parent_session_id) WHERE parent_session_id IS NOT NULL;
