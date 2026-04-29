-- 067: status_board source + cowork_session_id columns
--
-- Part 1 of 3 for Cowork V2 MCP peerage substrate (W2-B,
-- fork_mokmorc8_24edea, 30 Apr 2026). Adds attribution columns so
-- conductor and Cowork writes can be distinguished post-hoc.
--
-- Spec reference: ~/ecodiaos/drafts/cowork-deep-integration-architecture-2026-04-30.md
--   §5.1 (auth model), §7.1 (status_board seam), §10.4 step 1.
-- Recon reference: ~/ecodiaos/drafts/cowork-mcp-v2-implementation-recon-2026-04-30.md
--   §4.9 (existing schema), §6 (numbering protocol).
--
-- Numbering: 067 was the next free integer when this fork branched main
-- (highest on disk was 066_staged_transactions_listener_trigger.sql).
-- Per ~/ecodiaos/patterns/parallel-forks-must-claim-numbered-resources-before-commit.md
-- the number was claimed BY OBSERVATION, not from the W2-A spec's advisory 071.

ALTER TABLE status_board ADD COLUMN IF NOT EXISTS source TEXT DEFAULT 'conductor';
ALTER TABLE status_board ADD COLUMN IF NOT EXISTS cowork_session_id TEXT;

CREATE INDEX IF NOT EXISTS status_board_source_idx ON status_board(source);
CREATE INDEX IF NOT EXISTS status_board_cowork_session_idx ON status_board(cowork_session_id) WHERE cowork_session_id IS NOT NULL;

COMMENT ON COLUMN status_board.source IS 'Writer identity: conductor | cowork | tate | external. Default conductor for backfill safety.';
COMMENT ON COLUMN status_board.cowork_session_id IS 'When source=cowork, joins this row to the originating Cowork session in cowork_sessions.';
