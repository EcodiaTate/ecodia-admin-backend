-- 044: Add archived_at to clients table if missing
--
-- The clients table may have been created without the archived_at column
-- (schema drift between 001_initial.sql and live VPS). This ensures the
-- soft-delete column exists for CRM dashboard, pipeline analytics, and search.

ALTER TABLE clients ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ;
