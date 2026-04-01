-- 012: Google Workspace (Drive/Docs/Sheets), Vercel API, Meta Graph API
-- Stores synced files, documents, and external platform data for KG ingestion

-- ─── Google Drive Files ────────────────────────────────────────────────

CREATE TABLE drive_files (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    google_file_id TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    mime_type TEXT NOT NULL,
    parent_folder_id TEXT,
    parent_folder_name TEXT,
    owner_email TEXT,
    web_view_link TEXT,
    icon_link TEXT,
    size_bytes BIGINT,
    created_time TIMESTAMPTZ,
    modified_time TIMESTAMPTZ,
    last_modifying_user TEXT,
    shared BOOLEAN DEFAULT false,
    trashed BOOLEAN DEFAULT false,
    content_extracted BOOLEAN DEFAULT false,
    content_text TEXT,                      -- extracted plaintext for chunking
    content_hash TEXT,                      -- SHA-256 of content for change detection
    embedded BOOLEAN DEFAULT false,
    source_account TEXT NOT NULL,           -- which workspace account
    raw_data JSONB,
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_drive_files_google_id ON drive_files(google_file_id);
CREATE INDEX idx_drive_files_mime ON drive_files(mime_type);
CREATE INDEX idx_drive_files_modified ON drive_files(modified_time DESC);
CREATE INDEX idx_drive_files_parent ON drive_files(parent_folder_id);
CREATE INDEX idx_drive_files_not_embedded ON drive_files(embedded) WHERE embedded = false AND content_text IS NOT NULL;

-- ─── Drive Sync State ──────────────────────────────────────────────────

CREATE TABLE drive_sync_state (
    id TEXT PRIMARY KEY,                    -- account email
    page_token TEXT,                        -- Google Drive changes.watch page token
    last_full_sync_at TIMESTAMPTZ,
    last_incremental_sync_at TIMESTAMPTZ,
    updated_at TIMESTAMPTZ DEFAULT now()
);

-- ─── Vercel Projects & Deployments ─────────────────────────────────────

CREATE TABLE vercel_projects (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    vercel_project_id TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    framework TEXT,
    git_repo TEXT,
    production_url TEXT,
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE vercel_deployments (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    vercel_deployment_id TEXT NOT NULL UNIQUE,
    project_id UUID REFERENCES vercel_projects(id) ON DELETE CASCADE,
    vercel_project_id TEXT,
    url TEXT,
    state TEXT,                             -- READY, ERROR, BUILDING, QUEUED, CANCELED
    target TEXT,                            -- production, preview
    git_branch TEXT,
    git_commit_sha TEXT,
    git_commit_message TEXT,
    creator_email TEXT,
    error_message TEXT,
    ready_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_vercel_deployments_project ON vercel_deployments(project_id);
CREATE INDEX idx_vercel_deployments_state ON vercel_deployments(state);
CREATE INDEX idx_vercel_deployments_created ON vercel_deployments(created_at DESC);

-- ─── Meta / Facebook Pages & Posts ─────────────────────────────────────

CREATE TABLE meta_pages (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    page_id TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    category TEXT,
    access_token TEXT,                      -- page-level long-lived token (encrypted in practice)
    followers_count INTEGER DEFAULT 0,
    fan_count INTEGER DEFAULT 0,
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE meta_posts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    post_id TEXT NOT NULL UNIQUE,
    page_id UUID REFERENCES meta_pages(id) ON DELETE CASCADE,
    message TEXT,
    story TEXT,
    permalink_url TEXT,
    type TEXT,                              -- status, photo, video, link
    likes_count INTEGER DEFAULT 0,
    comments_count INTEGER DEFAULT 0,
    shares_count INTEGER DEFAULT 0,
    reach INTEGER,
    impressions INTEGER,
    created_time TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_meta_posts_page ON meta_posts(page_id);
CREATE INDEX idx_meta_posts_created ON meta_posts(created_time DESC);

-- ─── Meta Messages (Messenger / Instagram DMs) ────────────────────────

CREATE TABLE meta_conversations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    conversation_id TEXT NOT NULL UNIQUE,
    page_id UUID REFERENCES meta_pages(id) ON DELETE CASCADE,
    participant_name TEXT,
    participant_id TEXT,
    platform TEXT DEFAULT 'messenger',      -- messenger, instagram
    last_message_at TIMESTAMPTZ,
    unread BOOLEAN DEFAULT false,
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE meta_messages (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    message_id TEXT NOT NULL UNIQUE,
    conversation_id UUID REFERENCES meta_conversations(id) ON DELETE CASCADE,
    sender_name TEXT,
    sender_id TEXT,
    message_text TEXT,
    is_from_page BOOLEAN DEFAULT false,
    created_time TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_meta_messages_conv ON meta_messages(conversation_id);
CREATE INDEX idx_meta_messages_created ON meta_messages(created_time DESC);
