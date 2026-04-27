-- Fork-mode parallelism (Build 1, EcodiaOS_Spec_NextBuild §1).
-- One row per spawned fork. The in-memory Map<fork_id, ForkState> in
-- forkService.js is the runtime source of truth; this table is persistence
-- for visibility, post-hoc analysis, and survival-across-restart attribution.
-- It is NOT used to resume a dead fork — forks that die with the process
-- are lost work (per spec §1.7: "forks don't checkpoint").

CREATE TABLE IF NOT EXISTS os_forks (
  fork_id           text PRIMARY KEY,
  parent_id         text NOT NULL DEFAULT 'main',
  brief             text NOT NULL,
  context_mode      text NOT NULL DEFAULT 'recent' CHECK (context_mode IN ('recent', 'brief')),
  status            text NOT NULL DEFAULT 'spawning' CHECK (status IN ('spawning', 'running', 'reporting', 'done', 'aborted', 'error')),
  position          text,                                 -- one-line current status (latest assistant text head, or last tool name)
  result            text,                                 -- filled when status='done': the [FORK_REPORT] body
  next_step         text,                                 -- filled when fork wants main to act: parsed from report
  abort_reason      text,
  provider          text,                                 -- claude_max | claude_max_2 | bedrock — whichever the fork ran on
  cc_session_id     text,                                 -- SDK session id, populated on system.init
  tokens_input      bigint NOT NULL DEFAULT 0,
  tokens_output     bigint NOT NULL DEFAULT 0,
  tool_calls        int NOT NULL DEFAULT 0,
  current_tool      text,                                 -- last-seen in-flight tool name (cleared on tool_result)
  last_heartbeat    timestamptz NOT NULL DEFAULT now(),   -- bumped on every SDK message
  started_at        timestamptz NOT NULL DEFAULT now(),
  ended_at          timestamptz
);

CREATE INDEX IF NOT EXISTS idx_os_forks_active
  ON os_forks (started_at DESC)
  WHERE status IN ('spawning', 'running', 'reporting');

CREATE INDEX IF NOT EXISTS idx_os_forks_recent
  ON os_forks (started_at DESC);

COMMENT ON TABLE os_forks IS 'Fork-mode registry. Each row = one parallel OS sub-session. Conductor sees a rolled-up positions table, not the raw transcripts.';
