-- Extend the deployed 029/030 schema; never recreate its registries or location history.
SET LOCAL lock_timeout = '5s';

ALTER TABLE tracking_devices
  ADD COLUMN public_visible BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN revision INTEGER NOT NULL DEFAULT 1 CHECK(revision > 0),
  ADD COLUMN last_connected_at TIMESTAMPTZ,
  ADD COLUMN last_received_at TIMESTAMPTZ,
  ADD COLUMN last_valid_location_at TIMESTAMPTZ,
  ADD COLUMN last_published_at TIMESTAMPTZ;
ALTER TABLE vehicle_device_assignments ADD COLUMN route_variant_id UUID REFERENCES route_variants(id) ON DELETE RESTRICT;

-- Configuration/installation changes invalidate queued and cached fixes, including SQL-side changes.
CREATE FUNCTION et_tracker_configuration_revision() RETURNS TRIGGER AS $$
BEGIN
  NEW.revision := OLD.revision + 1;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER tracking_devices_configuration_revision
  BEFORE UPDATE OF status,model,firmware_version,public_visible ON tracking_devices
  FOR EACH ROW EXECUTE FUNCTION et_tracker_configuration_revision();
CREATE FUNCTION et_tracker_assignment_revision() RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP <> 'INSERT' THEN
    UPDATE tracking_devices SET revision=revision+1 WHERE id=OLD.device_id;
  END IF;
  IF TG_OP = 'INSERT' OR (TG_OP = 'UPDATE' AND NEW.device_id <> OLD.device_id) THEN
    UPDATE tracking_devices SET revision=revision+1 WHERE id=NEW.device_id;
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER vehicle_device_assignments_revision
  AFTER INSERT OR UPDATE OR DELETE ON vehicle_device_assignments
  FOR EACH ROW EXECUTE FUNCTION et_tracker_assignment_revision();

-- The existing location history doubles as a durable outbox; preexisting rows are not replayed.
ALTER TABLE vehicle_gps_locations
  ADD COLUMN assignment_id UUID REFERENCES vehicle_device_assignments(id) ON DELETE RESTRICT,
  ADD COLUMN device_revision INTEGER,
  ADD COLUMN telemetry JSONB,
  ADD COLUMN delivery_status TEXT NOT NULL DEFAULT 'skipped' CHECK(delivery_status IN ('pending','published','skipped')),
  ADD COLUMN delivery_reason TEXT,
  ADD COLUMN delivered_at TIMESTAMPTZ;
CREATE INDEX vehicle_gps_locations_pending_idx ON vehicle_gps_locations(device_id,recorded_at,id) WHERE delivery_status='pending';

-- Only CRC-valid AVL records that cannot fit 030's typed constraints go here. Never fake a coordinate.
CREATE TABLE tracking_device_rejections (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  device_id UUID NOT NULL REFERENCES tracking_devices(id) ON DELETE RESTRICT,
  event_key TEXT NOT NULL CHECK(length(event_key)=64),
  received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  reason TEXT NOT NULL,
  telemetry JSONB NOT NULL,
  UNIQUE(device_id,event_key)
);
CREATE INDEX tracking_device_rejections_time ON tracking_device_rejections(device_id,received_at DESC,id DESC);

-- Exact telemetry and IMEIs are platform-only; line dashboards can read scoped mapping columns.
REVOKE ALL ON tracking_devices,vehicle_device_assignments,vehicle_gps_locations,
  public_vehicle_gps_locations,tracking_device_rejections FROM PUBLIC,et_line_runtime;
ALTER TABLE tracking_devices ENABLE ROW LEVEL SECURITY;
ALTER TABLE vehicle_device_assignments ENABLE ROW LEVEL SECURITY;
GRANT SELECT(id,provider,status,revision) ON tracking_devices TO et_line_runtime;
GRANT SELECT(id,device_id,vehicle_id,route_variant_id,assigned_at,unassigned_at) ON vehicle_device_assignments TO et_line_runtime;
CREATE POLICY tracker_assignment_line_read ON vehicle_device_assignments FOR SELECT TO et_line_runtime
  USING(EXISTS(SELECT 1 FROM fleet_vehicles v WHERE v.id=vehicle_id AND et_can_access_line(v.transport_line_id)));
CREATE POLICY tracking_devices_line_read ON tracking_devices FOR SELECT TO et_line_runtime
  USING(EXISTS(SELECT 1 FROM vehicle_device_assignments a WHERE a.device_id=tracking_devices.id AND a.unassigned_at IS NULL));
