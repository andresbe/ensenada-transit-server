-- Persistent automatic direction evidence for Teltonika and Ruptela devices.
-- Additive only: assignments remain authoritative and are never rewritten here.
SET LOCAL lock_timeout = '5s';

CREATE TABLE device_direction_state (
  device_id UUID PRIMARY KEY REFERENCES tracking_devices(id) ON DELETE CASCADE,
  assignment_id UUID NOT NULL REFERENCES vehicle_device_assignments(id) ON DELETE CASCADE,
  route_id UUID NOT NULL REFERENCES routes(id) ON DELETE CASCADE,
  assigned_route_variant_id UUID NOT NULL,
  detected_route_variant_id UUID,
  candidate_route_variant_id UUID,
  consecutive_evidence_count SMALLINT NOT NULL DEFAULT 0 CHECK(consecutive_evidence_count >= 0),
  candidate_started_at TIMESTAMPTZ,
  candidate_last_evidence_at TIMESTAMPTZ,
  candidate_displacement_meters REAL NOT NULL DEFAULT 0 CHECK(candidate_displacement_meters >= 0),
  strong_evidence_count SMALLINT NOT NULL DEFAULT 0 CHECK(strong_evidence_count >= 0),
  terminal_evidence BOOLEAN NOT NULL DEFAULT false,
  last_confirmed_at TIMESTAMPTZ,
  last_observation_at TIMESTAMPTZ,
  motion_anchor_at TIMESTAMPTZ,
  motion_anchor_latitude NUMERIC(10,7) CHECK(motion_anchor_latitude BETWEEN -90 AND 90),
  motion_anchor_longitude NUMERIC(10,7) CHECK(motion_anchor_longitude BETWEEN -180 AND 180),
  motion_anchor_progress JSONB NOT NULL DEFAULT '{}',
  detection_confidence TEXT NOT NULL DEFAULT 'low' CHECK(detection_confidence IN ('low','medium','high')),
  geometry_fingerprint TEXT NOT NULL CHECK(geometry_fingerprint ~ '^[a-f0-9]{64}$'),
  last_reason TEXT NOT NULL CHECK(length(last_reason) BETWEEN 1 AND 80),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT device_direction_assigned_variant_fk
    FOREIGN KEY(assigned_route_variant_id,route_id) REFERENCES route_variants(id,route_id) ON DELETE CASCADE,
  CONSTRAINT device_direction_detected_variant_fk
    FOREIGN KEY(detected_route_variant_id,route_id) REFERENCES route_variants(id,route_id) ON DELETE CASCADE,
  CONSTRAINT device_direction_candidate_variant_fk
    FOREIGN KEY(candidate_route_variant_id,route_id) REFERENCES route_variants(id,route_id) ON DELETE CASCADE,
  CONSTRAINT device_direction_anchor_shape CHECK(
    num_nonnulls(motion_anchor_at,motion_anchor_latitude,motion_anchor_longitude) IN (0,3)
  )
);
CREATE INDEX device_direction_state_assignment_idx ON device_direction_state(assignment_id);
CREATE INDEX device_direction_state_route_idx ON device_direction_state(route_id,detected_route_variant_id);
CREATE INDEX device_direction_state_observation_idx ON device_direction_state(last_observation_at DESC);
CREATE TRIGGER trg_device_direction_state_updated_at
  BEFORE UPDATE ON device_direction_state FOR EACH ROW EXECUTE FUNCTION set_updated_at();

REVOKE ALL ON device_direction_state FROM PUBLIC,et_line_runtime;
ALTER TABLE device_direction_state ENABLE ROW LEVEL SECURITY;
COMMENT ON TABLE device_direction_state IS
  'Per-device ida/vuelta evidence. vehicle_device_assignments remains the authorization source of truth.';
