-- migrations/007_codebase_intelligence.sql
-- Codebase Intelligence Layer: chunked code with pgvector embeddings

-- Enable pgvector extension
CREATE EXTENSION IF NOT EXISTS vector;

-- ─── REGISTERED CODEBASES ───────────────────────────────────────────────────

CREATE TABLE codebases (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name            TEXT NOT NULL UNIQUE,
    repo_url        TEXT,
    repo_path       TEXT NOT NULL,
    mirror_path     TEXT,
    language        TEXT,
    project_id      UUID REFERENCES projects(id),
    last_synced_at  TIMESTAMPTZ,
    last_indexed_at TIMESTAMPTZ,
    last_commit_sha TEXT,
    meta            JSONB DEFAULT '{}',
    created_at      TIMESTAMPTZ DEFAULT now()
);

-- ─── CODE CHUNKS WITH EMBEDDINGS ────────────────────────────────────────────

CREATE TABLE code_chunks (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    codebase_id     UUID NOT NULL REFERENCES codebases(id) ON DELETE CASCADE,
    file_path       TEXT NOT NULL,
    chunk_index     INTEGER NOT NULL DEFAULT 0,
    content         TEXT NOT NULL,
    content_hash    TEXT NOT NULL,
    language        TEXT,
    start_line      INTEGER,
    end_line        INTEGER,
    embedding       vector(1536),
    commit_sha      TEXT,
    indexed_at      TIMESTAMPTZ DEFAULT now(),
    UNIQUE (codebase_id, file_path, chunk_index)
);

-- ─── SECRET SAFETY BLOCKLIST ────────────────────────────────────────────────

CREATE TABLE secret_blocklist (
    id          SERIAL PRIMARY KEY,
    pattern     TEXT NOT NULL UNIQUE,
    reason      TEXT,
    created_at  TIMESTAMPTZ DEFAULT now()
);

INSERT INTO secret_blocklist (pattern, reason) VALUES
    ('*.env', 'Environment variables'),
    ('*.env.*', 'Environment variables'),
    ('.env*', 'Environment variables'),
    ('*credentials*', 'Credential files'),
    ('*secret*', 'Secret files'),
    ('*.key', 'Private keys'),
    ('*.pem', 'Certificates'),
    ('*.p12', 'PKCS12 certificates'),
    ('*.pfx', 'PKCS12 certificates'),
    ('*password*', 'Password files'),
    ('*.keystore', 'Java keystores'),
    ('*.jks', 'Java keystores'),
    ('*.secrets.*', 'Secret config files'),
    ('*token*.json', 'Token files'),
    ('*service-account*', 'Service account keys'),
    ('id_rsa*', 'SSH keys'),
    ('id_ed25519*', 'SSH keys'),
    ('*.gpg', 'GPG keys');

-- ─── INDEXES ────────────────────────────────────────────────────────────────

CREATE INDEX idx_codebases_name ON codebases(name);
CREATE INDEX idx_codebases_project ON codebases(project_id);
CREATE INDEX idx_code_chunks_codebase ON code_chunks(codebase_id);
CREATE INDEX idx_code_chunks_file ON code_chunks(codebase_id, file_path);
CREATE INDEX idx_code_chunks_hash ON code_chunks(content_hash);
CREATE INDEX idx_code_chunks_stale ON code_chunks(codebase_id) WHERE embedding IS NULL;

-- pgvector HNSW index for fast cosine similarity search
CREATE INDEX idx_code_chunks_embedding ON code_chunks
    USING hnsw (embedding vector_cosine_ops)
    WITH (m = 16, ef_construction = 64);
