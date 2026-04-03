-- ═══════════════════════════════════════════════════════════════════════
-- 023: Factory Oversight Hardening
--
-- 1. factory_dispatch_log — DB-persisted rate limiting (survives PM2 restarts)
-- 2. factory_learnings.evidence — add index for keyword-based matching
-- ═══════════════════════════════════════════════════════════════════════

-- Dispatch rate-limit log: authoritative sliding-window source
CREATE TABLE IF NOT EXISTS factory_dispatch_log (
  id BIGSERIAL PRIMARY KEY,
  dispatch_type TEXT NOT NULL,
  session_id UUID REFERENCES cc_sessions(id),
  metadata JSONB DEFAULT '{}',
  dispatched_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_dispatch_log_type_time ON factory_dispatch_log(dispatch_type, dispatched_at DESC);

-- GIN index on factory_learnings.evidence for keyword matching
CREATE INDEX IF NOT EXISTS idx_factory_learnings_evidence ON factory_learnings USING GIN (evidence jsonb_path_ops);
