-- 068: graceful credit-exhaustion handling for forks.
--
-- Doctrine: ~/ecodiaos/patterns/graceful-credit-exhaustion-handling.md
--
-- Adds the columns os_forks needs so a credit-exhausted fork is recoverable
-- (resumable=true, original brief snapshot, parsed reset window, eventual
-- resume_fork_id) rather than indistinguishable from a real fork failure.
--
-- failure_class is the discriminator that keeps credit_exhaustion out of the
-- learning corpus (it is an account-state signal, not a fork-quality signal).

ALTER TABLE os_forks
  ADD COLUMN IF NOT EXISTS resumable          boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS resumable_brief    text,
  ADD COLUMN IF NOT EXISTS credit_reset_at    timestamptz,
  ADD COLUMN IF NOT EXISTS resume_fork_id     text,
  ADD COLUMN IF NOT EXISTS resumed_at         timestamptz,
  ADD COLUMN IF NOT EXISTS failure_class      text;
  -- failure_class values used in code: 'credit_exhaustion' | 'fork_error' | 'timeout' | NULL.
  -- We deliberately do NOT add a CHECK constraint - keeps the vocabulary
  -- extensible without a follow-up migration.

-- Hot-path index: scheduler poller and the resume-orchestrator will scan for
-- resumable forks whose resume has not been spawned yet, ordered by reset.
CREATE INDEX IF NOT EXISTS idx_os_forks_resumable_pending
  ON os_forks (credit_reset_at)
  WHERE resumable = true AND resumed_at IS NULL;

-- Slicing index for the credit_exhaustion_panel telemetry: count by
-- failure_class over time. Partial keeps it cheap.
CREATE INDEX IF NOT EXISTS idx_os_forks_failure_class_recent
  ON os_forks (failure_class, ended_at DESC)
  WHERE failure_class IS NOT NULL;

COMMENT ON COLUMN os_forks.resumable          IS 'true when the fork can be resumed after a transient state (e.g. credit_exhaustion). The recovery flow sets this in the spawnFork catch block.';
COMMENT ON COLUMN os_forks.resumable_brief    IS 'Snapshot of the original brief at spawn time, used to rehydrate a resume fork without depending on the conductor''s in-memory state.';
COMMENT ON COLUMN os_forks.credit_reset_at    IS 'Parsed UTC reset timestamp from a credit_exhaustion abort_reason. Drives the auto-resume schedule and the spawn-time pre-check that skips a still-dead account.';
COMMENT ON COLUMN os_forks.resume_fork_id     IS 'Populated when an auto-resume fork has been spawned for this row. NULL = not yet resumed.';
COMMENT ON COLUMN os_forks.resumed_at         IS 'When the resume fork was spawned (NOT when it completed).';
COMMENT ON COLUMN os_forks.failure_class      IS 'Classification: credit_exhaustion (recoverable) vs fork_error (real failure) vs timeout. Drives downstream learning vs resume-scheduling.';
