-- 033: Cortex Conversation Context Persistence
--
-- A single-row snapshot of the current conversation state.
-- Loaded when Tate opens the interface so the Cortex has continuity
-- across sessions: what was being discussed, what's in progress,
-- what needs attention, and where focus was.

CREATE TABLE IF NOT EXISTS cortex_context (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  last_topic            TEXT,
  ongoing_work          JSONB DEFAULT '[]'::jsonb,
  pending_actions       JSONB DEFAULT '[]'::jsonb,
  current_focus         TEXT,
  human_last_message    TEXT,
  cortex_last_response  TEXT,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_cortex_context_updated ON cortex_context(updated_at DESC);
