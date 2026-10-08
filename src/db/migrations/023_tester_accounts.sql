BEGIN;
ALTER TABLE users ADD COLUMN is_tester BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE passenger_boardings ADD COLUMN is_test BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE passenger_boardings ADD COLUMN test_bus_id TEXT;
ALTER TABLE passenger_boardings ALTER COLUMN vehicle_id DROP NOT NULL;
ALTER TABLE passenger_boardings ALTER COLUMN driver_session_id DROP NOT NULL;
ALTER TABLE passenger_boardings ADD CONSTRAINT boarding_real_vehicle_required CHECK
  ((is_test AND test_bus_id IS NOT NULL) OR (NOT is_test AND vehicle_id IS NOT NULL AND driver_session_id IS NOT NULL));
CREATE TABLE tester_account_changes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  admin_id UUID NOT NULL REFERENCES admins(id),
  enabled BOOLEAN NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX tester_account_changes_user_date ON tester_account_changes(user_id,created_at DESC);
REVOKE ALL ON tester_account_changes FROM PUBLIC;
COMMIT;
