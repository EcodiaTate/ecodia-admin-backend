-- Scheduled tasks: organism-managed cron jobs
-- The organism can create, update, and delete its own recurring tasks.
CREATE TABLE IF NOT EXISTS scheduled_tasks (
  id            SERIAL PRIMARY KEY,
  name          TEXT UNIQUE NOT NULL,
  cron_expression TEXT NOT NULL,
  action        TEXT NOT NULL CHECK (action IN ('factory_dispatch', 'shell_command', 'capability')),
  payload       JSONB NOT NULL DEFAULT '{}',
  enabled       BOOLEAN NOT NULL DEFAULT TRUE,
  last_run_at   TIMESTAMPTZ,
  last_result   JSONB,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_scheduled_tasks_enabled ON scheduled_tasks (enabled) WHERE enabled = TRUE;
