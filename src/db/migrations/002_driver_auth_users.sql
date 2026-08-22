-- ============================================================
-- Ensenada Transit - driver auth user columns
-- ============================================================
-- Incremental migration for existing databases that already have
-- the base Ensenada Transit tables.

ALTER TABLE users ADD COLUMN IF NOT EXISTS role TEXT NOT NULL DEFAULT 'user';
ALTER TABLE users ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'active';
ALTER TABLE users ADD COLUMN IF NOT EXISTS assigned_bus_id TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS assigned_route_id TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS assigned_route_variant_id TEXT;

CREATE INDEX IF NOT EXISTS idx_users_role ON users (role);
CREATE INDEX IF NOT EXISTS idx_users_status ON users (status);
CREATE INDEX IF NOT EXISTS idx_users_assigned_bus_id ON users (assigned_bus_id);
CREATE INDEX IF NOT EXISTS idx_users_assigned_route_id ON users (assigned_route_id);
CREATE INDEX IF NOT EXISTS idx_users_assigned_route_variant_id ON users (assigned_route_variant_id);
