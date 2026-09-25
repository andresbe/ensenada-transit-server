-- Administrators are independent identities; no accounts or passwords are seeded.
CREATE TABLE IF NOT EXISTS admins (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email TEXT NOT NULL UNIQUE CHECK (email = lower(btrim(email)) AND email <> ''),
  password_hash TEXT NOT NULL CHECK (password_hash ~ '^\$2[aby]\$[0-9]{2}\$[./A-Za-z0-9]{53}$'),
  display_name TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended', 'deleted')),
  token_version INTEGER NOT NULL DEFAULT 1 CHECK (token_version > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE OR REPLACE FUNCTION update_admin_auth_state()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  IF NEW.password_hash IS DISTINCT FROM OLD.password_hash
     OR NEW.status IS DISTINCT FROM OLD.status THEN
    NEW.token_version = OLD.token_version + 1;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_admins_auth_state ON admins;
CREATE TRIGGER trg_admins_auth_state
  BEFORE UPDATE ON admins
  FOR EACH ROW EXECUTE FUNCTION update_admin_auth_state();
