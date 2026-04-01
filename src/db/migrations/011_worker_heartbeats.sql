-- Worker heartbeats — tracks last run time + status for each autonomous worker
CREATE TABLE IF NOT EXISTS worker_heartbeats (
  worker_name TEXT PRIMARY KEY,
  last_run_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  status TEXT NOT NULL DEFAULT 'active',
  error_msg TEXT
);
