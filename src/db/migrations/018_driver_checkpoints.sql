BEGIN;
ALTER TABLE routes ADD COLUMN checkpoint_revision INTEGER NOT NULL DEFAULT 0;
ALTER TABLE driver_sessions ADD COLUMN last_checkpoint_gps_at TIMESTAMPTZ;
ALTER TABLE stops ADD CONSTRAINT stops_checkpoint_identity UNIQUE(id,variant_id,route_id);
CREATE TABLE route_checkpoints (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  route_id UUID NOT NULL,
  variant_id UUID NOT NULL,
  transport_line_id UUID NOT NULL,
  stop_id UUID NOT NULL,
  target_minutes INTEGER NOT NULL CHECK(target_minutes BETWEEN 0 AND 1440),
  tolerance_minutes INTEGER NOT NULL DEFAULT 2 CHECK(tolerance_minutes BETWEEN 0 AND 30),
  radius_meters INTEGER NOT NULL DEFAULT 75 CHECK(radius_meters BETWEEN 30 AND 300),
  UNIQUE(variant_id,stop_id),
  FOREIGN KEY(route_id,transport_line_id) REFERENCES routes(id,transport_line_id),
  FOREIGN KEY(stop_id,variant_id,route_id) REFERENCES stops(id,variant_id,route_id)
);
CREATE INDEX route_checkpoints_route_idx ON route_checkpoints(route_id);
ALTER TABLE route_checkpoints ENABLE ROW LEVEL SECURITY;
GRANT SELECT,INSERT,UPDATE,DELETE ON route_checkpoints TO et_line_runtime;
CREATE POLICY checkpoints_read ON route_checkpoints FOR SELECT TO et_line_runtime USING(et_can_access_line(transport_line_id));
CREATE POLICY checkpoints_write ON route_checkpoints FOR ALL TO et_line_runtime USING(et_can_access_line(transport_line_id,true)) WITH CHECK(et_can_access_line(transport_line_id,true));

-- A snapshot is independent of later route/stop edits. Occurrences are per service leg.
CREATE TABLE driver_checkpoint_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id UUID NOT NULL REFERENCES driver_sessions(id) ON DELETE CASCADE,
  variant_id UUID NOT NULL,
  direction TEXT NOT NULL CHECK(direction IN ('ida','vuelta')),
  started_at TIMESTAMPTZ NOT NULL,
  ended_at TIMESTAMPTZ,
  plan_revision INTEGER NOT NULL,
  UNIQUE(id,session_id)
);
CREATE UNIQUE INDEX checkpoint_run_active ON driver_checkpoint_runs(session_id) WHERE ended_at IS NULL;
CREATE TABLE driver_checkins (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id UUID NOT NULL,
  session_id UUID NOT NULL,
  checkpoint_id UUID NOT NULL,
  sequence INTEGER NOT NULL CHECK(sequence>=0),
  name TEXT NOT NULL,
  latitude DOUBLE PRECISION NOT NULL CHECK(latitude BETWEEN -90 AND 90),
  longitude DOUBLE PRECISION NOT NULL CHECK(longitude BETWEEN -180 AND 180),
  progress_meters DOUBLE PRECISION NOT NULL CHECK(progress_meters>=0),
  radius_meters INTEGER NOT NULL CHECK(radius_meters BETWEEN 30 AND 300),
  tolerance_minutes INTEGER NOT NULL CHECK(tolerance_minutes BETWEEN 0 AND 30),
  expected_at TIMESTAMPTZ NOT NULL,
  arrived_at TIMESTAMPTZ,
  received_at TIMESTAMPTZ,
  gps_accuracy DOUBLE PRECISION,
  UNIQUE(run_id,sequence), UNIQUE(run_id,checkpoint_id),
  FOREIGN KEY(run_id,session_id) REFERENCES driver_checkpoint_runs(id,session_id) ON DELETE CASCADE,
  CHECK((arrived_at IS NULL AND received_at IS NULL AND gps_accuracy IS NULL) OR (arrived_at IS NOT NULL AND received_at IS NOT NULL AND gps_accuracy BETWEEN 0 AND 50))
);
CREATE INDEX driver_checkins_session_idx ON driver_checkins(session_id);
ALTER TABLE driver_checkpoint_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE driver_checkins ENABLE ROW LEVEL SECURITY;
GRANT SELECT ON driver_checkpoint_runs,driver_checkins TO et_line_runtime;
CREATE POLICY checkpoint_runs_read ON driver_checkpoint_runs FOR SELECT TO et_line_runtime USING(EXISTS(SELECT 1 FROM driver_sessions s WHERE s.id=session_id));
CREATE POLICY checkins_read ON driver_checkins FOR SELECT TO et_line_runtime USING(EXISTS(SELECT 1 FROM driver_sessions s WHERE s.id=session_id));
COMMIT;
