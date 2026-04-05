-- Add source_account to staged_transactions
-- Tracks which GL account the money came from/to.
-- '1000' = company bank (default), '2100' = personal bank (director loan)
ALTER TABLE staged_transactions ADD COLUMN IF NOT EXISTS source_account TEXT DEFAULT '1000';
