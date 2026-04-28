-- 065: invoice_payment_matches table
--
-- Stores heuristic matches between incoming bank payments (staged_transactions)
-- and open invoices (kv_store key 'invoices.open').
--
-- Populated by the invoicePaymentState listener when a staged_transactions
-- INSERT event matches an open invoice with high or medium confidence.
--
-- Unique constraint on (invoice_number, staged_transaction_id) ensures the
-- listener is idempotent — duplicate events produce no duplicate rows.

CREATE TABLE IF NOT EXISTS invoice_payment_matches (
  id                     UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_number         TEXT        NOT NULL,
  staged_transaction_id  UUID        NOT NULL REFERENCES staged_transactions(id),
  confidence             TEXT        NOT NULL CHECK (confidence IN ('high', 'medium', 'low')),
  matched_amount_cents   BIGINT      NOT NULL,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (invoice_number, staged_transaction_id)
);

CREATE INDEX IF NOT EXISTS idx_ipm_invoice_number ON invoice_payment_matches(invoice_number);
CREATE INDEX IF NOT EXISTS idx_ipm_staged_tx      ON invoice_payment_matches(staged_transaction_id);
CREATE INDEX IF NOT EXISTS idx_ipm_created_at     ON invoice_payment_matches(created_at DESC);
