-- Teltonika FTC927 support, part 2: persistent GPS history.
-- No SQL location table exists today (live positions are in Redis, driver_sessions.last_location is
-- a single JSONB snapshot), so a new append-only table is required. Android and Teltonika share it.

SET LOCAL lock_timeout = '5s';

CREATE TABLE vehicle_gps_locations (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  source      TEXT NOT NULL CHECK (source IN ('ANDROID','TELTONIKA')),
  device_id   UUID REFERENCES tracking_devices(id) ON DELETE RESTRICT,
  vehicle_id  UUID REFERENCES fleet_vehicles(id) ON DELETE RESTRICT,
  latitude    NUMERIC(10,7) NOT NULL CHECK (latitude BETWEEN -90 AND 90),
  longitude   NUMERIC(10,7) NOT NULL CHECK (longitude BETWEEN -180 AND 180),
  speed_mps   REAL CHECK (speed_mps IS NULL OR (speed_mps >= 0 AND speed_mps < 100)),
  heading     REAL CHECK (heading IS NULL OR (heading >= 0 AND heading < 360)),
  satellites  SMALLINT CHECK (satellites IS NULL OR satellites BETWEEN 0 AND 99),
  recorded_at TIMESTAMPTZ NOT NULL,
  received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  is_valid    BOOLEAN NOT NULL DEFAULT TRUE,
  -- Disambiguates distinct AVL records that share a timestamp (e.g. an event record and a periodic
  -- record at the same second). Ingester sets it (Teltonika: event IO id, or a hash of the raw record).
  -- Default '' keeps plain (device_id, recorded_at) dedup when the ingester sends nothing.
  event_key   TEXT NOT NULL DEFAULT '' CHECK (length(event_key) <= 64),
  -- Teltonika rows come from a device; Android rows come from a driver session on a vehicle.
  CONSTRAINT vehicle_gps_locations_source_shape_check CHECK (
    (source = 'TELTONIKA' AND device_id IS NOT NULL)
    OR (source = 'ANDROID' AND device_id IS NULL AND vehicle_id IS NOT NULL))
);

-- Deduplication for retries / re-sent AVL records: the same record re-sent has the same
-- (device_id, recorded_at, event_key). Use INSERT ... ON CONFLICT DO NOTHING (no conflict target).
CREATE UNIQUE INDEX vehicle_gps_locations_device_dedup ON vehicle_gps_locations(device_id, recorded_at, event_key)
  WHERE device_id IS NOT NULL;
CREATE UNIQUE INDEX vehicle_gps_locations_android_dedup ON vehicle_gps_locations(vehicle_id, recorded_at)
  WHERE source = 'ANDROID';

-- Latest position / history per vehicle and per device.
CREATE INDEX vehicle_gps_locations_vehicle_time ON vehicle_gps_locations(vehicle_id, recorded_at DESC) WHERE vehicle_id IS NOT NULL;
CREATE INDEX vehicle_gps_locations_device_time ON vehicle_gps_locations(device_id, recorded_at DESC) WHERE device_id IS NOT NULL;
-- Retention sweeps and time-range scans.
CREATE INDEX vehicle_gps_locations_recorded_brin ON vehicle_gps_locations USING brin(recorded_at);

-- Keep tracking_devices.last_seen_at current (monotonic, so late/out-of-order records don't rewind it).
CREATE FUNCTION et_touch_device_last_seen() RETURNS TRIGGER AS $$
BEGIN
  IF NEW.device_id IS NOT NULL THEN
    UPDATE tracking_devices SET last_seen_at = GREATEST(COALESCE(last_seen_at, NEW.received_at), NEW.received_at)
    WHERE id = NEW.device_id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER vehicle_gps_locations_touch_device
  AFTER INSERT ON vehicle_gps_locations FOR EACH ROW EXECUTE FUNCTION et_touch_device_last_seen();

-- Helper for public reads. It is NOT wired into any endpoint yet.
CREATE VIEW public_vehicle_gps_locations AS
  SELECT l.* FROM vehicle_gps_locations l
  JOIN fleet_vehicles v ON v.id = l.vehicle_id
  WHERE l.is_valid AND NOT v.is_test_vehicle AND v.archived_at IS NULL;
COMMENT ON VIEW public_vehicle_gps_locations IS
  'Filtering helper only. Does NOT protect public endpoints by itself: endpoints must query it (and filter is_test_vehicle on the Redis/live path) - see docs/gps-tracking-schema.md.';
COMMENT ON TABLE vehicle_gps_locations IS
  'Append-only GPS history. No automatic retention yet; see docs/gps-tracking-schema.md.';
