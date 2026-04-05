-- ═══════════════════════════════════════════════════════════════════════
-- BOOKKEEPING: Double-entry ledger for Ecodia Pty Ltd
-- Runs alongside existing `transactions` table (Xero feed).
-- This adds proper GL accounts, journal entries, BAS/GST, director loan.
-- ═══════════════════════════════════════════════════════════════════════

-- Chart of accounts
CREATE TABLE IF NOT EXISTS gl_accounts (
    code        TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    type        TEXT NOT NULL CHECK (type IN ('asset','liability','income','expense','equity'))
);

-- Staged transactions (CSV imports + Xero feed before posting to ledger)
CREATE TABLE IF NOT EXISTS staged_transactions (
    id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    source               TEXT NOT NULL CHECK (source IN ('xero','csv','stripe','manual')),
    source_ref           TEXT UNIQUE NOT NULL,
    occurred_at          DATE NOT NULL,
    amount_cents         INTEGER NOT NULL,
    description          TEXT NOT NULL,
    long_description     TEXT,
    transaction_type     TEXT,
    status               TEXT NOT NULL DEFAULT 'pending'
                         CHECK (status IN ('pending','categorized','posted','flagged','ignored')),
    category             TEXT,
    subcategory          TEXT,
    is_personal          BOOLEAN,
    is_gst_inclusive     BOOLEAN DEFAULT TRUE,
    gst_amount_cents     INTEGER,
    matched_receipt_id   UUID,
    ledger_tx_id         UUID,
    confidence           REAL,
    categorizer_reasoning TEXT,
    reviewed_at          TIMESTAMPTZ,
    reviewed_by          TEXT,
    created_at           TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_staged_status ON staged_transactions(status);
CREATE INDEX IF NOT EXISTS idx_staged_date ON staged_transactions(occurred_at);

-- Ledger transactions (journal entries)
CREATE TABLE IF NOT EXISTS ledger_transactions (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    occurred_at       DATE NOT NULL,
    description       TEXT NOT NULL,
    source_system     TEXT NOT NULL CHECK (source_system IN ('manual','stripe','xero','csv_import','auto')),
    source_ref        TEXT,
    tags              JSONB DEFAULT '[]',
    supplier          TEXT,
    evidence_file     TEXT,
    evidence_url      TEXT,
    recorded_at       TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_ledger_tx_date ON ledger_transactions(occurred_at);

-- Ledger lines (double-entry: every tx has ≥2 lines that balance)
CREATE TABLE IF NOT EXISTS ledger_lines (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tx_id             UUID NOT NULL REFERENCES ledger_transactions(id) ON DELETE CASCADE,
    account_code      TEXT NOT NULL REFERENCES gl_accounts(code),
    debit_cents       INTEGER DEFAULT 0,
    credit_cents      INTEGER DEFAULT 0,
    currency          TEXT DEFAULT 'AUD',
    tax_code          TEXT,
    tax_amount_cents  INTEGER,
    memo              TEXT
);
CREATE INDEX IF NOT EXISTS idx_ledger_lines_tx ON ledger_lines(tx_id);
CREATE INDEX IF NOT EXISTS idx_ledger_lines_account ON ledger_lines(account_code);

-- Receipts (OCR'd from Gmail attachments)
CREATE TABLE IF NOT EXISTS bk_receipts (
    id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    source_email         TEXT NOT NULL,
    email_message_id     TEXT UNIQUE NOT NULL,
    email_subject        TEXT,
    email_from           TEXT,
    email_date           TIMESTAMPTZ,
    supplier_name        TEXT,
    supplier_abn         TEXT,
    receipt_date         DATE,
    total_amount_cents   INTEGER,
    gst_amount_cents     INTEGER,
    currency             TEXT DEFAULT 'AUD',
    receipt_number       TEXT,
    file_path            TEXT,
    file_type            TEXT,
    ocr_raw              TEXT,
    matched_transaction_id UUID,
    match_confidence     REAL,
    status               TEXT DEFAULT 'extracted'
                         CHECK (status IN ('extracted','matched','unmatched','ignored')),
    created_at           TIMESTAMPTZ DEFAULT NOW()
);

-- Supplier categorization rules
CREATE TABLE IF NOT EXISTS supplier_rules (
    id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    pattern          TEXT NOT NULL,
    supplier_name    TEXT NOT NULL,
    account_code     TEXT NOT NULL,
    is_personal      BOOLEAN DEFAULT FALSE,
    is_business      BOOLEAN DEFAULT TRUE,
    needs_review     BOOLEAN DEFAULT FALSE,
    gst_treatment    TEXT DEFAULT 'gst_inclusive',
    tags             JSONB DEFAULT '[]'
);

-- Seed chart of accounts
INSERT INTO gl_accounts (code, name, type) VALUES
    ('1000', 'Bank (Operating)', 'asset'),
    ('1100', 'Stripe Clearing', 'asset'),
    ('1200', 'Accounts Receivable', 'asset'),
    ('2110', 'GST Paid (Input Tax Credits)', 'asset'),
    ('2100', 'Director Loan', 'liability'),
    ('2120', 'GST Collected', 'liability'),
    ('2200', 'Unearned Income (Deposit)', 'liability'),
    ('3000', 'Payable to Ecodia Labs (Intercompany)', 'liability'),
    ('4000', 'ECO Local Contributions', 'income'),
    ('4100', 'Ecodia Software Development', 'income'),
    ('5005', 'Advertising & Marketing', 'expense'),
    ('5010', 'Software & SaaS', 'expense'),
    ('5015', 'Stripe Fees', 'expense'),
    ('5020', 'Contractor Services', 'expense'),
    ('5025', 'Legal & Compliance', 'expense'),
    ('5030', 'Office Supplies', 'expense'),
    ('5035', 'Motor Vehicle', 'expense'),
    ('5040', 'IP Licence Expense (Ecodia Labs)', 'expense')
ON CONFLICT (code) DO NOTHING;

-- Seed supplier rules
INSERT INTO supplier_rules (pattern, supplier_name, account_code, tags) VALUES
    ('vercel', 'Vercel', '5010', '["supplier:vercel"]'),
    ('supabase', 'Supabase', '5010', '["supplier:supabase"]'),
    ('claude ai|anthropic', 'Anthropic', '5010', '["supplier:anthropic"]'),
    ('google cloud|gcp', 'Google Cloud', '5010', '["supplier:googlecloud"]'),
    ('google workspace|gsuite', 'Google Workspace', '5010', '["supplier:googleworkspace"]'),
    ('macincloud', 'MacInCloud', '5010', '["supplier:macincloud"]'),
    ('canva', 'Canva', '5010', '["supplier:canva"]'),
    ('godaddy|domain', 'GoDaddy', '5010', '["supplier:godaddy"]'),
    ('openai|chatgpt', 'OpenAI', '5010', '["supplier:openai"]'),
    ('resend', 'Resend', '5010', '["supplier:resend"]'),
    ('apple\.com/bill', 'Apple', '5010', '["supplier:apple"]'),
    ('google one', 'Google One', '5010', '["supplier:googleone"]'),
    ('aws|amazon web services', 'AWS', '5010', '["supplier:aws"]'),
    ('meta|facebook|facebk|instagram', 'Meta', '5005', '["supplier:meta"]'),
    ('linkedin', 'LinkedIn', '5005', '["supplier:linkedin"]'),
    ('scycc', 'SCYCC', '5005', '["supplier:scycc"]'),
    ('officeworks', 'Officeworks', '5030', '["supplier:officeworks"]'),
    ('asic', 'ASIC', '5025', '["supplier:asic"]'),
    ('ip australia', 'IP Australia', '5025', '["supplier:ipaustralia"]'),
    ('stripe', 'Stripe', '5015', '["supplier:stripe"]')
ON CONFLICT DO NOTHING;

-- Personal deposit rules
INSERT INTO supplier_rules (pattern, supplier_name, account_code, is_personal, is_business, tags) VALUES
    ('casey donohoe', 'Personal deposit', '2100', TRUE, FALSE, '["personal_deposit"]'),
    ('t j donohoe', 'Personal deposit', '2100', TRUE, FALSE, '["personal_deposit"]'),
    ('angelica choppin', 'Personal deposit', '2100', TRUE, FALSE, '["personal_deposit"]')
ON CONFLICT DO NOTHING;
