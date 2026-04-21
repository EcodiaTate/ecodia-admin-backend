-- OS-managed scheduled tasks (richer than migration 030's scheduled_tasks).
-- The live VPS has this table from hand-run SQL; this migration declares it
-- so fresh DBs and the local dev DB stop silently failing every poll cycle.
--
-- schedulerPollerService and osHeartbeatService both query os_scheduled_tasks
-- with columns (status, next_run_at, run_count, type, priority, chain_after,
-- cron_expression, result). Without this migration those queries return 0
-- rows on any DB that was provisioned after table drift — hence the silent
-- scheduler failures during testing.

CREATE TABLE IF NOT EXISTS os_scheduled_tasks (
  id              SERIAL PRIMARY KEY,
  name            TEXT NOT NULL,
  type            TEXT NOT NULL DEFAULT 'cron' CHECK (type IN ('cron', 'one_shot')),
  status          TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused', 'completed', 'failed')),
  priority        TEXT NOT NULL DEFAULT 'normal' CHECK (priority IN ('critical', 'high', 'normal', 'low')),
  cron_expression TEXT,
  next_run_at     TIMESTAMPTZ,
  last_run_at     TIMESTAMPTZ,
  run_count       INTEGER NOT NULL DEFAULT 0,
  payload         JSONB NOT NULL DEFAULT '{}',
  result          TEXT,
  chain_after     INTEGER REFERENCES os_scheduled_tasks(id) ON DELETE SET NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Partial index on the hot path: scheduler poller runs this exact query every 30s.
CREATE INDEX IF NOT EXISTS idx_os_scheduled_tasks_due
  ON os_scheduled_tasks (next_run_at)
  WHERE status = 'active' AND next_run_at IS NOT NULL;

-- Chain lookup (fireTask follows chains after a one_shot completes).
CREATE INDEX IF NOT EXISTS idx_os_scheduled_tasks_chain
  ON os_scheduled_tasks (chain_after)
  WHERE status = 'active';
