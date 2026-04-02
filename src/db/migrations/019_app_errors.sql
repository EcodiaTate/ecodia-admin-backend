-- 019_app_errors.sql
-- Application-level error log. Persists Winston error-level events so the
-- autonomous maintenance worker and KG can read them. The system sees its
-- own errors and can self-diagnose without human intervention.

CREATE TABLE IF NOT EXISTS app_errors (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  level       TEXT NOT NULL DEFAULT 'error',
  message     TEXT NOT NULL,
  service     TEXT,
  module      TEXT,           -- extracted from log metadata (e.g. 'cortex', 'gmail')
  path        TEXT,           -- HTTP path if request-scoped
  method      TEXT,
  stack       TEXT,
  meta        JSONB,          -- full log metadata
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS app_errors_created_at ON app_errors (created_at DESC);
CREATE INDEX IF NOT EXISTS app_errors_module ON app_errors (module) WHERE module IS NOT NULL;

-- Auto-prune: keep only 30 days. Errors older than 30d are noise not signal.
-- A scheduled function or the maintenance worker can call this.
-- For now, the maintenance worker reads the last 48h; 30d provides history.
