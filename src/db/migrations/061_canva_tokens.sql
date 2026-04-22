-- Canva Connect OAuth token storage
CREATE TABLE IF NOT EXISTS canva_tokens (
  id            SERIAL PRIMARY KEY,
  access_token  TEXT NOT NULL,
  refresh_token TEXT NOT NULL,
  expires_at    TIMESTAMPTZ NOT NULL,
  scope         TEXT,
  canva_user_id   TEXT,
  canva_user_email TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_canva_tokens_expires_at ON canva_tokens(expires_at);
