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
    {"key": "abn", "value": "Check ASIC records — update this when known"},
    {"key": "owner", "value": "Tate (Tom Grote is co-founder)"},
    {"key": "entity_type", "value": "Australian Pty Ltd, registered for GST"},
    {"key": "bank", "value": "Bank Australia (business account)"},
    {"key": "vps_backend_path", "value": "~/ecodiaos/ (Node/Express, postgres.js)"},
    {"key": "vps_organism_path", "value": "~/organism/ (Python/FastAPI)"},
    {"key": "timezone", "value": "Australia/Brisbane (AEST/AEDT)"},
    {"key": "financial_year", "value": "1 July to 30 June"},
    {"key": "bas_cycle", "value": "Quarterly BAS lodgement"},
    {"key": "gst_registered", "value": "true — 10% GST, report quarterly"},
    {"key": "currency", "value": "AUD (all amounts stored as integer cents)"},
    {"key": "process_manager", "value": "PM2 on DigitalOcean VPS"},
    {"key": "database", "value": "Supabase Postgres (hosted, pooled connection)"},
    {"key": "frontend_host", "value": "Vercel (auto-deploy from GitHub)"},
    {"key": "sub_brands", "value": "Ecodia Code (dev tools), Co-Exist (conservation app)"},
    {"key": "revenue_streams", "value": "ECO Local contributions, Ecodia software dev, GoodReach (forming)"},
    {"key": "key_saas", "value": "Vercel, Supabase, OpenAI, Anthropic, MacInCloud, Canva, Resend, Google Workspace, DigitalOcean"}
]'::jsonb);

-- Seed initial docs
INSERT INTO os_docs (key, title, content, workspace) VALUES

-- ═══ BOOKKEEPING DOCS ═══

('chart-of-accounts', 'Chart of Accounts — Ecodia Pty Ltd', 'ASSETS
1000  Bank (Operating)          — Bank Australia business account
1100  Stripe Clearing           — Funds in transit from Stripe
1200  Accounts Receivable       — Invoiced but unpaid client work
2110  GST Paid (Input Credits)  — GST on purchases, claimed back quarterly

LIABILITIES
2100  Director Loan             — Personal money in/out of business. Positive = company owes Tate.
2120  GST Collected             — GST on sales, owed to ATO quarterly
2200  Unearned Income           — Deposits received before work done
3000  Intercompany (Ecodia Labs) — Payable between entities if applicable

INCOME
4000  ECO Local Contributions   — Revenue from ECO Local conservation platform
4100  Ecodia Software Dev       — Client dev work, consulting, builds

EXPENSES
5000  General Expenses          — Catch-all (use sparingly, prefer specific accounts)
5005  Advertising & Marketing   — Meta ads, LinkedIn, promotional
5010  Software & SaaS           — Vercel, Supabase, OpenAI, Anthropic, MacInCloud, Canva, Resend, Google Workspace, DigitalOcean, GitHub
5015  Stripe Fees               — Payment processing fees
5020  Contractor Services       — Freelancers, external dev work
5025  Legal & Compliance        — ASIC, IP Australia, legal advice
5030  Office & Equipment        — Officeworks, hardware, supplies
5035  Motor Vehicle             — Business use of vehicle (log required)
5040  IP Licence (Ecodia Labs)  — Intercompany IP licensing
5045  Bank Fees                 — Monthly account fees, international tx fees
5050  Food & Entertainment      — Business meals (50% deductible if applicable)

NOTES
- When AI creates a new account, update this doc.
- Account codes: 1xxx=asset, 2xxx=liability, 3xxx=intercompany, 4xxx=income, 5xxx=expense.
- Director Loan (2100): ALL personal transfers, personal purchases on business card.', 'bookkeeping'),

('supplier-rules', 'Supplier Categorization Rules', 'PATTERN MATCHING: case-insensitive regex against transaction description.
When matched, auto-assigns supplier name, GL account, and flags.

SOFTWARE & SAAS (5010)
  vercel|vercel inc|vercel domains → Vercel
  supabase → Supabase
  claude ai|anthropic → Anthropic
  openai|chatgpt → OpenAI
  google workspace|gsuite → Google Workspace
  macincloud → MacInCloud
  canva → Canva
  resend → Resend
  google one → Google One
  aws|amazon web → AWS
  google\*play → Google Play (dev account)
  digitalocean|droplet → DigitalOcean

ADVERTISING (5005)
  meta|facebook|facebk|instagram → Meta
  linkedin → LinkedIn
  scycc → SCYCC

BANK FEES (5045)
  monthly account fee → Bank Australia (fee)
  int tran fee|intl fee|international transaction → Bank Australia (intl fee)

LEGAL (5025)
  asic → ASIC
  ip australia → IP Australia

OFFICE (5030)
  officeworks → Officeworks

STRIPE (5015)
  stripe → Stripe

PERSONAL / DIRECTOR LOAN (2100, is_personal=true)
  t j donohoe|transfer to sav 12566110 → Personal transfer out
  received from sav|transfer from t j → Personal transfer in
  casey donohoe → Personal
  angelica choppin → Personal
  chempro → Personal (pharmacy)
  jericho|kings beach bar → Personal (food/drink)
  amrityu → Personal (food)

RULES FOR THE AI:
- When you categorize and the supplier isnt here, create a new rule with update_doc.
- International SaaS fees always come with a separate "Int Tran Fee" line — categorize to 5045.
- $0.00 rows (invalid PIN, etc.) should be ignored.
- "Transfer to SAV 12566110" = personal savings transfer = Director Loan.', 'bookkeeping'),

('gst-rules', 'GST Treatment Rules — Australia', 'BASICS
- GST rate: 10% (1/11th of GST-inclusive amount)
- Ecodia is registered → must charge GST on taxable supplies, can claim input tax credits
- BAS lodgement: quarterly (Jul-Sep, Oct-Dec, Jan-Mar, Apr-Jun)

TREATMENT BY CATEGORY
  Domestic SaaS (Canva, etc.)     → GST-inclusive, claim 1/11th as input credit
  International SaaS (Vercel, Supabase, OpenAI, Anthropic, etc.)
                                  → Usually GST-free (reverse charge may apply >$1000)
  International transaction fees   → GST-free (bank fee, not a supply)
  Bank monthly fees               → GST-free (financial supply)
  Stripe fees                     → GST-inclusive (Stripe AU charges GST)
  Advertising (Meta, LinkedIn)    → International = GST-free. Domestic = GST-inclusive.
  Office supplies (Officeworks)   → GST-inclusive
  Personal expenses               → NO GST claim (not business purpose)
  Director loan transfers         → Not a supply, no GST
  Client income (ECO Local, dev)  → Charge GST on invoice if >$75

BAS CALCULATION
  1A: GST on sales (account 2120 credits for period)
  1B: GST on purchases (account 2110 debits for period)
  Net = 1A - 1B → positive = owe ATO, negative = refund', 'bookkeeping'),

('ecodia-context', 'Ecodia Business Context', 'Ecodia Pty Ltd is a software company run by Tate, based in Queensland, Australia.

PRODUCTS & REVENUE
- ECO Local: conservation contribution platform (live)
- Ecodia Code: developer tools sub-brand
- Co-Exist: youth conservation app (React/Capacitor/Supabase, separate codebase)
- GoodReach: AI tools for AU nonprofits (pre-validation, $5K/yr SaaS model forming)
- Software dev consulting for clients

INFRASTRUCTURE COSTS (monthly approx)
- DigitalOcean VPS: ~$24/mo
- Supabase: ~$62/mo (Pro plan)
- Vercel: ~$29/mo (Pro plan)
- OpenAI: ~$32/mo (ChatGPT Plus)
- Anthropic/Claude: variable (API + Claude Code)
- Google Workspace: ~$80/mo
- MacInCloud: ~$51/mo (Mac VM for iOS builds)
- Canva: ~$40/mo
- Resend: ~$30/mo (email API)
- Domain registrations: ~$14/mo (Vercel Domains)

BANK ACCOUNT
- Bank Australia business account
- Card ending #7346773 (VISA)
- Savings account: SAV 12566110 (personal, Tate)
- Transactions reference format: Ref.MMDD00XXXXXX

This doc should be updated as the business evolves.', 'bookkeeping'),

-- ═══ GLOBAL DOCS (available to all workspaces) ═══

('ecodia-team', 'Ecodia Team & Contacts', 'Tate — Founder, sole director, does everything
Tom Grote — Co-founder (Ecodia Code)
Kurt Jones — Founder of Co-Exist (partner project)

This doc should be updated as the team grows.', NULL)

ON CONFLICT (key) DO UPDATE SET
  title = EXCLUDED.title,
  content = EXCLUDED.content,
  workspace = EXCLUDED.workspace,
  updated_by = 'migration',
  updated_at = now();
