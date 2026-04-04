-- ═══════════════════════════════════════════════════════════════════════
-- 025: Persistent Context Tracking
--
-- Institutional memory for the Cortex: dismissed items, resolved issues,
-- user preferences, and conversation context. Prevents redundant
-- suggestions and respects human boundaries.
-- ═══════════════════════════════════════════════════════════════════════

-- ─── DISMISSED ITEMS ────────────────────────────────────────────────────
-- Tracks anything the human dismissed, declined, or snoozed.
-- Cortex checks this before re-surfacing suggestions.

CREATE TABLE IF NOT EXISTS dismissed_items (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  item_type       TEXT NOT NULL,              -- action, suggestion, notification, alert, insight
  item_key        TEXT NOT NULL,              -- dedup key: source + type + identifier (e.g. 'gmail:draft_reply:thread_abc')
  title           TEXT,
  reason          TEXT,                       -- human's reason for dismissing (optional)
  source          TEXT,                       -- which integration/service produced it
  source_ref_id   TEXT,                       -- FK to original item if applicable
  metadata        JSONB DEFAULT '{}',         -- original item data for context
  dismissed_at    TIMESTAMPTZ DEFAULT now(),
  expires_at      TIMESTAMPTZ,               -- optional: auto-resurface after this time (snooze)
  permanent       BOOLEAN DEFAULT false       -- true = never resurface
);

CREATE INDEX IF NOT EXISTS idx_dismissed_items_key ON dismissed_items(item_key);
CREATE INDEX IF NOT EXISTS idx_dismissed_items_type ON dismissed_items(item_type);
CREATE INDEX IF NOT EXISTS idx_dismissed_items_source ON dismissed_items(source);
CREATE INDEX IF NOT EXISTS idx_dismissed_items_active ON dismissed_items(permanent, expires_at)
  WHERE permanent = true OR expires_at IS NULL OR expires_at > now();

-- ─── RESOLVED ISSUES ────────────────────────────────────────────────────
-- Tracks problems that were identified and fixed. Prevents the system
-- from re-investigating already-resolved issues.

CREATE TABLE IF NOT EXISTS resolved_issues (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  issue_key       TEXT NOT NULL,              -- dedup key: e.g. 'pm2:high_restarts:ecodia-api'
  title           TEXT NOT NULL,
  description     TEXT,
  resolution      TEXT,                       -- how it was resolved
  resolved_by     TEXT DEFAULT 'human',       -- human, factory, cortex, organism
  session_id      UUID,                       -- CC session that fixed it, if applicable
  metadata        JSONB DEFAULT '{}',
  resolved_at     TIMESTAMPTZ DEFAULT now(),
  reopened_at     TIMESTAMPTZ,               -- set if the issue recurred
  status          TEXT DEFAULT 'resolved'
                  CHECK (status IN ('resolved', 'reopened', 'wont_fix'))
);

CREATE INDEX IF NOT EXISTS idx_resolved_issues_key ON resolved_issues(issue_key);
CREATE INDEX IF NOT EXISTS idx_resolved_issues_status ON resolved_issues(status);

-- ─── USER PREFERENCES ───────────────────────────────────────────────────
-- Boundaries and preferences the human has expressed.
-- "Don't suggest X", "Prefer Y approach", "Always do Z for this client"

CREATE TABLE IF NOT EXISTS user_preferences (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  category        TEXT NOT NULL,              -- boundary, preference, workflow, notification
  key             TEXT NOT NULL UNIQUE,        -- dedup key: e.g. 'no_auto_reply:linkedin'
  description     TEXT NOT NULL,              -- human-readable description
  value           JSONB DEFAULT '{}',         -- structured preference data
  source          TEXT DEFAULT 'human',       -- who set it: human, cortex_learned
  active          BOOLEAN DEFAULT true,
  created_at      TIMESTAMPTZ DEFAULT now(),
  updated_at      TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_user_preferences_category ON user_preferences(category);
CREATE INDEX IF NOT EXISTS idx_user_preferences_active ON user_preferences(active) WHERE active = true;

-- ─── CONVERSATION CONTEXT ───────────────────────────────────────────────
-- Persistent topic/thread tracking across Cortex sessions.
-- Allows Cortex to remember what was being discussed and follow up.

CREATE TABLE IF NOT EXISTS conversation_context (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  topic           TEXT NOT NULL,
  summary         TEXT,
  status          TEXT DEFAULT 'active'
                  CHECK (status IN ('active', 'parked', 'resolved', 'abandoned')),
  session_ids     UUID[] DEFAULT '{}',        -- Cortex sessions that discussed this
  related_items   JSONB DEFAULT '{}',         -- references to clients, projects, threads, etc.
  last_mentioned  TIMESTAMPTZ DEFAULT now(),
  created_at      TIMESTAMPTZ DEFAULT now(),
  updated_at      TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_conversation_context_status ON conversation_context(status);
CREATE INDEX IF NOT EXISTS idx_conversation_context_recent ON conversation_context(last_mentioned DESC);
