-- 070: runbook_validation_runs table + enforce_validated_v1_has_validation_run trigger.
--
-- Doctrine: ~/ecodiaos/patterns/macros-must-be-validated-by-real-run-before-codification.md
-- Decision: Neo4j id=3854 (Doctrine-only enforcement is insufficient - 4 active doctrines need
-- mechanical backstops). This migration is backstop #1 of #4: the schema-level forcing function
-- so a runbook cannot be flipped to status='validated_v1' without a real validation run on file.
--
-- Context: macro_runbooks already has a CHECK constraint on status (5 enum values). What was
-- missing is the enforcement that 'validated_v1' is reserved for runbooks that have actually
-- been replayed end-to-end. Without this trigger, a fork or human can simply
--   UPDATE macro_runbooks SET status='validated_v1' WHERE name='gmail-send'
-- and the row joins the trusted set instantly. That is the failure mode the doctrine names:
-- author-from-imagination produces structured JSON that is indistinguishable from validated
-- runbooks at storage time. The trigger below makes the database itself reject that path -
-- a validation run row must exist before the status flip is allowed.
--
-- The 24 existing rows (23 untested_spec + 1 broken_needs_fix as of write-time) are NOT
-- affected: this trigger only fires when the UPDATE sets NEW.status='validated_v1'. The
-- existing rows stay in their current statuses untouched.

-- ---------------------------------------------------------------------------
-- runbook_validation_runs: one row per real end-to-end replay against the
-- live target UI. The summary records what was observed; screenshot_url is
-- the artefact reference (S3/Supabase Storage path). actor is the agent or
-- human that ran the validation - usually a fork id or 'tate'.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS runbook_validation_runs (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  runbook_id      uuid NOT NULL REFERENCES macro_runbooks(id) ON DELETE CASCADE,
  validated_at    timestamptz NOT NULL DEFAULT now(),
  actor           text NOT NULL,
  summary         text NOT NULL,
  screenshot_url  text
);

CREATE INDEX IF NOT EXISTS idx_runbook_validation_runs_runbook
  ON runbook_validation_runs (runbook_id, validated_at DESC);

COMMENT ON TABLE runbook_validation_runs IS
  'One row per real end-to-end replay of a macro_runbooks row. Required precondition for status=validated_v1. See ~/ecodiaos/patterns/macros-must-be-validated-by-real-run-before-codification.md.';
COMMENT ON COLUMN runbook_validation_runs.actor IS
  'Fork id (e.g. fork_mojwfgoo_16a711) or human identifier (e.g. tate) that observed the replay.';
COMMENT ON COLUMN runbook_validation_runs.summary IS
  'Plain-text observation of what the replay produced - declared goal_state matched, what diverged, etc.';
COMMENT ON COLUMN runbook_validation_runs.screenshot_url IS
  'Optional artefact link (Supabase Storage / S3) to the post-replay screenshot. Nullable because some macros mutate state we cannot screenshot.';

-- ---------------------------------------------------------------------------
-- enforce_validated_v1_has_validation_run: BEFORE UPDATE trigger that blocks
-- a status flip to validated_v1 unless at least one runbook_validation_runs
-- row references this runbook. Fires on UPDATE only - INSERTs default to
-- 'untested_spec' which is allowed without a validation run, and the CHECK
-- constraint on the status column already restricts INSERT values to the
-- 5-value enum.
--
-- Why BEFORE UPDATE not AFTER: rejecting before the row mutation lands
-- avoids dirty-rollback pressure and gives a cleaner exception trace.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION enforce_validated_v1_has_validation_run()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.status = 'validated_v1' AND (OLD.status IS DISTINCT FROM 'validated_v1') THEN
    IF NOT EXISTS (
      SELECT 1 FROM runbook_validation_runs WHERE runbook_id = NEW.id
    ) THEN
      RAISE EXCEPTION
        'macro_runbooks.status=validated_v1 requires at least one runbook_validation_runs row for runbook_id=%. Insert a validation run first. See ~/ecodiaos/patterns/macros-must-be-validated-by-real-run-before-codification.md.',
        NEW.id
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_enforce_validated_v1_has_validation_run ON macro_runbooks;
CREATE TRIGGER trg_enforce_validated_v1_has_validation_run
  BEFORE UPDATE ON macro_runbooks
  FOR EACH ROW
  EXECUTE FUNCTION enforce_validated_v1_has_validation_run();

COMMENT ON FUNCTION enforce_validated_v1_has_validation_run IS
  'Blocks status=validated_v1 UPDATEs unless a runbook_validation_runs row exists. The schema-level half of the macro-validation backstop (the PreToolUse hook macro-runbook-write-surface.sh is the warning half).';
