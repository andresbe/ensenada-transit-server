-- ============================================================
-- Ensenada Transit - revert users driver assignment columns
-- ============================================================
-- Returns users to the shared identity model with role/status only.

ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_status_check;

DROP INDEX IF EXISTS idx_users_assigned_bus_id;
DROP INDEX IF EXISTS idx_users_assigned_route_id;
DROP INDEX IF EXISTS idx_users_assigned_route_variant_id;

ALTER TABLE users DROP COLUMN IF EXISTS assigned_bus_id;
ALTER TABLE users DROP COLUMN IF EXISTS assigned_route_id;
ALTER TABLE users DROP COLUMN IF EXISTS assigned_route_variant_id;
