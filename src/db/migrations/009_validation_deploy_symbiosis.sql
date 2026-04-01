-- migrations/009_validation_deploy_symbiosis.sql
-- Validation runs, deployments, and symbridge audit log

-- ─── VALIDATION RUNS ────────────────────────────────────────────────────

CREATE TABLE validation_runs (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    cc_session_id       UUID REFERENCES cc_sessions(id) ON DELETE CASCADE,
    codebase_id         UUID REFERENCES codebases(id),
    test_passed         BOOLEAN,
    test_output         TEXT,
    test_exit_code      INTEGER,
    lint_passed         BOOLEAN,
    lint_output         TEXT,
    typecheck_passed    BOOLEAN,
    typecheck_output    TEXT,
    playwright_passed   BOOLEAN,
    playwright_output   TEXT,
    confidence_score    NUMERIC(3,2),
    duration_ms         INTEGER,
    created_at          TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_validation_runs_session ON validation_runs(cc_session_id);

-- ─── DEPLOYMENTS ────────────────────────────────────────────────────────

CREATE TABLE deployments (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    cc_session_id       UUID REFERENCES cc_sessions(id),
    codebase_id         UUID REFERENCES codebases(id),
    commit_sha          TEXT NOT NULL,
    branch              TEXT DEFAULT 'main',
    deploy_target       TEXT,
    deploy_status       TEXT DEFAULT 'pending'
        CHECK (deploy_status IN ('pending','deploying','deployed','health_check','healthy','failed','reverted')),
    health_check_url    TEXT,
    health_check_status INTEGER,
    reverted_at         TIMESTAMPTZ,
    revert_commit_sha   TEXT,
    error_message       TEXT,
    duration_ms         INTEGER,
    created_at          TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_deployments_session ON deployments(cc_session_id);
CREATE INDEX idx_deployments_codebase ON deployments(codebase_id);
CREATE INDEX idx_deployments_status ON deployments(deploy_status) WHERE deploy_status NOT IN ('healthy','reverted');

-- ─── SYMBRIDGE MESSAGES ─────────────────────────────────────────────────

CREATE TABLE symbridge_messages (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    direction       TEXT NOT NULL CHECK (direction IN ('inbound','outbound')),
    message_type    TEXT NOT NULL,
    payload         JSONB NOT NULL,
    source_system   TEXT NOT NULL CHECK (source_system IN ('organism','ecodiaos')),
    status          TEXT DEFAULT 'pending'
        CHECK (status IN ('pending','processing','completed','failed')),
    correlation_id  TEXT,
    error_message   TEXT,
    created_at      TIMESTAMPTZ DEFAULT now(),
    processed_at    TIMESTAMPTZ
);

CREATE INDEX idx_symbridge_status ON symbridge_messages(status) WHERE status IN ('pending','processing');
CREATE INDEX idx_symbridge_type ON symbridge_messages(message_type, created_at DESC);
CREATE INDEX idx_symbridge_correlation ON symbridge_messages(correlation_id) WHERE correlation_id IS NOT NULL;
