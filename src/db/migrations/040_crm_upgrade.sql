-- 040: CRM Upgrade — Full client intelligence system
--
-- Transforms CRM from pipeline-only to a unified hub connecting
-- emails, tasks, coding sessions, bookkeeping, and social channels.

-- ═══════════════════════════════════════════════════════════════════
-- 1. Activity Log — unified timeline of ALL client interactions
-- ═══════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS crm_activity_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  project_id UUID REFERENCES projects(id),
  activity_type TEXT NOT NULL,           -- 'email_sent', 'email_received', 'note_added', 'stage_changed',
                                         -- 'task_created', 'task_completed', 'session_dispatched', 'session_completed',
                                         -- 'invoice_sent', 'payment_received', 'meeting', 'call', 'social_interaction',
                                         -- 'code_request', 'deployment', 'proposal_sent', 'contract_signed'
  title TEXT NOT NULL,
  description TEXT,
  source TEXT NOT NULL DEFAULT 'manual', -- 'gmail', 'linkedin', 'meta', 'factory', 'bookkeeping', 'cortex', 'manual', 'crm'
  source_ref_id TEXT,                    -- FK to the source entity (email_thread.id, task.id, cc_session.id, etc.)
  source_ref_type TEXT,                  -- 'email_thread', 'task', 'cc_session', 'transaction', 'code_request', etc.
  actor TEXT,                            -- who performed: 'system', 'ai', 'human', client name
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_crm_activity_client ON crm_activity_log(client_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_crm_activity_type ON crm_activity_log(activity_type);
CREATE INDEX IF NOT EXISTS idx_crm_activity_source ON crm_activity_log(source, source_ref_id);

-- ═══════════════════════════════════════════════════════════════════
-- 2. Contacts — multiple people per client/company
-- ═══════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS crm_contacts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  role TEXT,                              -- 'decision_maker', 'technical', 'billing', 'general'
  email TEXT,
  phone TEXT,
  linkedin_url TEXT,
  is_primary BOOLEAN DEFAULT false,
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_crm_contacts_client ON crm_contacts(client_id);
CREATE INDEX IF NOT EXISTS idx_crm_contacts_email ON crm_contacts(email) WHERE email IS NOT NULL;

-- ═══════════════════════════════════════════════════════════════════
-- 3. Enhance projects with deal/contract tracking
-- ═══════════════════════════════════════════════════════════════════
ALTER TABLE projects ADD COLUMN IF NOT EXISTS deal_value_aud NUMERIC(12,2);
ALTER TABLE projects ADD COLUMN IF NOT EXISTS contract_date DATE;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS estimated_hours NUMERIC(8,1);
ALTER TABLE projects ADD COLUMN IF NOT EXISTS actual_hours_logged NUMERIC(8,1) DEFAULT 0;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS payment_status TEXT DEFAULT 'none';  -- 'none', 'invoiced', 'partial', 'paid', 'overdue'
ALTER TABLE projects ADD COLUMN IF NOT EXISTS invoice_ref TEXT;                     -- Xero/manual invoice reference

-- ═══════════════════════════════════════════════════════════════════
-- 4. Enhance clients with relationship intelligence
-- ═══════════════════════════════════════════════════════════════════
ALTER TABLE clients ADD COLUMN IF NOT EXISTS source TEXT;                  -- 'linkedin', 'gmail', 'referral', 'website', 'manual'
ALTER TABLE clients ADD COLUMN IF NOT EXISTS first_contact_at TIMESTAMPTZ;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS last_contact_at TIMESTAMPTZ;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS total_revenue_aud NUMERIC(12,2) DEFAULT 0;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS lifetime_sessions INT DEFAULT 0;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS health_score NUMERIC(3,2);    -- 0-1, AI-computed client health

-- ═══════════════════════════════════════════════════════════════════
-- 5. Enhance tasks with completion tracking
-- ═══════════════════════════════════════════════════════════════════
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS completed_at TIMESTAMPTZ;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS completed_by TEXT;               -- 'ai', 'human', 'system'

-- ═══════════════════════════════════════════════════════════════════
-- 6. Indexes for cross-system queries
-- ═══════════════════════════════════════════════════════════════════
CREATE INDEX IF NOT EXISTS idx_email_threads_client_recent ON email_threads(client_id, received_at DESC) WHERE client_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_tasks_client ON tasks(client_id) WHERE client_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status, completed_at);
CREATE INDEX IF NOT EXISTS idx_projects_payment ON projects(payment_status) WHERE payment_status != 'none';
