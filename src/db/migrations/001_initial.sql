-- migrations/001_initial.sql

-- ─── MIGRATIONS TRACKING ─────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS _migrations (
    filename    TEXT PRIMARY KEY,
    applied_at  TIMESTAMPTZ DEFAULT now()
);

-- ─── CLIENTS / CRM ───────────────────────────────────────────────────────────

CREATE TABLE clients (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name        TEXT NOT NULL,
    company     TEXT,
    email       TEXT,
    phone       TEXT,
    linkedin_url TEXT,
    xero_contact_id TEXT,
    stage       TEXT NOT NULL DEFAULT 'lead'
                CHECK (stage IN ('lead','proposal','contract',
                                  'development','live','ongoing','archived')),
    priority    TEXT DEFAULT 'medium' CHECK (priority IN ('low','medium','high')),
    notes       JSONB DEFAULT '[]',
    tags        TEXT[] DEFAULT '{}',
    meta        JSONB DEFAULT '{}',
    archived_at TIMESTAMPTZ,
    created_at  TIMESTAMPTZ DEFAULT now(),
    updated_at  TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE projects (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    client_id   UUID REFERENCES clients(id) ON DELETE CASCADE,
    name        TEXT NOT NULL,
    description TEXT,
    status      TEXT DEFAULT 'active'
                CHECK (status IN ('active','paused','complete','archived')),
    repo_path   TEXT,
    repo_url    TEXT,
    tech_stack  TEXT[],
    budget_aud  NUMERIC(10,2),
    hourly_rate NUMERIC(8,2),
    meta        JSONB DEFAULT '{}',
    archived_at TIMESTAMPTZ,
    created_at  TIMESTAMPTZ DEFAULT now(),
    updated_at  TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE pipeline_events (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    client_id   UUID REFERENCES clients(id) ON DELETE CASCADE,
    from_stage  TEXT,
    to_stage    TEXT NOT NULL,
    note        TEXT,
    triggered_cc_session_id UUID,
    created_at  TIMESTAMPTZ DEFAULT now()
);

-- ─── FINANCE ─────────────────────────────────────────────────────────────────

CREATE TABLE transactions (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    xero_id         TEXT UNIQUE NOT NULL,
    bank_account_id TEXT NOT NULL,
    date            DATE NOT NULL,
    description     TEXT NOT NULL,
    amount_aud      NUMERIC(10,2) NOT NULL,
    type            TEXT CHECK (type IN ('debit','credit')),
    status          TEXT DEFAULT 'uncategorized'
                    CHECK (status IN ('uncategorized','categorized','reconciled')),
    category        TEXT,
    category_confidence NUMERIC(3,2),
    xero_category   TEXT,
    client_id       UUID REFERENCES clients(id),
    project_id      UUID REFERENCES projects(id),
    raw_xero_data   JSONB,
    created_at      TIMESTAMPTZ DEFAULT now(),
    updated_at      TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE xero_tokens (
    id              SERIAL PRIMARY KEY,
    access_token    TEXT NOT NULL,
    refresh_token   TEXT NOT NULL,
    expires_at      TIMESTAMPTZ NOT NULL,
    tenant_id       TEXT NOT NULL,
    updated_at      TIMESTAMPTZ DEFAULT now()
);

-- ─── GMAIL ───────────────────────────────────────────────────────────────────

CREATE TABLE email_threads (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    gmail_thread_id TEXT UNIQUE NOT NULL,
    gmail_message_ids TEXT[],
    subject         TEXT,
    from_email      TEXT NOT NULL,
    from_name       TEXT,
    snippet         TEXT,
    full_body       TEXT,
    labels          TEXT[],
    client_id       UUID REFERENCES clients(id),
    triage_priority TEXT DEFAULT 'normal'
                    CHECK (triage_priority IN ('urgent','high','normal','low','spam')),
    triage_summary  TEXT,
    triage_action   TEXT,
    draft_reply     TEXT,
    draft_gmail_id  TEXT,
    triage_status   TEXT DEFAULT 'pending'
                    CHECK (triage_status IN ('pending','complete','pending_retry','failed')),
    triage_attempts INTEGER DEFAULT 0,
    status          TEXT DEFAULT 'unread'
                    CHECK (status IN ('unread','triaged','replied','archived')),
    received_at     TIMESTAMPTZ,
    created_at      TIMESTAMPTZ DEFAULT now(),
    updated_at      TIMESTAMPTZ DEFAULT now()
);

-- ─── LINKEDIN ────────────────────────────────────────────────────────────────

CREATE TABLE linkedin_dms (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    conversation_id TEXT UNIQUE NOT NULL,
    participant_name TEXT NOT NULL,
    participant_profile_url TEXT,
    messages        JSONB DEFAULT '[]',
    last_message_at TIMESTAMPTZ,
    client_id       UUID REFERENCES clients(id),
    draft_reply     TEXT,
    status          TEXT DEFAULT 'unread'
                    CHECK (status IN ('unread','drafting','replied','ignored')),
    created_at      TIMESTAMPTZ DEFAULT now(),
    updated_at      TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE linkedin_posts (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    content         TEXT NOT NULL,
    media_paths     TEXT[],
    scheduled_at    TIMESTAMPTZ,
    posted_at       TIMESTAMPTZ,
    status          TEXT DEFAULT 'draft'
                    CHECK (status IN ('draft','scheduled','posted','failed')),
    created_at      TIMESTAMPTZ DEFAULT now()
);

-- ─── TASKS ───────────────────────────────────────────────────────────────────

CREATE TABLE tasks (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    title       TEXT NOT NULL,
    description TEXT,
    source      TEXT CHECK (source IN ('gmail','linkedin','crm','manual','cc')),
    source_ref_id TEXT,
    client_id   UUID REFERENCES clients(id),
    project_id  UUID REFERENCES projects(id),
    priority    TEXT DEFAULT 'medium' CHECK (priority IN ('low','medium','high','urgent')),
    status      TEXT DEFAULT 'open' CHECK (status IN ('open','in_progress','done','cancelled')),
    due_date    DATE,
    created_at  TIMESTAMPTZ DEFAULT now(),
    updated_at  TIMESTAMPTZ DEFAULT now()
);

-- ─── CLAUDE CODE SESSIONS ────────────────────────────────────────────────────

CREATE TABLE cc_sessions (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    cc_session_id   TEXT,
    project_id      UUID REFERENCES projects(id),
    client_id       UUID REFERENCES clients(id),
    triggered_by    TEXT CHECK (triggered_by IN ('crm_stage','manual','task')),
    trigger_ref_id  TEXT,
    initial_prompt  TEXT NOT NULL,
    conversation    JSONB DEFAULT '[]',
    status          TEXT DEFAULT 'initializing'
                    CHECK (status IN ('initializing','running',
                                       'awaiting_input','complete','error')),
    working_dir     TEXT,
    cc_cost_usd     NUMERIC(8,4),
    started_at      TIMESTAMPTZ DEFAULT now(),
    completed_at    TIMESTAMPTZ,
    error_message   TEXT
);

CREATE TABLE cc_session_logs (
    id          SERIAL PRIMARY KEY,
    session_id  UUID REFERENCES cc_sessions(id) ON DELETE CASCADE,
    chunk       TEXT NOT NULL,
    created_at  TIMESTAMPTZ DEFAULT now()
);

-- ─── NOTIFICATIONS ───────────────────────────────────────────────────────────

CREATE TABLE notifications (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    type        TEXT NOT NULL,
    message     TEXT NOT NULL,
    link        TEXT,
    read        BOOLEAN DEFAULT false,
    metadata    JSONB DEFAULT '{}',
    created_at  TIMESTAMPTZ DEFAULT now()
);

-- ─── GMAIL SYNC STATE ────────────────────────────────────────────────────────

CREATE TABLE gmail_sync_state (
    id          SERIAL PRIMARY KEY,
    history_id  TEXT NOT NULL,
    updated_at  TIMESTAMPTZ DEFAULT now()
);

-- ─── DEEPSEEK USAGE TRACKING ─────────────────────────────────────────────────

CREATE TABLE deepseek_usage (
    id                  SERIAL PRIMARY KEY,
    model               TEXT,
    prompt_tokens       INTEGER,
    completion_tokens   INTEGER,
    cost_usd            NUMERIC(8,6),
    module              TEXT,
    duration_ms         INTEGER,
    created_at          TIMESTAMPTZ DEFAULT now()
);

-- ─── PLAYWRIGHT TEST RUNS ────────────────────────────────────────────────────

CREATE TABLE playwright_runs (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    cc_session_id   UUID REFERENCES cc_sessions(id) ON DELETE SET NULL,
    project_id      UUID REFERENCES projects(id) ON DELETE SET NULL,
    spec            TEXT NOT NULL,
    url             TEXT NOT NULL,
    passed          TEXT[] DEFAULT '{}',
    failed          TEXT[] DEFAULT '{}',
    screenshot_paths TEXT[] DEFAULT '{}',
    dom_snapshot    TEXT,
    exit_code       INTEGER,
    duration_ms     INTEGER,
    created_at      TIMESTAMPTZ DEFAULT now()
);

-- ─── INDEXES ─────────────────────────────────────────────────────────────────

CREATE INDEX idx_transactions_date ON transactions(date DESC);
CREATE INDEX idx_transactions_status ON transactions(status);
CREATE INDEX idx_transactions_client ON transactions(client_id);
CREATE INDEX idx_transactions_project ON transactions(project_id);
CREATE INDEX idx_email_threads_status ON email_threads(status);
CREATE INDEX idx_email_threads_client ON email_threads(client_id);
CREATE INDEX idx_email_threads_rcvd ON email_threads(received_at DESC);
CREATE INDEX idx_linkedin_dms_client ON linkedin_dms(client_id);
CREATE INDEX idx_linkedin_dms_updated ON linkedin_dms(updated_at DESC);
CREATE INDEX idx_tasks_status ON tasks(status);
CREATE INDEX idx_tasks_client ON tasks(client_id);
CREATE INDEX idx_tasks_project ON tasks(project_id);
CREATE INDEX idx_cc_sessions_status ON cc_sessions(status);
CREATE INDEX idx_cc_sessions_project ON cc_sessions(project_id);
CREATE INDEX idx_cc_sessions_client ON cc_sessions(client_id);
CREATE INDEX idx_cc_session_logs_session ON cc_session_logs(session_id, created_at);
CREATE INDEX idx_notifications_read ON notifications(read, created_at DESC);
CREATE INDEX idx_deepseek_usage_module ON deepseek_usage(module, created_at DESC);
CREATE INDEX idx_playwright_runs_project ON playwright_runs(project_id, created_at DESC);
CREATE INDEX idx_playwright_runs_session ON playwright_runs(cc_session_id);
CREATE INDEX idx_pipeline_events_client ON pipeline_events(client_id);
CREATE INDEX idx_projects_client ON projects(client_id);
