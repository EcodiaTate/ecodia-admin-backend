-- migrations/049_session_memory.sql
-- Rich persistent memory for OS Session conversations.
--
-- The CC CLI writes full JSONL transcripts to ~/.claude/projects/<project>/
-- This table stores extracted, embedded chunks of those conversations so the OS
-- can semantically search its own past reasoning across session resets.

CREATE TABLE IF NOT EXISTS session_memory_chunks (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- The CC CLI session UUID (from the JSONL filename, not our internal session id)
  cc_session_id   TEXT NOT NULL,
  -- Our internal cc_sessions.id, if mappable
  db_session_id   UUID,
  -- Source project path (e.g. '-home-tate-ecodiaos', 'd---code')
  project_key     TEXT NOT NULL DEFAULT 'os_session',
  -- What kind of content this chunk represents
  chunk_type      TEXT NOT NULL DEFAULT 'exchange',  -- 'exchange' | 'decision' | 'summary'
  -- The actual text content (user message + assistant response, or extracted key reasoning)
  content         TEXT NOT NULL,
  -- Rough character count for quick filtering
  content_length  INTEGER GENERATED ALWAYS AS (length(content)) STORED,
  -- Token turn index within the session for ordering
  turn_index      INTEGER NOT NULL DEFAULT 0,
  -- Timestamps extracted from the JSONL (when this exchange happened)
  exchange_ts     TIMESTAMPTZ,
  -- When we processed/ingested this chunk
  created_at      TIMESTAMPTZ DEFAULT now(),
  -- pgvector embedding (1536 dims = OpenAI text-embedding-3-small)
  embedding       vector(1536)
);

-- Prevent double-ingestion of the same session
CREATE UNIQUE INDEX IF NOT EXISTS session_memory_chunks_session_turn_idx
  ON session_memory_chunks (cc_session_id, turn_index);

-- Fast lookup by project + recency
CREATE INDEX IF NOT EXISTS session_memory_chunks_project_ts_idx
  ON session_memory_chunks (project_key, exchange_ts DESC NULLS LAST);

-- Vector similarity search
CREATE INDEX IF NOT EXISTS session_memory_chunks_embedding_idx
  ON session_memory_chunks USING hnsw (embedding vector_cosine_ops);

-- Track which JSONL files have been ingested (by file mtime) to skip unchanged files
CREATE TABLE IF NOT EXISTS session_memory_ingested (
  project_key     TEXT NOT NULL,
  cc_session_id   TEXT NOT NULL,
  file_mtime_ms   BIGINT NOT NULL,    -- last-modified epoch ms at ingest time
  chunk_count     INTEGER NOT NULL DEFAULT 0,
  ingested_at     TIMESTAMPTZ DEFAULT now(),
  PRIMARY KEY (project_key, cc_session_id)
);
