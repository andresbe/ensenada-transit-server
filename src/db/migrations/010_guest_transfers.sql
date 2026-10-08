BEGIN;
CREATE TABLE IF NOT EXISTS guest_account_transfers (
  guest_id UUID PRIMARY KEY REFERENCES users(id), account_id UUID NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), CHECK(guest_id<>account_id)
);
COMMIT;
