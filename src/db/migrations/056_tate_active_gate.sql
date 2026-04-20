-- Tate active session gate: track when a cron was last deferred because
-- Tate was actively talking to the OS session.
ALTER TABLE os_scheduled_tasks
  ADD COLUMN IF NOT EXISTS last_deferred_at TIMESTAMPTZ;
