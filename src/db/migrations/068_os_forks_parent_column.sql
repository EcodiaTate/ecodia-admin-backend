-- 068: os_forks parent column for Cowork-pool fork attribution
--
-- Part 2 of 3 for Cowork V2 MCP peerage substrate (W2-B,
-- fork_mokmorc8_24edea, 30 Apr 2026). Adds parent column so the
-- conductor's HARD_FORK_CAP=5 stays untouched while Cowork has its
-- own COWORK_FORK_CAP=3 pool.
--
-- Spec reference: ~/ecodiaos/drafts/cowork-deep-integration-architecture-2026-04-30.md
--   §7.4 (separate cap counters), §10.4 step 2.

ALTER TABLE os_forks ADD COLUMN IF NOT EXISTS parent TEXT DEFAULT 'conductor';
ALTER TABLE os_forks ADD COLUMN IF NOT EXISTS cowork_session_id TEXT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'os_forks_parent_check'
  ) THEN
    ALTER TABLE os_forks
      ADD CONSTRAINT os_forks_parent_check
      CHECK (parent IN ('conductor','cowork','tate','external'));
  END IF;
END$$;

CREATE INDEX IF NOT EXISTS os_forks_parent_idx ON os_forks(parent);
CREATE INDEX IF NOT EXISTS os_forks_cowork_session_idx ON os_forks(cowork_session_id) WHERE cowork_session_id IS NOT NULL;

COMMENT ON COLUMN os_forks.parent IS 'Pool that spawned the fork: conductor (HARD_FORK_CAP=5) | cowork (COWORK_FORK_CAP=3) | tate | external.';
COMMENT ON COLUMN os_forks.cowork_session_id IS 'When parent=cowork, ties the fork back to the Cowork session that spawned it.';
