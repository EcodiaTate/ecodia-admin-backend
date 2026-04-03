-- ═══════════════════════════════════════════════════════════════════════
-- 024: Factory Learning Evolution
--
-- Upgrades the factory_learnings system for exponential improvement:
-- 1. Embedding column for semantic dedup + semantic matching
-- 2. Merge tracking (absorbed_into, merged_from) for consolidation
-- 3. Promotion tracking (promoted_to_spec_at) for spec promotion
-- ═══════════════════════════════════════════════════════════════════════

-- Embedding for semantic similarity search on learnings
ALTER TABLE factory_learnings ADD COLUMN IF NOT EXISTS embedding vector(1536);

-- When a learning is absorbed into another (dedup/merge), point to the survivor
ALTER TABLE factory_learnings ADD COLUMN IF NOT EXISTS absorbed_into UUID REFERENCES factory_learnings(id);

-- Track which learnings were merged into this one
ALTER TABLE factory_learnings ADD COLUMN IF NOT EXISTS merged_from UUID[] DEFAULT '{}';

-- When a learning is promoted to a spec/CLAUDE.md file
ALTER TABLE factory_learnings ADD COLUMN IF NOT EXISTS promoted_to_spec_at TIMESTAMPTZ;

-- Vector index for semantic search on learnings.
-- Use HNSW instead of IVFFlat: IVFFlat requires the table to already have
-- enough rows to fill its lists parameter, so it fails on empty/small tables.
-- HNSW builds incrementally and works from zero rows.
CREATE INDEX IF NOT EXISTS idx_factory_learnings_embedding ON factory_learnings
  USING hnsw (embedding vector_cosine_ops);

-- Filter out absorbed learnings in queries
CREATE INDEX IF NOT EXISTS idx_factory_learnings_active ON factory_learnings(codebase_id)
  WHERE absorbed_into IS NULL;
