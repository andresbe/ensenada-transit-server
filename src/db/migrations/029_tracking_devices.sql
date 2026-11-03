-- Teltonika FTC927 support, part 1: devices, vehicle assignment history, test-vehicle flag.
-- Additive only: no existing table is dropped or rewritten.
-- Runs inside the runner's transaction: fail fast instead of queueing behind live traffic.
SET LOCAL lock_timeout = '5s';

-- Existing vehicle entity is fleet_vehicles (012). Default FALSE keeps every current vehicle public.
ALTER TABLE fleet_vehicles ADD COLUMN IF NOT EXISTS is_test_vehicle BOOLEAN NOT NULL DEFAULT FALSE;
CREATE INDEX IF NOT EXISTS fleet_vehicles_test_idx ON fleet_vehicles(id) WHERE is_test_vehicle;

CREATE TABLE tracking_devices (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  imei             TEXT NOT NULL CHECK (imei ~ '^[0-9]{15}$'),
  provider         TEXT NOT NULL DEFAULT 'TELTONIKA' CHECK (length(btrim(provider)) BETWEEN 1 AND 40),
  model            TEXT CHECK (model IS NULL OR length(btrim(model)) BETWEEN 1 AND 60),
  firmware_version TEXT CHECK (firmware_version IS NULL OR length(btrim(firmware_version)) BETWEEN 1 AND 60),
  status           TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive','retired')),
  last_seen_at     TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT tracking_devices_imei_unique UNIQUE (imei)
);
CREATE INDEX tracking_devices_status_idx ON tracking_devices(status);
CREATE INDEX tracking_devices_last_seen_idx ON tracking_devices(last_seen_at);
CREATE TRIGGER trg_tracking_devices_updated_at
  BEFORE UPDATE ON tracking_devices FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- One row per period a device is installed in a vehicle. Moving a device closes the
-- open row (unassigned_at) and opens a new one; rows are never deleted (history).
CREATE TABLE vehicle_device_assignments (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  device_id     UUID NOT NULL REFERENCES tracking_devices(id) ON DELETE RESTRICT,
  vehicle_id    UUID NOT NULL REFERENCES fleet_vehicles(id) ON DELETE RESTRICT,
  assigned_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  unassigned_at TIMESTAMPTZ,
  assigned_by   UUID REFERENCES admins(id),
  notes         TEXT CHECK (notes IS NULL OR length(notes) <= 500),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT vehicle_device_assignments_period_check CHECK (unassigned_at IS NULL OR unassigned_at >= assigned_at)
);
-- At most one open assignment per device and per vehicle.
CREATE UNIQUE INDEX vehicle_device_assignments_active_device ON vehicle_device_assignments(device_id) WHERE unassigned_at IS NULL;
CREATE UNIQUE INDEX vehicle_device_assignments_active_vehicle ON vehicle_device_assignments(vehicle_id) WHERE unassigned_at IS NULL;
CREATE INDEX vehicle_device_assignments_device_idx ON vehicle_device_assignments(device_id, assigned_at DESC);
CREATE INDEX vehicle_device_assignments_vehicle_idx ON vehicle_device_assignments(vehicle_id, assigned_at DESC);
