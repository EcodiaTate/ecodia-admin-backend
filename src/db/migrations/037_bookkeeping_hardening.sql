-- ════════════��═════════════════════════════���════════════════════════════
-- BOOKKEEPING HARDENING: GST fixes, equity, period locking, audit,
-- receipt linking, CRM integration, rule learning
-- ═══════════════════════════════════════════════════════════════════════

-- ── Fix international supplier GST treatment ──
-- These are all overseas companies — they don't charge GST
UPDATE supplier_rules SET gst_treatment = 'gst_free' WHERE pattern IN (
  'vercel', 'supabase', 'claude ai|anthropic', 'openai|chatgpt',
  'google cloud|gcp', 'macincloud', 'aws|amazon web services', 'resend',
  'meta|facebook|facebk|instagram', 'linkedin', 'google\*play',
  'digitalocean|droplet', 'apple\.com/bill'
);
-- Google Workspace (AU entity) and Stripe (AU entity) stay gst_inclusive
-- Canva (AU entity) stays gst_inclusive

-- ── Add equity accounts ──
INSERT INTO gl_accounts (code, name, type) VALUES
  ('3100', 'Retained Earnings', 'equity'),
  ('3200', 'Current Year Earnings', 'equity'),
  ('5045', 'Bank Fees', 'expense'),
  ('5050', 'Food & Entertainment', 'expense')
ON CONFLICT (code) DO NOTHING;

-- ── Bank fees rule ──
INSERT INTO supplier_rules (pattern, supplier_name, account_code, gst_treatment, tags) VALUES
  ('monthly account fee', 'Bank Australia Fee', '5045', 'gst_free', '["bank_fee"]'),
  ('int tran fee|intl fee|international transaction', 'Bank Intl Fee', '5045', 'gst_free', '["bank_fee","international"]')
ON CONFLICT DO NOTHING;

-- ── Period locking ──
CREATE TABLE IF NOT EXISTS accounting_periods (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  period_start DATE NOT NULL,
  period_end   DATE NOT NULL,
  status       TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'locked', 'closed')),
  locked_at    TIMESTAMPTZ,
  locked_by    TEXT,
  UNIQUE(period_start, period_end)
);

-- ── Audit log ──
CREATE TABLE IF NOT EXISTS audit_log (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_type TEXT NOT NULL,
  entity_id   TEXT NOT NULL,
  action      TEXT NOT NULL,
  changed_by  TEXT NOT NULL DEFAULT 'system',
  old_values  JSONB,
  new_values  JSONB,
  created_at  TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_audit_entity ON audit_log(entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_audit_time ON audit_log(created_at DESC);

-- ── Rule learning source ──
ALTER TABLE supplier_rules ADD COLUMN IF NOT EXISTS learning_source TEXT DEFAULT 'seeded';
-- seeded = migration, ai_learned = AI created, human_set = human created

-- ── Duplicate tracking ──
ALTER TABLE staged_transactions ADD COLUMN IF NOT EXISTS duplicate_of UUID;

-- ── CRM linking on ledger transactions ──
ALTER TABLE ledger_transactions ADD COLUMN IF NOT EXISTS client_id UUID;
ALTER TABLE ledger_transactions ADD COLUMN IF NOT EXISTS project_id UUID;
ALTER TABLE staged_transactions ADD COLUMN IF NOT EXISTS client_id UUID;
ALTER TABLE staged_transactions ADD COLUMN IF NOT EXISTS project_id UUID;

-- ── Receipt linking ──
-- bk_receipts table already exists from 034, add linkage fields if missing
ALTER TABLE staged_transactions ADD COLUMN IF NOT EXISTS receipt_id UUID;

-- ── Receipt metadata improvements ──
DO $$ BEGIN
  ALTER TABLE bk_receipts ADD COLUMN IF NOT EXISTS client_id UUID;
  ALTER TABLE bk_receipts ADD COLUMN IF NOT EXISTS project_id UUID;
  ALTER TABLE bk_receipts ADD COLUMN IF NOT EXISTS gmail_thread_id TEXT;
  ALTER TABLE bk_receipts ADD COLUMN IF NOT EXISTS amount_cents INTEGER;
  ALTER TABLE bk_receipts ADD COLUMN IF NOT EXISTS matched_staged_id UUID;
  ALTER TABLE bk_receipts ADD COLUMN IF NOT EXISTS matched_ledger_id UUID;
EXCEPTION WHEN OTHERS THEN NULL; END $$;

-- Create bk_receipts if it doesn't exist (it may not have been created)
CREATE TABLE IF NOT EXISTS bk_receipts (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_email         TEXT,
  email_message_id     TEXT,
  email_subject        TEXT,
  email_from           TEXT,
  email_date           TIMESTAMPTZ,
  gmail_thread_id      TEXT,
  supplier_name        TEXT,
  supplier_abn         TEXT,
  receipt_date         DATE,
  total_amount_cents   INTEGER,
  amount_cents         INTEGER,
  gst_amount_cents     INTEGER,
  currency             TEXT DEFAULT 'AUD',
  receipt_number       TEXT,
  file_path            TEXT,
  file_type            TEXT,
  ocr_raw              TEXT,
  client_id            UUID,
  project_id           UUID,
  matched_staged_id    UUID,
  matched_ledger_id    UUID,
  matched_transaction_id UUID,
  match_confidence     REAL,
  status               TEXT DEFAULT 'extracted' CHECK (status IN ('extracted','matched','unmatched','ignored')),
  created_at           TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_receipts_status ON bk_receipts(status);
CREATE INDEX IF NOT EXISTS idx_receipts_supplier ON bk_receipts(supplier_name);
CREATE INDEX IF NOT EXISTS idx_receipts_date ON bk_receipts(receipt_date);

-- ── Bank reconciliation snapshots ──
CREATE TABLE IF NOT EXISTS bank_reconciliation (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_code  TEXT NOT NULL DEFAULT '1000',
  as_of_date    DATE NOT NULL,
  bank_balance  INTEGER NOT NULL,
  ledger_balance INTEGER NOT NULL,
  difference    INTEGER NOT NULL,
  status        TEXT DEFAULT 'unreconciled' CHECK (status IN ('reconciled', 'unreconciled', 'investigating')),
  notes         TEXT,
  created_at    TIMESTAMPTZ DEFAULT now()
);
