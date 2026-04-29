-- 069: outcome_event classification (Phase D / Layer 5)
--
-- Phase D of the Decision Quality Self-Optimization Architecture. See:
--   ~/ecodiaos/patterns/decision-quality-self-optimization-architecture.md
--
-- Adds classification metadata to outcome_event rows so a 'correction'
-- outcome can be routed to the right remediation:
--   usage_failure      - relevant pattern surfaced and was tagged [APPLIED],
--                        but the outcome was still a correction. Doctrine
--                        was right, application was wrong (or doctrine
--                        incomplete). Refine the pattern.
--   surfacing_failure  - relevant pattern existed but did NOT surface (no
--                        surface_event row). Tighten triggers OR add canonical.
--   doctrine_failure   - no relevant pattern existed in the corpus. Author
--                        a new pattern.
--
-- Columns:
--   classification              - auto-classifier output. NULL until classified.
--   classification_evidence     - jsonb with top-K semantic results, applied
--                                 tags, similarity scores, and any tate_note.
--   classification_tate_tagged  - manual override via POST /api/telemetry/outcome/:id/classify
--   classification_at           - timestamp the auto-classifier wrote the row.
--
-- Indexes:
--   idx_outcome_event_unclassified - drives the classifier worklist (corrections
--                                    awaiting classification, oldest first).
--   idx_outcome_event_classification - drives panel queries grouping by classification.

ALTER TABLE outcome_event
  ADD COLUMN IF NOT EXISTS classification             text,
  ADD COLUMN IF NOT EXISTS classification_evidence    jsonb,
  ADD COLUMN IF NOT EXISTS classification_tate_tagged text,
  ADD COLUMN IF NOT EXISTS classification_at          timestamptz;

CREATE INDEX IF NOT EXISTS idx_outcome_event_unclassified
  ON outcome_event (ts)
  WHERE outcome = 'correction' AND classification IS NULL;

CREATE INDEX IF NOT EXISTS idx_outcome_event_classification
  ON outcome_event (classification)
  WHERE classification IS NOT NULL;
