-- 071_macro_pivot_phase1.sql
-- Phase 1 of the macro runtime pivot to Anthropic computer-use.
-- Spec: ~/ecodiaos/drafts/macro-pivot-to-computer-use-2026-04-29.md (Section 4).
-- Doctrine: ~/ecodiaos/patterns/macros-must-be-validated-by-real-run-before-codification.md
--           ~/ecodiaos/patterns/parallel-forks-must-claim-numbered-resources-before-commit.md
--           ~/ecodiaos/patterns/use-anthropic-existing-tools-before-building-parallel-infrastructure.md
--
-- Phase scope:
--   - Additive only. New columns: brief, inputs_schema, legacy_steps, legacy_vision_targets, legacy_validations.
--   - Backfill legacy_* from current step columns.
--   - Extend status CHECK enum with 'legacy_step_array' and flip all 24 existing rows to it.
--   - The legacy step columns (steps, vision_targets, validations) are NOT dropped this turn.
--     Drop is scheduled for a follow-up migration ~6 May 2026 after a one-week observation window.
--
-- Authored by: fork_mojwrjcx_97060f (29 Apr 2026)
-- Number 071 picked by observation: 070_runbook_validation_runs_and_trigger.sql is latest.
-- Existing CHECK constraint at write-time: macro_runbooks_status_check (5-value enum).

-- =====================================================================
-- Phase 1a: additive columns (safe, no data movement)
-- =====================================================================
ALTER TABLE macro_runbooks
  ADD COLUMN IF NOT EXISTS brief                 text,
  ADD COLUMN IF NOT EXISTS inputs_schema         jsonb,
  ADD COLUMN IF NOT EXISTS legacy_steps          jsonb,
  ADD COLUMN IF NOT EXISTS legacy_vision_targets jsonb,
  ADD COLUMN IF NOT EXISTS legacy_validations    jsonb;

-- =====================================================================
-- Phase 1b: extend status CHECK enum to include 'legacy_step_array'
-- Must run BEFORE the backfill UPDATE, otherwise the UPDATE fails the existing CHECK.
-- =====================================================================
ALTER TABLE macro_runbooks DROP CONSTRAINT IF EXISTS macro_runbooks_status_check;
ALTER TABLE macro_runbooks
  ADD CONSTRAINT macro_runbooks_status_check
  CHECK (status = ANY (ARRAY[
    'untested_spec'::text,
    'replay_in_progress'::text,
    'validated_v1'::text,
    'broken_needs_fix'::text,
    'retired'::text,
    'legacy_step_array'::text
  ]));

-- =====================================================================
-- Phase 1c: backfill legacy_* from current step columns; flip status.
-- Covers all old-runtime statuses (untested_spec, validated_v1, broken_needs_fix).
-- replay_in_progress is excluded (live runs in flight); retired is excluded
-- (already archived, no need to migrate). At write-time the live counts are
-- 23 untested_spec + 1 broken_needs_fix = 24 rows, all of which target the
-- old runtime and must be reclassified.
-- =====================================================================
UPDATE macro_runbooks SET
  legacy_steps          = steps,
  legacy_vision_targets = vision_targets,
  legacy_validations    = validations,
  status                = 'legacy_step_array'
WHERE status IN ('untested_spec', 'validated_v1', 'broken_needs_fix');

-- =====================================================================
-- NOT DONE THIS TURN (scheduled ~6 May 2026 in a follow-up migration):
--   ALTER TABLE macro_runbooks
--     DROP COLUMN steps,
--     DROP COLUMN vision_targets,
--     DROP COLUMN validations,
--     ALTER COLUMN brief SET NOT NULL;
-- The one-week observation window guards against a "we missed something"
-- rollback need. Once briefs are authored and at least one validated_v1
-- run has succeeded on the new runtime, drop the legacy columns.
-- =====================================================================
