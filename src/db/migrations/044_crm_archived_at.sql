-- 044: Ensure all CRM columns exist (schema drift fix)
--
-- The VPS database was missing columns from migrations 001 and 040 due to
-- schema drift (VPS table created with different columns than migration files).
-- This ensures all columns referenced by CRM code exist.

-- ─── clients table ───────────────────────────────────────────────────
ALTER TABLE clients ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS source TEXT;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS first_contact_at TIMESTAMPTZ;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS last_contact_at TIMESTAMPTZ;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS total_revenue_aud NUMERIC(12,2) DEFAULT 0;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS lifetime_sessions INT DEFAULT 0;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS health_score NUMERIC(3,2);

-- ─── projects table ──────────────────────────────────────────────────
ALTER TABLE projects ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS budget_aud NUMERIC(10,2);
ALTER TABLE projects ADD COLUMN IF NOT EXISTS hourly_rate NUMERIC(8,2);
ALTER TABLE projects ADD COLUMN IF NOT EXISTS deal_value_aud NUMERIC(12,2);
ALTER TABLE projects ADD COLUMN IF NOT EXISTS contract_date DATE;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS estimated_hours NUMERIC(8,1);
ALTER TABLE projects ADD COLUMN IF NOT EXISTS actual_hours_logged NUMERIC(8,1) DEFAULT 0;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS payment_status TEXT DEFAULT 'none';
ALTER TABLE projects ADD COLUMN IF NOT EXISTS invoice_ref TEXT;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS repo_url TEXT;

-- ─── tasks table ─────────────────────────────────────────────────────
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS completed_at TIMESTAMPTZ;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS completed_by TEXT;

-- ─── CRM tables (from 040) ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS crm_activity_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  project_id UUID REFERENCES projects(id),
  activity_type TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT,
  source TEXT NOT NULL DEFAULT 'manual',
  source_ref_id TEXT,
  source_ref_type TEXT,
  actor TEXT,
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS crm_contacts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  role TEXT,
  email TEXT,
  phone TEXT,
  linkedin_url TEXT,
  is_primary BOOLEAN DEFAULT false,
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- ─── Indexes ─────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_crm_activity_client ON crm_activity_log(client_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_crm_activity_type ON crm_activity_log(activity_type);
CREATE INDEX IF NOT EXISTS idx_crm_activity_source ON crm_activity_log(source, source_ref_id);
CREATE INDEX IF NOT EXISTS idx_crm_contacts_client ON crm_contacts(client_id);
CREATE INDEX IF NOT EXISTS idx_crm_contacts_email ON crm_contacts(email) WHERE email IS NOT NULL;
