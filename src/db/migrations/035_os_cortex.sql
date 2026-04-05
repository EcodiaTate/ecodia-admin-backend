-- ═══════════════════════════════════════════════════════════════════════
-- OS CORTEX: Workspace-aware persistent task sessions, docs, core context
-- Completely separate from organism cortex tables.
-- ═══════════════════════════════════════════════════════════════════════

-- Persistent multi-turn work sessions
CREATE TABLE IF NOT EXISTS os_task_sessions (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace   TEXT NOT NULL,
    title       TEXT,
    status      TEXT NOT NULL DEFAULT 'active'
                CHECK (status IN ('active','paused','completed')),
    history     JSONB NOT NULL DEFAULT '[]',
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_os_tasks_workspace_status
    ON os_task_sessions (workspace, status, updated_at DESC);

-- Reference docs the AI can read/write
CREATE TABLE IF NOT EXISTS os_docs (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    key         TEXT UNIQUE NOT NULL,
    title       TEXT NOT NULL,
    content     TEXT NOT NULL DEFAULT '',
    workspace   TEXT,
    updated_by  TEXT DEFAULT 'human',
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_os_docs_workspace ON os_docs (workspace);

-- Core context: single-row facts store, always injected
CREATE TABLE IF NOT EXISTS os_core_context (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    facts       JSONB NOT NULL DEFAULT '[]',
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Seed core context
INSERT INTO os_core_context (facts) VALUES ('[
    {"key": "company", "value": "Ecodia Pty Ltd"},
    {"key": "owner", "value": "Tate"},
    {"key": "vps_backend_path", "value": "~/ecodiaos/"},
    {"key": "vps_organism_path", "value": "~/organism/"},
    {"key": "timezone", "value": "Australia/Brisbane"},
    {"key": "financial_year", "value": "July-June"},
    {"key": "gst_registered", "value": "true"},
    {"key": "currency", "value": "AUD"},
    {"key": "process_manager", "value": "PM2"},
    {"key": "database", "value": "Supabase Postgres"}
]'::jsonb);

-- Seed initial docs
INSERT INTO os_docs (key, title, content, workspace) VALUES
('chart-of-accounts', 'Chart of Accounts', '1000 Bank (Operating) - asset
1100 Stripe Clearing - asset
1200 Accounts Receivable - asset
2100 Director Loan - liability
2110 GST Paid (Input Tax Credits) - asset
2120 GST Collected - liability
2200 Unearned Income (Deposit) - liability
3000 Payable to Ecodia Labs (Intercompany) - liability
4000 ECO Local Contributions - income
4100 Ecodia Software Development - income
5000 General Expenses - expense
5005 Advertising & Marketing - expense
5010 Software & SaaS - expense
5015 Stripe Fees - expense
5020 Contractor Services - expense
5025 Legal & Compliance - expense
5030 Office Supplies - expense
5035 Motor Vehicle - expense
5040 IP Licence Expense (Ecodia Labs) - expense', 'bookkeeping'),

('supplier-rules', 'Supplier Categorization Rules', 'Pattern → Supplier → Account
vercel → Vercel → 5010 Software & SaaS
supabase → Supabase → 5010
claude ai|anthropic → Anthropic → 5010
google workspace|gsuite → Google Workspace → 5010
macincloud → MacInCloud → 5010
canva → Canva → 5010
openai|chatgpt → OpenAI → 5010
resend → Resend → 5010
google one → Google One → 5010
aws|amazon web services → AWS → 5010
meta|facebook|instagram → Meta → 5005 Advertising
linkedin → LinkedIn → 5005
officeworks → Officeworks → 5030 Office Supplies
asic → ASIC → 5025 Legal & Compliance
stripe → Stripe → 5015 Stripe Fees
t j donohoe|casey donohoe|angelica choppin → Personal → 2100 Director Loan (is_personal)', 'bookkeeping'),

('gst-rules', 'GST Treatment Rules', 'Australian GST rules for Ecodia Pty Ltd:
- Standard rate: 10% GST
- Most business expenses are GST-inclusive (1/11th is GST)
- International SaaS (Vercel, Supabase, OpenAI, etc.): often GST-free or reverse-charge
- Bank fees, interest: GST-free
- Personal expenses: no GST claim
- BAS reporting: quarterly, offset GST collected against GST paid (input tax credits)
- Director loan transactions: no GST', 'bookkeeping')

ON CONFLICT (key) DO NOTHING;
