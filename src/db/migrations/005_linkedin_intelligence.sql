-- ═══════════════════════════════════════════════════════════════════════
-- 005_linkedin_intelligence.sql
-- LinkedIn Intelligence Platform — schema extensions
-- ═══════════════════════════════════════════════════════════════════════

-- ─── PLAYWRIGHT SESSION STATE ──────────────────────────────────────────

CREATE TABLE linkedin_session (
    id              TEXT PRIMARY KEY DEFAULT 'default',
    cookies         TEXT,                    -- encrypted via utils/encryption.js
    user_agent      TEXT,
    last_active_at  TIMESTAMPTZ,
    status          TEXT DEFAULT 'inactive'
                    CHECK (status IN ('active','inactive','suspended','captcha')),
    suspend_reason  TEXT,
    login_method    TEXT DEFAULT 'cookie'
                    CHECK (login_method IN ('cookie','manual')),
    meta            JSONB DEFAULT '{}',
    created_at      TIMESTAMPTZ DEFAULT now(),
    updated_at      TIMESTAMPTZ DEFAULT now()
);

INSERT INTO linkedin_session (id) VALUES ('default') ON CONFLICT DO NOTHING;

-- ─── LINKEDIN PROFILES ─────────────────────────────────────────────────

CREATE TABLE linkedin_profiles (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    linkedin_url        TEXT UNIQUE NOT NULL,
    name                TEXT NOT NULL,
    headline            TEXT,
    location            TEXT,
    company             TEXT,
    company_url         TEXT,
    about_snippet       TEXT,
    connection_degree   TEXT,
    mutual_connections  INTEGER,
    is_connection       BOOLEAN DEFAULT false,
    profile_image_url   TEXT,
    tags                TEXT[] DEFAULT '{}',
    relevance_score     NUMERIC(3,2),
    relevance_reason    TEXT,
    raw_scraped         JSONB DEFAULT '{}',
    client_id           UUID REFERENCES clients(id),
    last_scraped_at     TIMESTAMPTZ,
    created_at          TIMESTAMPTZ DEFAULT now(),
    updated_at          TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_li_profiles_url ON linkedin_profiles(linkedin_url);
CREATE INDEX idx_li_profiles_client ON linkedin_profiles(client_id);
CREATE INDEX idx_li_profiles_relevance ON linkedin_profiles(relevance_score DESC NULLS LAST);

-- ─── ENHANCE linkedin_dms ──────────────────────────────────────────────

ALTER TABLE linkedin_dms ADD COLUMN IF NOT EXISTS participant_headline TEXT;
ALTER TABLE linkedin_dms ADD COLUMN IF NOT EXISTS participant_company TEXT;
ALTER TABLE linkedin_dms ADD COLUMN IF NOT EXISTS profile_id UUID REFERENCES linkedin_profiles(id);
ALTER TABLE linkedin_dms ADD COLUMN IF NOT EXISTS category TEXT DEFAULT 'uncategorized';
ALTER TABLE linkedin_dms ADD COLUMN IF NOT EXISTS priority TEXT DEFAULT 'normal';
ALTER TABLE linkedin_dms ADD COLUMN IF NOT EXISTS triage_summary TEXT;
ALTER TABLE linkedin_dms ADD COLUMN IF NOT EXISTS triage_status TEXT DEFAULT 'pending';
ALTER TABLE linkedin_dms ADD COLUMN IF NOT EXISTS triage_attempts INTEGER DEFAULT 0;
ALTER TABLE linkedin_dms ADD COLUMN IF NOT EXISTS lead_score NUMERIC(3,2);
ALTER TABLE linkedin_dms ADD COLUMN IF NOT EXISTS lead_signals JSONB DEFAULT '[]';
ALTER TABLE linkedin_dms ADD COLUMN IF NOT EXISTS message_count INTEGER DEFAULT 0;
ALTER TABLE linkedin_dms ADD COLUMN IF NOT EXISTS is_group_chat BOOLEAN DEFAULT false;

-- Add CHECK constraints via separate statements (safe for ALTER ADD COLUMN)
DO $$ BEGIN
  ALTER TABLE linkedin_dms DROP CONSTRAINT IF EXISTS linkedin_dms_category_check;
  ALTER TABLE linkedin_dms ADD CONSTRAINT linkedin_dms_category_check
    CHECK (category IN ('lead','networking','recruiter','spam','support','personal','uncategorized'));
EXCEPTION WHEN others THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE linkedin_dms DROP CONSTRAINT IF EXISTS linkedin_dms_priority_check;
  ALTER TABLE linkedin_dms ADD CONSTRAINT linkedin_dms_priority_check
    CHECK (priority IN ('urgent','high','normal','low','spam'));
EXCEPTION WHEN others THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE linkedin_dms DROP CONSTRAINT IF EXISTS linkedin_dms_triage_status_check;
  ALTER TABLE linkedin_dms ADD CONSTRAINT linkedin_dms_triage_status_check
    CHECK (triage_status IN ('pending','complete','pending_retry','failed'));
EXCEPTION WHEN others THEN NULL;
END $$;

CREATE INDEX IF NOT EXISTS idx_li_dms_category ON linkedin_dms(category);
CREATE INDEX IF NOT EXISTS idx_li_dms_priority ON linkedin_dms(priority);
CREATE INDEX IF NOT EXISTS idx_li_dms_triage ON linkedin_dms(triage_status);
CREATE INDEX IF NOT EXISTS idx_li_dms_lead ON linkedin_dms(lead_score DESC NULLS LAST);
CREATE INDEX IF NOT EXISTS idx_li_dms_profile ON linkedin_dms(profile_id);

-- ─── ENHANCE linkedin_posts ────────────────────────────────────────────

ALTER TABLE linkedin_posts ADD COLUMN IF NOT EXISTS post_type TEXT DEFAULT 'text';
ALTER TABLE linkedin_posts ADD COLUMN IF NOT EXISTS hashtags TEXT[] DEFAULT '{}';
ALTER TABLE linkedin_posts ADD COLUMN IF NOT EXISTS ai_generated BOOLEAN DEFAULT false;
ALTER TABLE linkedin_posts ADD COLUMN IF NOT EXISTS ai_prompt TEXT;
ALTER TABLE linkedin_posts ADD COLUMN IF NOT EXISTS linkedin_post_url TEXT;
ALTER TABLE linkedin_posts ADD COLUMN IF NOT EXISTS theme TEXT;
ALTER TABLE linkedin_posts ADD COLUMN IF NOT EXISTS impressions INTEGER;
ALTER TABLE linkedin_posts ADD COLUMN IF NOT EXISTS reactions INTEGER;
ALTER TABLE linkedin_posts ADD COLUMN IF NOT EXISTS comments_count INTEGER;
ALTER TABLE linkedin_posts ADD COLUMN IF NOT EXISTS reposts INTEGER;
ALTER TABLE linkedin_posts ADD COLUMN IF NOT EXISTS engagement_rate NUMERIC(5,4);
ALTER TABLE linkedin_posts ADD COLUMN IF NOT EXISTS performance_scraped_at TIMESTAMPTZ;
ALTER TABLE linkedin_posts ADD COLUMN IF NOT EXISTS recurring_id UUID;
ALTER TABLE linkedin_posts ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT now();

DO $$ BEGIN
  ALTER TABLE linkedin_posts DROP CONSTRAINT IF EXISTS linkedin_posts_post_type_check;
  ALTER TABLE linkedin_posts ADD CONSTRAINT linkedin_posts_post_type_check
    CHECK (post_type IN ('text','image','carousel','poll','article','video'));
EXCEPTION WHEN others THEN NULL;
END $$;

CREATE INDEX IF NOT EXISTS idx_li_posts_type ON linkedin_posts(post_type);
CREATE INDEX IF NOT EXISTS idx_li_posts_status ON linkedin_posts(status);
CREATE INDEX IF NOT EXISTS idx_li_posts_scheduled ON linkedin_posts(scheduled_at) WHERE status = 'scheduled';
CREATE INDEX IF NOT EXISTS idx_li_posts_performance ON linkedin_posts(engagement_rate DESC NULLS LAST);

-- ─── CONNECTION REQUESTS ──────────────────────────────────────────────

CREATE TABLE linkedin_connection_requests (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    profile_id      UUID REFERENCES linkedin_profiles(id),
    linkedin_url    TEXT NOT NULL,
    name            TEXT NOT NULL,
    headline        TEXT,
    message         TEXT,
    direction       TEXT NOT NULL CHECK (direction IN ('incoming','outgoing')),
    status          TEXT DEFAULT 'pending'
                    CHECK (status IN ('pending','accepted','declined','withdrawn')),
    relevance_score NUMERIC(3,2),
    relevance_reason TEXT,
    scraped_at      TIMESTAMPTZ DEFAULT now(),
    acted_on_at     TIMESTAMPTZ,
    created_at      TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_li_conn_req_status ON linkedin_connection_requests(status);
CREATE INDEX idx_li_conn_req_relevance ON linkedin_connection_requests(relevance_score DESC NULLS LAST);

-- ─── NETWORK ANALYTICS SNAPSHOTS ──────────────────────────────────────

CREATE TABLE linkedin_network_snapshots (
    id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    connection_count        INTEGER,
    follower_count          INTEGER,
    pending_invitations     INTEGER,
    profile_views_week      INTEGER,
    search_appearances_week INTEGER,
    post_impressions_week   INTEGER,
    snapshot_date           DATE UNIQUE NOT NULL,
    raw_data                JSONB DEFAULT '{}',
    created_at              TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_li_net_snap_date ON linkedin_network_snapshots(snapshot_date DESC);

-- ─── CONTENT THEMES ──────────────────────────────────────────────────

CREATE TABLE linkedin_content_themes (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name            TEXT NOT NULL,
    description     TEXT,
    day_of_week     INTEGER,
    time_of_day     TIME,
    prompt_template TEXT,
    active          BOOLEAN DEFAULT true,
    created_at      TIMESTAMPTZ DEFAULT now(),
    updated_at      TIMESTAMPTZ DEFAULT now()
);

-- ─── SCRAPE JOB LOG ──────────────────────────────────────────────────

CREATE TABLE linkedin_scrape_log (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    job_type        TEXT NOT NULL,
    status          TEXT DEFAULT 'running'
                    CHECK (status IN ('running','complete','failed','captcha')),
    pages_scraped   INTEGER DEFAULT 0,
    items_found     INTEGER DEFAULT 0,
    duration_ms     INTEGER,
    error_message   TEXT,
    created_at      TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_li_scrape_log_type ON linkedin_scrape_log(job_type, created_at DESC);
CREATE INDEX idx_li_scrape_log_status ON linkedin_scrape_log(status) WHERE status IN ('captcha','failed');

-- ─── ENGAGEMENT WATCHLIST & QUEUE (Phase 3) ──────────────────────────

CREATE TABLE linkedin_engagement_watchlist (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    profile_id      UUID REFERENCES linkedin_profiles(id),
    linkedin_url    TEXT NOT NULL,
    name            TEXT NOT NULL,
    reason          TEXT,
    active          BOOLEAN DEFAULT true,
    created_at      TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE linkedin_engagement_queue (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    watchlist_id    UUID REFERENCES linkedin_engagement_watchlist(id),
    post_url        TEXT NOT NULL,
    post_author     TEXT,
    post_snippet    TEXT,
    suggested_comment TEXT,
    status          TEXT DEFAULT 'pending'
                    CHECK (status IN ('pending','approved','sent','skipped')),
    created_at      TIMESTAMPTZ DEFAULT now(),
    acted_on_at     TIMESTAMPTZ
);

CREATE INDEX idx_li_engage_queue_status ON linkedin_engagement_queue(status, created_at DESC);
