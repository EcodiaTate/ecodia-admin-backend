-- Live DB was created from an older version of 052 that lacked updated_at.
-- CREATE TABLE IF NOT EXISTS in 052 is a no-op once the table exists, so the
-- column never got added. Adding it explicitly here so all alert cooldowns,
-- breadcrumbs, and the alive beacon can finally commit their writes.
ALTER TABLE kv_store ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();
