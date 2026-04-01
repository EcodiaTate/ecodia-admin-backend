-- Add 'cortex' to allowed task sources
ALTER TABLE tasks DROP CONSTRAINT IF EXISTS tasks_source_check;
ALTER TABLE tasks ADD CONSTRAINT tasks_source_check
    CHECK (source IN ('gmail','linkedin','crm','manual','cc','cortex'));
